//! A throwaway PTY holder: one process per terminal, holding the PTY, the child, an engine and
//! a byte ring, served over a Unix socket.
//!
//! `bz-holder spawn < spec.json` starts a detached holder, waits until its socket is bound and
//! prints `ready <pid>`. `serve` is the holder itself.

mod engine;
mod frame;
mod holder;
mod pty;
mod ring;
mod snapshot;

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixListener;
use std::process::{Command, ExitCode, Stdio};

use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};

use crate::holder::{Holder, Spec, log};

fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let result = match mode.as_str() {
        "spawn" => spawn(),
        "serve" => serve(),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: bz-holder spawn|serve",
        )),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log(&format!("bz-holder {mode}: {e}"));
            ExitCode::FAILURE
        }
    }
}

fn read_spec() -> io::Result<(String, Spec)> {
    let mut text = String::new();
    io::stdin().read_to_string(&mut text)?;
    let spec = serde_json::from_str(&text).map_err(io::Error::other)?;
    Ok((text, spec))
}

fn spawn() -> io::Result<()> {
    let (text, spec) = read_spec()?;
    let log_path = spec.socket.with_extension("log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log_file));
    let mut child = pty::spawn_detached(&mut command)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    let mut line = String::new();
    if let Some(stdout) = child.stdout.take() {
        BufReader::new(stdout).read_line(&mut line)?;
    }
    if !line.starts_with("ready ") {
        return Err(io::Error::other(format!(
            "holder did not start; see {}",
            log_path.display()
        )));
    }
    io::stdout().write_all(line.as_bytes())?;
    // The holder is in its own session and keeps running; this launcher only reaps it if it
    // has already died, so no zombie outlives the launcher.
    let _ = child.try_wait();
    Ok(())
}

fn serve() -> io::Result<()> {
    let (_, spec) = read_spec()?;
    raise_fd_limit();
    let null = File::open("/dev/null")?;
    rustix::stdio::dup2_stdin(&null)?;
    let _ = std::fs::remove_file(&spec.socket);
    let listener = UnixListener::bind(&spec.socket)?;
    std::fs::set_permissions(&spec.socket, std::fs::Permissions::from_mode(0o600))?;
    let holder = Holder::start(spec, listener)?;
    io::stdout().write_all(format!("ready {}\n", std::process::id()).as_bytes())?;
    rustix::stdio::dup2_stdout(&null)?;
    holder.run()
}

/// Raises the soft fd limit as far as the hard one allows. macOS refuses a soft limit above
/// `OPEN_MAX` even when the hard limit is unlimited, so that is the fallback.
fn raise_fd_limit() {
    let current = getrlimit(Resource::Nofile);
    let wanted = current.maximum.unwrap_or(u64::MAX).min(1 << 20);
    for soft in [wanted, 10_240] {
        if current.current.is_some_and(|c| c >= soft) {
            return;
        }
        if setrlimit(
            Resource::Nofile,
            Rlimit {
                current: Some(soft),
                maximum: current.maximum,
            },
        )
        .is_ok()
        {
            return;
        }
    }
}
