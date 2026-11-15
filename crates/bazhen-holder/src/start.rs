//! How a holder starts. It reads its spawn spec from stdin and does every step that can fail
//! before it says `ready`, so a spawner learns of a failure from the exit code and stderr, never
//! from a holder that sits there broken:
//!
//! | Exit | Meaning |
//! |---|---|
//! | 1 | a start step failed: the PTY, the child's program or cwd, listing `/dev/fd` |
//! | 2 | the spec is invalid, NUL bytes included |
//! | 3 | the spec's daemon shares no major with this holder |
//! | 4 | the holder leads a process group but not a session, so it can't start one |
//! | 5 | the loop failed after `ready` |
//!
//! Then it writes `ready\n` to stdout, points fds 0–2 at `/dev/null`, and runs until it is closed.

use std::io::{self, Read, Write as _};
use std::path::Path;
use std::process::ExitCode;

use bazhen_holder_proto::body::SpawnSpec;
use bazhen_holder_proto::{MAX_REQUEST_BYTES, SpawnSpecError, decode_spawn_spec};
use rustix::process::{getpid, getsid, setsid};
use thiserror::Error;

use crate::child::Reaper;
use crate::holder::{Discard, Holder};
use crate::pty::{self, Pty, SpawnError, WindowSize};

pub const READY: &[u8] = b"ready\n";

#[derive(Debug, Error)]
pub enum StartError {
    #[error("invalid spawn spec: {0}")]
    Invalid(String),
    #[error("the daemon shares no protocol major with this holder")]
    NoSharedVersion,
    #[error(
        "the holder leads a process group but not a session, so it can't start one: spawn it as \
         a session leader or as a plain child"
    )]
    GroupLeader,
    #[error("could not start: {0}")]
    Setup(#[source] io::Error),
    #[error(transparent)]
    Spawn(#[from] SpawnError),
}

impl StartError {
    pub const fn exit_code(&self) -> u8 {
        match self {
            Self::Setup(_) | Self::Spawn(_) => 1,
            Self::Invalid(_) => 2,
            Self::NoSharedVersion => 3,
            Self::GroupLeader => 4,
        }
    }
}

/// The exit code of a holder whose loop failed after it said `ready`.
pub const EXIT_AFTER_READY: u8 = 5;

/// Starts a holder from the spec on stdin, and runs it until it ends.
pub fn run() -> ExitCode {
    let holder = match start(&mut io::stdin().lock()) {
        Ok(holder) => holder,
        Err(e) => {
            // Nothing is left to tell when stderr is gone too.
            let _ = writeln!(io::stderr(), "bazhen-holder: {e}");
            return ExitCode::from(e.exit_code());
        }
    };
    if let Err(e) = io::stdout()
        .write_all(READY)
        .and_then(|()| io::stdout().flush())
    {
        // The spawner is gone, but the child already runs: the holder carries on.
        tracing::warn!(error = %e, "could not say ready");
    }
    if let Err(e) = detach_stdio() {
        tracing::warn!(error = %e, "could not point stdio at /dev/null");
    }
    let error = holder.run();
    tracing::error!(error = %error, "the holder's loop failed");
    ExitCode::from(EXIT_AFTER_READY)
}

fn start(stdin: &mut impl Read) -> Result<Holder<Discard>, StartError> {
    let spec = read_spec(stdin)?;
    become_session_leader()?;
    std::env::set_current_dir("/").map_err(StartError::Setup)?;
    pty::close_inherited_fds().map_err(StartError::Setup)?;
    crate::log::init(Path::new(spec.socket.as_str()));
    let reaper = Reaper::new().map_err(StartError::Setup)?;
    let (pty, slave) = Pty::open(WindowSize::from(spec.size)).map_err(StartError::Setup)?;
    let child = pty::spawn(slave, &spec.process(), &reaper)?;
    let program = Path::new(spec.argv.as_slice().first().map_or("", String::as_str))
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    tracing::info!(
        terminal = spec.terminal_id.as_str(),
        program,
        args = spec.argv.as_slice().len().saturating_sub(1),
        cols = WindowSize::from(spec.size).cols(),
        rows = WindowSize::from(spec.size).rows(),
        pid = child.pid().as_raw_nonzero(),
        "holder started"
    );
    Ok(Holder::new(pty, reaper, child, spec.generation, Discard))
}

/// Reads and checks the spec, refusing more than `MAX_REQUEST_BYTES` of it.
///
/// # Errors
///
/// `Invalid` for a spec that is too long, isn't one, or holds a NUL byte, which no argv, cwd or
/// environment can carry; `NoSharedVersion` when the daemon shares no major with this holder.
pub fn read_spec(stdin: &mut impl Read) -> Result<SpawnSpec, StartError> {
    let mut bytes = Vec::new();
    stdin
        .take(
            u64::try_from(MAX_REQUEST_BYTES)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
        )
        .read_to_end(&mut bytes)
        .map_err(|e| StartError::Invalid(format!("could not read it: {e}")))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(StartError::Invalid(format!(
            "it is over {MAX_REQUEST_BYTES} bytes"
        )));
    }
    let spec = decode_spawn_spec(&bytes).map_err(|e| match e {
        SpawnSpecError::NoSharedVersion { .. } => StartError::NoSharedVersion,
        SpawnSpecError::Invalid(why) => StartError::Invalid(why.to_string()),
    })?;
    let env = spec.env.as_map();
    let has_nul = spec.argv.as_slice().iter().any(|arg| arg.contains('\0'))
        || spec.cwd.as_str().contains('\0')
        || env
            .iter()
            .any(|(k, v)| k.contains('\0') || v.contains('\0'));
    if has_nul {
        return Err(StartError::Invalid(
            "a NUL byte in argv, cwd or env".to_owned(),
        ));
    }
    if env.keys().any(|k| k.is_empty() || k.contains('=')) {
        return Err(StartError::Invalid(
            "an environment name that is empty or holds `=`".to_owned(),
        ));
    }
    Ok(spec)
}

/// Makes the holder the leader of a session of its own, unless it already is one, so no signal
/// to its spawner's session or group reaches it.
fn become_session_leader() -> Result<(), StartError> {
    let me = getpid();
    if getsid(None).is_ok_and(|session| session == me) {
        return Ok(());
    }
    match setsid() {
        Ok(_) => Ok(()),
        Err(rustix::io::Errno::PERM) => Err(StartError::GroupLeader),
        Err(e) => Err(StartError::Setup(e.into())),
    }
}

fn detach_stdio() -> io::Result<()> {
    let null = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null")?;
    rustix::stdio::dup2_stdin(&null)?;
    rustix::stdio::dup2_stdout(&null)?;
    rustix::stdio::dup2_stderr(&null)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut spec = serde_json::json!({
            "protocol": ["1.0"],
            "terminalId": "t1",
            "socket": "/tmp/t1.sock",
            "tags": {},
            "size": {"cols": 80, "rows": 24},
            "argv": ["sh", "-c", "exit 0"],
            "cwd": "/",
            "env": {"PATH": "/usr/bin:/bin"},
            "generation": 0,
        });
        change(&mut spec);
        serde_json::to_vec(&spec).unwrap()
    }

    fn read(bytes: &[u8]) -> Result<SpawnSpec, StartError> {
        read_spec(&mut &bytes[..])
    }

    #[test]
    fn reads_a_spec() {
        let spec = read(&spec(|_| {})).unwrap();
        assert_eq!(spec.terminal_id.as_str(), "t1");
    }

    #[test]
    fn refuses_a_spec_longer_than_a_request_may_be() {
        let mut long = spec(|_| {});
        long.resize(MAX_REQUEST_BYTES + 1, b' ');
        assert!(matches!(read(&long), Err(StartError::Invalid(why)) if why.contains("over")));
        long.truncate(MAX_REQUEST_BYTES);
        assert!(read(&long).is_ok());
    }

    #[test]
    fn refuses_a_nul_in_argv_cwd_or_env() {
        let cases: [fn(&mut serde_json::Value); 4] = [
            |s| s["argv"][1] = "a\0b".into(),
            |s| s["cwd"] = "/a\0b".into(),
            |s| s["env"]["A"] = "a\0b".into(),
            |s| s["env"]["A\0B"] = "x".into(),
        ];
        for case in cases {
            assert!(
                matches!(read(&spec(case)), Err(StartError::Invalid(why)) if why.contains("NUL"))
            );
        }
    }

    #[test]
    fn refuses_an_environment_name_no_environment_can_hold() {
        for name in ["", "A=B"] {
            let bytes = spec(|s| s["env"][name] = "x".into());
            assert!(
                matches!(read(&bytes), Err(StartError::Invalid(_))),
                "{name:?}"
            );
        }
    }

    #[test]
    fn tells_a_daemon_with_no_shared_major_apart_from_a_bad_spec() {
        let bytes = spec(|s| s["protocol"] = serde_json::json!(["99.0"]));
        assert!(matches!(read(&bytes), Err(StartError::NoSharedVersion)));
        assert!(matches!(read(b"not json"), Err(StartError::Invalid(_))));
    }

    #[test]
    fn each_failure_has_its_own_exit_code() {
        let codes = [
            StartError::Setup(io::Error::other("x")).exit_code(),
            StartError::Invalid(String::new()).exit_code(),
            StartError::NoSharedVersion.exit_code(),
            StartError::GroupLeader.exit_code(),
            EXIT_AFTER_READY,
        ];
        assert_eq!(codes, [1, 2, 3, 4, 5]);
    }
}
