//! The harnesses this daemon serves, built over what it takes from the world, as `main.ts` builds
//! its environment's adapters: the hook client they run, the daemon's own environment and the
//! one captured for agents, and the files they read.

use std::ffi::OsStr;
use std::sync::Arc;

use bazhen_harness::{HarnessDeps, Harnesses, production};

use crate::agents::transcript::TranscriptReader;
use crate::env::Env;
use crate::pairing::random_bytes;

/// One shell word, whatever the string holds.
fn word(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The hook client as a shell command, which a harness runs through a shell with the event
/// appended, so its path stays whole whatever it holds (`hookCommand` in
/// `mailbox/hook-command.ts`). The client replaces that shell, so the harness is its parent.
pub(crate) fn hook_command(client: &str) -> String {
    format!("exec {}", word(client))
}

/// A random UUID, as `randomUUID` gives one: version 4, its variant set.
fn new_session_id() -> String {
    let mut bytes = random_bytes::<16>().unwrap_or_else(|err| {
        tracing::warn!(
            "bazhen: no random bytes for a session id, so it is made from the time: {err}"
        );
        unique_bytes()
    });
    let [.., version, _, variant, _, _, _, _, _, _, _] = &mut bytes;
    *version = (*version & 0x0f) | 0x40;
    *variant = (*variant & 0x3f) | 0x80;
    let hex: String = bytes
        .iter()
        .flat_map(|b| [b >> 4, b & 0x0f])
        .filter_map(|nibble| char::from_digit(u32::from(nibble), 16))
        .collect();
    let part = |range: std::ops::Range<usize>| hex.get(range).unwrap_or_default().to_owned();
    format!(
        "{}-{}-{}-{}-{}",
        part(0..8),
        part(8..12),
        part(12..16),
        part(16..20),
        part(20..32)
    )
}

/// Bytes no other call in this daemon gives, for a session id when the kernel gives none: the
/// SHA-256 of the time, this process and a count of the calls. A launch has minted its agent's
/// ids from the kernel's bytes just before, so this is all but never taken.
fn unique_bytes() -> [u8; 16] {
    use sha2::{Digest as _, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let seed = format!(
        "{now}.{}.{}",
        std::process::id(),
        CALLS.fetch_add(1, Ordering::Relaxed)
    );
    let digest = Sha256::digest(seed.as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(digest.get(..16).unwrap_or(&[0; 16]));
    bytes
}

/// What the served harnesses are built over.
#[derive(Debug, Clone)]
pub(crate) struct World {
    /// What hooks are given to run: the stable link to the installed client.
    pub(crate) hook: String,
    /// The environment captured for agents.
    pub(crate) user_env: Env,
    pub(crate) home: String,
    pub(crate) socket: String,
}

/// The harnesses this daemon serves, as `production` builds them, over `world`.
pub(crate) fn served(world: World) -> Harnesses {
    let World {
        hook,
        user_env,
        home,
        socket,
    } = world;
    let transcripts = TranscriptReader::new(Box::new(|message| {
        tracing::warn!("bazhen: {message}");
    }));
    production(HarnessDeps {
        new_session_id: Box::new(new_session_id),
        hook_command: hook_command(&hook),
        daemon_env: Box::new(|name| std::env::var(name).ok()),
        user_env: Box::new(move |name| {
            user_env
                .get(OsStr::new(name))
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        }),
        home,
        read_file: Box::new(|path| {
            std::fs::read(path)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        }),
        scan_transcript: Box::new(move |path, line| transcripts.scan(path, line)),
        now_ms: Box::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        }),
        daemon_socket: socket,
        real_path: Arc::new(|path| {
            std::fs::canonicalize(path)
                .ok()
                .map(|real| real.to_string_lossy().into_owned())
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_hook_client_as_one_shell_word_whatever_it_holds() {
        assert_eq!(
            [
                hook_command("/opt/bazhen/bazhen-hook"),
                hook_command("/home/o'neil/my hook"),
            ],
            [
                "exec '/opt/bazhen/bazhen-hook'",
                "exec '/home/o'\\''neil/my hook'",
            ]
        );
    }

    #[test]
    fn makes_each_session_id_a_new_version_4_uuid() {
        let [first, second] = [new_session_id(), new_session_id()];
        let shape = |id: &str| {
            let parts: Vec<usize> = id.split('-').map(str::len).collect();
            let version = id.chars().nth(14);
            let variant = id.chars().nth(19);
            (
                parts,
                version,
                variant.is_some_and(|c| "89ab".contains(c)),
                id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()),
            )
        };
        let expected = (vec![8, 4, 4, 4, 12], Some('4'), true, true);
        assert_eq!(
            [shape(&first), shape(&second)],
            [expected.clone(), expected]
        );
        assert_ne!(first, second);
    }

    #[test]
    fn resumes_a_session_once_its_transcript_on_disk_holds_a_message_or_a_commands_output() {
        let dir = crate::testing::TempDir::new("served-transcript");
        let served = served(World {
            hook: "/hook".to_owned(),
            user_env: Env::default(),
            home: dir.path().display().to_string(),
            socket: "/socket".to_owned(),
        });
        let harness = served
            .get(bazhen_protocol::agents::HarnessId::ClaudeCode)
            .unwrap();
        let metadata = concat!(
            r#"{"type":"mode","mode":"normal"}"#,
            "\n",
            r#"{"type":"file-history-snapshot","messageId":"m","snapshot":{}}"#,
            "\n",
        );
        let command = r#"{"type":"system","subtype":"local_command","content":"/model"}"#;
        let user = r#"{"type":"user","message":{"role":"user","content":"hello"}}"#;
        let resumes = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            harness.can_resume(&bazhen_harness::Evidence {
                transcript: path.to_str(),
            })
        };
        assert_eq!(
            [
                resumes("metadata.jsonl", metadata),
                resumes("command.jsonl", &format!("{metadata}{command}\n")),
                resumes("user.jsonl", &format!("{metadata}{user}\n")),
            ],
            [false, true, true]
        );
    }
}
