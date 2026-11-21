//! Agents' tokens, as far as telling who called needs them (`auth/callers.ts`'s `AgentTokens`):
//! the agent a token names, and the start-up sweep of the token files no agent will run on again.
//! The store keeps only each token's hash; the token is in a 0600 file, in a 0700 directory, that
//! the agent's environment names.

use std::path::Path;

use bazhen_protocol::ids::AgentId;
use bazhen_store::Reads;
use sha2::{Digest as _, Sha256};

use crate::private_dir::{UnsafePrivateDir, ensure_private_dir};

/// A token as the daemon mints it: 32 bytes, base64url. Anything else is never one.
pub(crate) fn is_token(text: &str) -> bool {
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
            let path = dir.join(&name);
            if let Err(err) = std::fs::remove_file(&path)
                && err.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(
                    "bazhen: can't remove the agent token file {}: {err}",
                    path.display()
                );
            }
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
}
