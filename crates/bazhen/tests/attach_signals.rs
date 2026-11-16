//! `bazhen attach` can't be left running past two requests to stop it, even stuck writing to a
//! terminal that stopped reading: the first wakes its loop, which never reads the wake-up while
//! the write blocks, so the second must end the process by itself. The first alone, to an attach
//! that isn't stuck, ends it cleanly.

use std::fs::{self, OpenOptions};
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use bazhen::bazhen_protocol::id::PROTOCOL_ID;
use bazhen_test_signal::Signal;
use rustix::fd::OwnedFd;
use rustix::fs::OFlags;
use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
use tungstenite::Message;

const TERMINAL: &str = "term_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
/// What the fake daemon shows an attach it doesn't flood, once it is attached.
const READY: &str = "ready-for-the-signal";
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

/// A daemon at `socket` that answers attach's health and state and takes its stream. With
/// `flood`, it sends output until its sends stall; without, one frame, READY. Then `sent` hears,
/// and the stream is held open until `done` does.
fn daemon(
    socket: &Path,
    flood: bool,
    sent: mpsc::Sender<()>,
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
        if flood {
            ws.get_ref()
                .set_write_timeout(Some(Duration::from_millis(500)))?;
            while ws.send(Message::binary(vec![b'x'; 64 << 10])).is_ok() {}
        } else {
            ws.send(Message::binary(READY.as_bytes().to_vec()))?;
        }
        sent.send(())?;
        let _ = done.recv();
        Ok(())
    }))
}

/// `bazhen attach TERMINAL` on a PTY whose other end only the test reads, against the daemon in
/// `home`.
fn attach(home: &Path) -> Res<(Child, OwnedFd)> {
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

/// What the attach writes to its terminal, read until it has been quiet for `quiet`.
fn shown(master: &OwnedFd, quiet: Duration) -> String {
    let wait = rustix::time::Timespec {
        tv_sec: 0,
        tv_nsec: i64::from(quiet.subsec_nanos()),
    };
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let mut fds = [rustix::event::PollFd::new(
            master,
            rustix::event::PollFlags::IN,
        )];
        if !matches!(rustix::event::poll(&mut fds, Some(&wait)), Ok(1..)) {
            break;
        }
        match rustix::io::read(master, &mut chunk) {
            Ok(n @ 1..) => out.extend(chunk.iter().take(n)),
            _ => break,
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Everything the attach writes to its terminal until the terminal closes, read as it comes on a
/// thread of its own: macOS drops what is left unread once the attach's end closes.
fn read_until_closed(master: &OwnedFd) -> Res<thread::JoinHandle<String>> {
    let master = master.try_clone()?;
    let bound = rustix::event::Timespec {
        tv_sec: i64::try_from(BOUND.as_secs())?,
        tv_nsec: 0,
    };
    Ok(thread::spawn(move || {
        let mut out = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let mut fds = [rustix::event::PollFd::new(
                &master,
                rustix::event::PollFlags::IN,
            )];
            if !matches!(rustix::event::poll(&mut fds, Some(&bound)), Ok(1..)) {
                break;
            }
            match rustix::io::read(&master, &mut chunk) {
                Ok(n @ 1..) => out.extend(chunk.iter().take(n)),
                _ => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }))
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

/// A home with a fake daemon, flooding when `flood`, and an attach to it.
struct Scene {
    home: Home,
    child: Child,
    master: OwnedFd,
    daemon: thread::JoinHandle<Res<()>>,
    sent: mpsc::Receiver<()>,
    finish: mpsc::Sender<()>,
}

fn scene(name: &str, flood: bool) -> Res<Scene> {
    let home = Home(std::env::temp_dir().join(format!("bz-sig-{name}-{}", std::process::id())));
    fs::create_dir_all(home.0.join("run"))?;
    let (told, sent) = mpsc::channel();
    let (finish, done) = mpsc::channel();
    let daemon = daemon(&home.0.join("run/bazhen.sock"), flood, told, done)?;
    let (child, master) = attach(&home.0)?;
    Ok(Scene {
        home,
        child,
        master,
        daemon,
        sent,
        finish,
    })
}

/// How the attach and the daemon ended and what the attach showed, once a test gives up on it.
/// The daemon is joined only once it has ended by itself: one still waiting on the attach never
/// would.
fn ended(s: Scene) -> String {
    drop(s.finish);
    let code = exited_within_bound(s.child);
    let daemon = s
        .daemon
        .is_finished()
        .then(|| s.daemon.join().map_err(|_| "panicked"));
    format!(
        "the attach exited {code:?}, the daemon ended {daemon:?}, and its terminal showed {:?}",
        shown(&s.master, Duration::ZERO)
    )
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_second_request_to_stop_ends_an_attach_stuck_writing_to_its_terminal() {
    bazhen_test_signal::require_sandbox().unwrap();
    let s = scene("stuck", true).unwrap();
    assert!(
        s.sent.recv_timeout(BOUND).is_ok(),
        "the attach never stalled: {}",
        ended(s)
    );
    bazhen_test_signal::signal(s.child.id(), Signal::TERM).unwrap();
    bazhen_test_signal::signal(s.child.id(), Signal::INT).unwrap();
    let code = exited_within_bound(s.child).unwrap();
    s.finish.send(()).unwrap();
    s.daemon.join().unwrap().unwrap();
    drop(s.home);
    assert!(
        matches!(code, Some(143 | 130)),
        "attach was still running, or ended otherwise: {code:?}"
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_first_request_to_stop_ends_an_idle_attach_cleanly_saying_so() {
    bazhen_test_signal::require_sandbox().unwrap();
    let s = scene("idle", false).unwrap();
    let mut seen = String::new();
    if s.sent.recv_timeout(BOUND).is_ok() {
        let by = Instant::now() + BOUND;
        while !seen.contains(READY) && Instant::now() < by {
            seen.push_str(&shown(&s.master, Duration::from_millis(100)));
        }
    }
    assert!(
        seen.contains(READY),
        "the attach never showed the daemon's frame: {}",
        ended(s)
    );
    let reading = read_until_closed(&s.master).unwrap();
    bazhen_test_signal::signal(s.child.id(), Signal::TERM).unwrap();
    let code = exited_within_bound(s.child).unwrap();
    let said = reading.join().unwrap();
    s.finish.send(()).unwrap();
    s.daemon.join().unwrap().unwrap();
    drop(s.home);
    assert_eq!(code, Some(1), "{said:?}");
    assert!(said.contains("stopped by a signal"), "{said:?}");
}
