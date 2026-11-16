//! `bazhen attach` can't be left running past two requests to stop it, even stuck writing to a
//! terminal that stopped reading: the first wakes its loop, which never reads the wake-up while
//! the write blocks, so the second must end the process by itself.

use std::fs::{self, OpenOptions};
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use bazhen::bazhen_protocol::id::PROTOCOL_ID;
use bazhen_test_signal::Signal;
use rustix::fs::OFlags;
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use tungstenite::Message;

const TERMINAL: &str = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
/// Longer than any exit takes, short of the test's own timeout.
const BOUND: Duration = Duration::from_secs(10);

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// A home of the test's own, removed when this drops.
struct Home(PathBuf);

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The state the fake daemon answers with: the fixture's, which holds TERMINAL, attachable.
fn state() -> Res<String> {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/api/StateSnapshot.json");
    let examples: serde_json::Value =
        bazhen::bazhen_protocol::wire::from_slice(&fs::read(fixtures)?)?;
    let wire = examples.get(0).and_then(|e| e.get("wire"));
    Ok(wire.ok_or("the fixture has no wire example")?.to_string())
}

/// Reads a request up to the end of its head.
fn read_head(stream: &UnixStream) -> Res<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    while line != "\r\n" {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err("the request ended early".into());
        }
    }
    Ok(())
}

fn answer(mut stream: UnixStream, body: &str) -> Res<()> {
    read_head(&stream)?;
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    )?;
    Ok(())
}

/// A daemon at `socket` that answers attach's health and state, takes its stream, and floods it
/// with output until its sends stall: then `stalled` hears, and the stream is held open until
/// `done` does.
fn daemon(
    socket: &Path,
    stalled: mpsc::Sender<()>,
    done: mpsc::Receiver<()>,
) -> Res<thread::JoinHandle<Res<()>>> {
    let listener = UnixListener::bind(socket)?;
    Ok(thread::spawn(move || {
        let health = format!(r#"{{"status":"ok","protocolId":"{PROTOCOL_ID}"}}"#);
        answer(listener.accept()?.0, &health)?;
        answer(listener.accept()?.0, &state()?)?;
        let (stream, _) = listener.accept()?;
        let mut ws = tungstenite::accept(stream).map_err(|e| e.to_string())?;
        ws.read()?;
        ws.get_ref()
            .set_write_timeout(Some(Duration::from_millis(500)))?;
        while ws.send(Message::binary(vec![b'x'; 64 << 10])).is_ok() {}
        stalled.send(())?;
        let _ = done.recv();
        Ok(())
    }))
}

/// `bazhen attach TERMINAL` on a PTY whose other end nothing reads, against the daemon in `home`.
fn attach(home: &Path) -> Res<(Child, rustix::fd::OwnedFd)> {
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY)?;
    grantpt(&master)?;
    unlockpt(&master)?;
    let path = ptsname(&master, Vec::new())?;
    let slave = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(i32::try_from(OFlags::NOCTTY.bits())?)
        .open(path.to_str()?)?;
    let child = Command::new(env!("CARGO_BIN_EXE_bazhen"))
        .args(["attach", TERMINAL])
        .env_clear()
        .env("BAZHEN_HOME", home)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave))
        .spawn()?;
    Ok((child, master))
}

/// What the attach has written to its terminal and nothing has read yet.
fn shown(master: &rustix::fd::OwnedFd) -> String {
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let mut fds = [rustix::event::PollFd::new(
            master,
            rustix::event::PollFlags::IN,
        )];
        let ready = rustix::event::poll(&mut fds, Some(&rustix::time::Timespec::default()));
        if !matches!(ready, Ok(1..)) {
            break;
        }
        match rustix::io::read(master, &mut chunk) {
            Ok(n @ 1..) => out.extend(chunk.iter().take(n)),
            _ => break,
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// How `child` exited, if it did within BOUND; it is killed otherwise.
fn exited_within_bound(child: Child) -> Res<Option<i32>> {
    let (tell, exited) = mpsc::channel();
    let pid = child.id();
    let waiter = thread::spawn(move || {
        let mut child = child;
        let code = child.wait().map(|status| status.code());
        let _ = tell.send(code);
    });
    if let Ok(code) = exited.recv_timeout(BOUND) {
        return Ok(code?);
    }
    // The child is the test's own and unreaped, so its pid is still its own.
    bazhen_test_signal::signal(pid, Signal::KILL).map_err(|e| format!("{e:?}"))?;
    waiter.join().map_err(|_| "the waiter panicked")?;
    Ok(None)
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_second_request_to_stop_ends_an_attach_stuck_writing_to_its_terminal() {
    bazhen_test_signal::require_sandbox().unwrap();
    let home = Home(std::env::temp_dir().join(format!("bz-sig-{}", std::process::id())));
    fs::create_dir_all(home.0.join("run")).unwrap();
    let (stalled, stall) = mpsc::channel();
    let (finish, done) = mpsc::channel();
    let daemon = daemon(&home.0.join("run/bazhen.sock"), stalled, done).unwrap();
    let (child, master) = attach(&home.0).unwrap();
    if stall.recv_timeout(BOUND).is_err() {
        let code = exited_within_bound(child).unwrap();
        panic!(
            "the attach never stalled: it exited {code:?}, the daemon ended {:?}, and its terminal \
             showed {:?}",
            daemon.join().map_err(|_| "panicked"),
            shown(&master)
        );
    }
    bazhen_test_signal::signal(child.id(), Signal::TERM).unwrap();
    bazhen_test_signal::signal(child.id(), Signal::INT).unwrap();
    let code = exited_within_bound(child).unwrap();
    finish.send(()).unwrap();
    daemon.join().unwrap().unwrap();
    assert!(
        matches!(code, Some(143 | 130)),
        "attach was still running, or ended otherwise: {code:?}"
    );
}
