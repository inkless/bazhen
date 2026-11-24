//! Agents' tokens (`auth/callers.ts`'s `AgentTokens`): a new one for each start, the agent a
//! token names, and the start-up sweep of the token files no agent will run on again. The store
//! keeps only each token's hash; the token is in a 0600 file, in a 0700 directory, that the
//! agent's environment names. A file rather than a value: an environment value reaches the
//! runtime on its command line, which every user of the machine can read. Each start's file has
//! a name of its own, so a process left from an earlier start, which still names its own file,
//! never reads a later token.

use std::io::Write as _;
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use bazhen_protocol::ids::AgentId;
use bazhen_store::Reads;
use sha2::{Digest as _, Sha256};

use crate::devices::token_of;
use crate::pairing::random_bytes;
use crate::private_dir::{UnsafePrivateDir, ensure_private_dir};
use crate::writer::Writer;

/// A token as the daemon mints it: 32 bytes, base64url. Anything else is never one.
fn is_token(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The hash the store keeps of `token`: its SHA-256, in lowercase hex.
pub(crate) fn hash_of(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut hex, b| {
            hex.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
            hex.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
            hex
        })
}

/// The live agent `token` is the current token of.
///
/// # Errors
///
/// `SQLite`'s.
pub(crate) fn agent_of(reads: Reads<'_>, token: &str) -> rusqlite::Result<Option<AgentId>> {
    if !is_token(token) {
        return Ok(None);
    }
    let agent = reads.agent_by_token_hash(&hash_of(token))?;
    Ok(agent.as_deref().and_then(AgentId::parse))
}

/// A token file's agent, and whether a mint left it half written (`.tmp`): its name is the agent,
/// a start's own part, and `.token`.
fn token_file(name: &str) -> Option<(&str, bool)> {
    let (name, half_written) = match name.strip_suffix(".tmp") {
        Some(name) => (name, true),
        None => (name, false),
    };
    let (agent, start) = name.strip_suffix(".token")?.split_once('.')?;
    let hex = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    (agent.strip_prefix("agent_").is_some_and(hex) && hex(start)).then_some((agent, half_written))
}

/// Why no token could be minted for a start.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MintError {
    #[error(transparent)]
    Unsafe(#[from] UnsafePrivateDir),
    #[error("the token file {path} is unsafe: {reason}")]
    UnsafeFile { path: String, reason: String },
    #[error("no token file can be written: {0}")]
    Io(#[from] std::io::Error),
    #[error("the token's hash can't be kept: {0}")]
    Store(String),
}

/// Agents' token files, in `dir`, which is kept private to `uid`, and the hashes the store keeps.
#[derive(Debug, Clone)]
pub(crate) struct AgentTokens {
    dir: PathBuf,
    uid: u32,
    store: Writer,
}

/// A token minted for one start of an agent, until the start goes ahead or is refused.
#[derive(Debug)]
#[must_use = "a start's token is kept once it goes ahead, or abandoned once it is refused"]
pub(crate) struct Minted {
    tokens: AgentTokens,
    agent: AgentId,
    /// The file the start's process reads its token from.
    pub(crate) file: PathBuf,
    /// The hash the agent's token had before, which a refused start gives back.
    previous: Option<String>,
}

impl AgentTokens {
    pub(crate) fn new(dir: PathBuf, uid: u32, store: Writer) -> Self {
        Self { dir, uid, store }
    }

    /// A new token for `agent`'s next start, in a file of the start's own, which takes the place
    /// of the last at once: the new process may call before its start returns.
    ///
    /// # Errors
    ///
    /// A directory that can't be made private, a file that can't be written, or one that isn't,
    /// once written, a regular file of the daemon user's that only it can read; or the store's.
    pub(crate) async fn mint(&self, agent: &AgentId) -> Result<Minted, MintError> {
        let (file, hash) = write_token(&self.dir, self.uid, agent)?;
        let id = agent.as_str().to_owned();
        let previous = self
            .store
            .run(move |store| {
                store.write(|w| {
                    let previous = w.reads().agent_token_hash(&id)?;
                    w.note_agent_token(&id, &hash)?;
                    Ok::<_, rusqlite::Error>(previous)
                })
            })
            .await;
        let previous = stored(previous).map_err(MintError::Store)?;
        Ok(Minted {
            tokens: self.clone(),
            agent: agent.clone(),
            file,
            previous,
        })
    }
}

impl Minted {
    /// The start went ahead: the agent's bare id no longer names it, and no process of an
    /// earlier start runs to read its own file.
    pub(crate) async fn kept(self) {
        let id = self.agent.as_str().to_owned();
        let kept = self
            .tokens
            .store
            .run(move |store| store.write(|w| w.kept_agent_token(&id)))
            .await;
        if let Err(err) = stored(kept) {
            tracing::warn!(
                "bazhen: can't note that agent {}'s start kept its token: {err}",
                self.agent
            );
        }
        remove_others(&self.tokens.dir, &self.agent, &self.file);
    }

    /// The start was refused: the agent's running process, if it has one, has its token back. An
    /// agent that had none keeps the one minted, whose file is gone: no process holds it, and its
    /// bare id still names it.
    pub(crate) async fn abandoned(self) {
        if let Some(previous) = self.previous {
            let id = self.agent.as_str().to_owned();
            let restored = self
                .tokens
                .store
                .run(move |store| store.write(|w| w.note_agent_token(&id, &previous)))
                .await;
            if let Err(err) = stored(restored) {
                tracing::warn!(
                    "bazhen: can't give agent {} its token back: {err}",
                    self.agent
                );
            }
        }
        remove(&self.file);
    }
}

/// What a store job answered, or why it didn't run or failed, in words.
fn stored<T>(job: Result<rusqlite::Result<T>, crate::writer::Closed>) -> Result<T, String> {
    job.map_err(|closed| closed.to_string())?
        .map_err(|err| err.to_string())
}

/// Writes a new token for `agent` in a file of its own in `dir`, made private to `uid` first:
/// the file, and the token's hash.
fn write_token(dir: &Path, uid: u32, agent: &AgentId) -> Result<(PathBuf, String), MintError> {
    ensure_private_dir(dir, uid)?;
    let token = token_of(random_bytes()?);
    let start = random_bytes::<8>()?
        .iter()
        .fold(String::with_capacity(16), |mut hex, b| {
            hex.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
            hex.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
            hex
        });
    let path = dir.join(format!("{}.{start}.token", agent.as_str()));
    let next = dir.join(format!("{}.{start}.token.tmp", agent.as_str()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&next)?;
    file.write_all(token.as_bytes())?;
    // The umask may have taken bits the owner needs; nobody else may have any.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    drop(file);
    std::fs::rename(&next, &path)?;
    let refuse = |reason: String| MintError::UnsafeFile {
        path: path.display().to_string(),
        reason,
    };
    let found = std::fs::symlink_metadata(&path)?;
    if !found.is_file() {
        return Err(refuse("it isn't a regular file".to_owned()));
    }
    if found.uid() != uid {
        return Err(refuse(format!("it is owned by uid {}", found.uid())));
    }
    let mode = found.mode() & 0o777;
    if mode != 0o600 {
        return Err(refuse(format!("its mode is {mode:o}")));
    }
    Ok((path, hash_of(&token)))
}

/// Removes `agent`'s token files in `dir` but `kept`, once a start went ahead on `kept`: no
/// process of an earlier start runs any more, so none reads its own.
pub(crate) fn remove_others(dir: &Path, agent: &AgentId, kept: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let theirs = name
            .to_str()
            .and_then(token_file)
            .is_some_and(|(of, half_written)| of == agent.as_str() && !half_written);
        let path = dir.join(&name);
        if theirs && path != kept {
            remove(&path);
        }
    }
}

/// Removes the token file at `path`; one that can't be removed is left, said once, since its
/// token no longer names an agent.
pub(crate) fn remove(path: &Path) {
    if let Err(err) = std::fs::remove_file(path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(
            "bazhen: can't remove the agent token file {}: {err}",
            path.display()
        );
    }
}

/// Why the sweep couldn't run.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ForgetError {
    #[error(transparent)]
    Unsafe(#[from] UnsafePrivateDir),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Removes the token files in `dir` of agents that have ended, or that the store doesn't know, and
/// any a mint left half written: an agent closed while the daemon was down left its file behind.
/// Nothing but a token file is touched, and one that can't be removed is left, said once: its
/// token no longer names an agent.
///
/// # Errors
///
/// A `dir` that can't be made private, or `SQLite`'s.
pub(crate) fn forget_ended(dir: &Path, uid: u32, reads: Reads<'_>) -> Result<(), ForgetError> {
    ensure_private_dir(dir, uid)?;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some((agent, half_written)) = name.to_str().and_then(token_file) else {
            continue;
        };
        let state = reads.agent_state(agent)?;
        let ended = state
            .as_deref()
            .is_none_or(|s| s == "closed" || s == "failed");
        if half_written || ended {
            remove(&dir.join(&name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use bazhen_store::Store;

    use super::*;
    use crate::testing::TempDir;

    const LIVE: &str = "agent_0190a1b2c3d47abc8def0123456789ab";
    const CLOSED: &str = "agent_0190a1b2c3d47abc8def0123456789ac";
    const UNKNOWN: &str = "agent_0190a1b2c3d47abc8def0123456789ad";
    const TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    /// A store holding a live agent on `TOKEN` and a closed one on another.
    fn store(dir: &Path) -> Store {
        let path = dir.join("bazhen.db");
        let store = Store::open(&path).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(&format!(
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
               SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
             INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);
             INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
               token_hash, created_event_id, updated_event_id) VALUES
               ('{LIVE}', 'env_local', 'claude-code', 'p', '/', 'running', '{}', 1, 1),
               ('{CLOSED}', 'env_local', 'claude-code', 'p', '/', 'closed', '{}', 1, 1);",
            hash_of(TOKEN),
            hash_of(&TOKEN.replace('A', "B")),
        ))
        .unwrap();
        store
    }

    #[test]
    fn hashes_a_token_as_the_typescript_daemon_does() {
        assert_eq!(
            hash_of(TOKEN),
            "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a"
        );
    }

    #[test]
    fn knows_a_live_agent_by_its_token_and_none_by_an_ended_ones_or_a_malformed_one() {
        let dir = TempDir::new("agent-of");
        let store = store(dir.path());
        let of = |token: &str| {
            agent_of(store.reads(), token)
                .unwrap()
                .map(|id| id.as_str().to_owned())
        };
        assert_eq!(of(TOKEN), Some(LIVE.to_owned()));
        for token in [
            TOKEN.replace('A', "B"),
            TOKEN.replace('A', "C"),
            format!("{TOKEN}A"),
            TOKEN.replacen('A', "", 1),
            format!("{}+", TOKEN.replacen('A', "", 1)),
            String::new(),
        ] {
            assert_eq!(of(&token), None, "{token:?}");
        }
    }

    #[test]
    fn sweeps_the_files_of_agents_that_ended_or_that_it_doesnt_know_and_nothing_else() {
        let dir = TempDir::new("sweep");
        let store = store(dir.path());
        let tokens = dir.path().join("agents");
        std::fs::create_dir(&tokens).unwrap();
        let kept = [
            format!("{LIVE}.0a.token"),
            format!("{LIVE}.token"),
            format!("{UNKNOWN}.0a.token.old"),
            format!("{UNKNOWN}.0A.token"),
            "notes".to_owned(),
        ];
        let swept = [
            format!("{LIVE}.0b.token.tmp"),
            format!("{CLOSED}.0c.token"),
            format!("{UNKNOWN}.0d.token"),
        ];
        for name in kept.iter().chain(&swept) {
            std::fs::write(tokens.join(name), "x").unwrap();
        }
        forget_ended(&tokens, rustix::process::getuid().as_raw(), store.reads()).unwrap();
        let mut left: Vec<String> = std::fs::read_dir(&tokens)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        let mut expected = kept.to_vec();
        expected.sort();
        assert_eq!(left, expected);
    }

    #[test]
    fn makes_the_token_directory_private_and_refuses_one_it_cant() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new("sweep-dir");
        let store = store(dir.path());
        let tokens = dir.path().join("run/agents");
        forget_ended(&tokens, rustix::process::getuid().as_raw(), store.reads()).unwrap();
        let mode = std::fs::metadata(&tokens).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&tokens, &link).unwrap();
        assert!(matches!(
            forget_ended(&link, rustix::process::getuid().as_raw(), store.reads()),
            Err(ForgetError::Unsafe(_))
        ));
    }

    /// An agent running from before agents had tokens, which none of its own starts has had.
    const UPGRADED: &str = "agent_0190a1b2c3d47abc8def0123456789ae";

    /// The tokens of `store`'s agents, and `UPGRADED`, on a writer of their own.
    struct Tokens {
        _dir: TempDir,
        dir: std::path::PathBuf,
        store: Writer,
        tokens: AgentTokens,
        _thread: crate::writer::Thread,
    }

    impl Tokens {
        fn new() -> Self {
            let dir = TempDir::new("mint");
            let path = dir.path().join("bazhen.db");
            drop(store(dir.path()));
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute(
                    "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                       untokened, created_event_id, updated_event_id)
                     VALUES (?, 'env_local', 'claude-code', 'p', '/', 'running', 1, 1, 1)",
                    [UPGRADED],
                )
                .unwrap();
            let (store, thread) = crate::writer::start(Store::open(&path).unwrap(), &path).unwrap();
            let tokens_dir = dir.path().join("agents");
            let uid = rustix::process::getuid().as_raw();
            Self {
                tokens: AgentTokens::new(tokens_dir.clone(), uid, store.clone()),
                dir: tokens_dir,
                store,
                _dir: dir,
                _thread: thread,
            }
        }

        async fn mint(&self, agent: &str) -> Minted {
            self.tokens
                .mint(&AgentId::parse(agent).unwrap())
                .await
                .unwrap()
        }

        /// The agent the token in `file` names now.
        fn agent_of(&self, file: &Path) -> Option<String> {
            let token = std::fs::read_to_string(file).unwrap();
            let reader = self.store.reader().unwrap();
            agent_of(reader.reads(), &token)
                .unwrap()
                .map(|agent| agent.as_str().to_owned())
        }

        fn untokened(&self, agent: &str) -> bool {
            self.store
                .reader()
                .unwrap()
                .reads()
                .agent_untokened(agent)
                .unwrap()
        }
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn writes_each_token_alone_in_a_0600_file_in_a_0700_directory_and_knows_its_agent_by_it() {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            let minted = t.mint(LIVE).await;
            let token = std::fs::read_to_string(&minted.file).unwrap();
            assert_eq!(
                (mode(&t.dir), mode(&minted.file), is_token(&token)),
                (0o700, 0o600, true)
            );
            assert_eq!(t.agent_of(&minted.file).as_deref(), Some(LIVE));
            minted.kept().await;
        });
    }

    #[test]
    fn gives_each_start_a_file_of_its_own_so_the_last_starts_never_holds_the_next_token() {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            let first = t.mint(LIVE).await;
            let first_file = first.file.clone();
            let first_token = std::fs::read_to_string(&first_file).unwrap();
            first.kept().await;
            let second = t.mint(LIVE).await;
            assert_eq!(
                (
                    second.file == first_file,
                    std::fs::read_to_string(&first_file).unwrap() == first_token
                ),
                (false, true)
            );
            assert_eq!(
                [t.agent_of(&first_file), t.agent_of(&second.file)],
                [None, Some(LIVE.to_owned())]
            );
            second.kept().await;
        });
    }

    #[test]
    fn removes_the_earlier_starts_files_once_a_start_goes_ahead() {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            let first = t.mint(LIVE).await;
            let first_file = first.file.clone();
            first.kept().await;
            // Another agent's file, and one a mint left half written, which the sweep has to remove.
            let other = t.mint(CLOSED).await;
            let half = t.dir.join(format!("{LIVE}.00ff.token.tmp"));
            std::fs::write(&half, "").unwrap();
            let second = t.mint(LIVE).await;
            let second_file = second.file.clone();
            second.kept().await;
            assert_eq!(
                [&first_file, &second_file, &other.file, &half].map(|file| file.exists()),
                [false, true, true, true]
            );
            other.kept().await;
        });
    }

    #[test]
    fn gives_the_running_process_its_token_back_when_a_start_is_refused() {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            let running = t.mint(LIVE).await;
            let running_file = running.file.clone();
            running.kept().await;
            let refused = t.mint(LIVE).await;
            let refused_file = refused.file.clone();
            refused.abandoned().await;
            assert_eq!(
                (t.agent_of(&running_file), refused_file.exists()),
                (Some(LIVE.to_owned()), false)
            );
        });
    }

    #[test]
    fn keeps_an_agent_started_before_agents_had_tokens_known_by_its_id_when_its_restart_is_refused()
    {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            t.mint(UPGRADED).await.abandoned().await;
            assert!(t.untokened(UPGRADED));
        });
    }

    #[test]
    fn knows_an_agent_started_before_agents_had_tokens_by_its_id_no_more_once_a_start_of_its_own_goes_ahead()
     {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            t.mint(UPGRADED).await.kept().await;
            assert!(!t.untokened(UPGRADED));
        });
    }

    #[test]
    fn keeps_no_token_in_the_database_only_its_hash() {
        crate::testing::runtime().block_on(async {
            let t = Tokens::new();
            let minted = t.mint(LIVE).await;
            let token = std::fs::read_to_string(&minted.file).unwrap();
            minted.kept().await;
            let hashes: Vec<Option<String>> = {
                let reader = t.store.reader().unwrap();
                [LIVE, UPGRADED]
                    .map(|id| reader.reads().agent_token_hash(id).unwrap())
                    .into()
            };
            let db = std::fs::read(t.dir.with_file_name("bazhen.db")).unwrap();
            let wal = std::fs::read(t.dir.with_file_name("bazhen.db-wal")).unwrap_or_default();
            let holds = |bytes: &[u8]| bytes.windows(token.len()).any(|w| w == token.as_bytes());
            assert_eq!(
                (hashes, holds(&db), holds(&wal)),
                (vec![Some(hash_of(&token)), None], false, false)
            );
        });
    }
}
