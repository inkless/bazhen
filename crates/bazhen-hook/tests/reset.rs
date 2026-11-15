//! The waiter of each hook client, the binary and the `sh` + `curl` script, run as a harness runs
//! it, against a daemon that answers a whole reply without `Content-Length` and closes with the
//! request's last byte unread. The reply is refused; a client that took what ended the connection
//! for a reply cut short would try again.
//!
//! Linux ends such a connection with a reset after the reply, which is what these tests guard.
//! macOS ends it cleanly, so there they check the clean close alone;
//! `a_close_with_bytes_unread_resets_on_linux_alone` pins which close each OS gives. Node can't
//! reset a Unix socket on demand, so this lives here rather than beside the other cases of both
//! clients in `hook-command.medium.test.ts`.

use std::error::Error;
use std::fs;
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const BINARY: &str = env!("CARGO_BIN_EXE_bazhen-hook");
const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/bazhen-hook.sh");
/// Far past what either client takes, so a client that hangs fails the test rather than the run.
const DEADLINE: Duration = Duration::from_secs(20);
/// How a client's read ends, after the reply, once the daemon has closed with bytes unread.
const AFTER_A_CLOSE_WITH_BYTES_UNREAD: std::result::Result<usize, ErrorKind> =
    if cfg!(target_os = "linux") {
        Err(ErrorKind::ConnectionReset)
    } else {
        Ok(0)
    };

fn reply(length: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.bazhen.hook-reply\r\n\
         Bazhen-Exit-Code: 2\r\nBazhen-Offered: \r\nBazhen-Stdout-Bytes: 0\r\n{length}\r\n{body}"
    )
    .into_bytes()
}

/// Reads a request but for its last byte. Both clients send a body in one write, so that byte is
/// already in the socket's queue by the time the one before it is read.
fn read_all_but_last(conn: &mut UnixStream) -> Result<()> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        conn.read_exact(&mut byte)?;
        head.extend_from_slice(&byte);
    }
    let head = String::from_utf8(head)?.to_ascii_lowercase();
    let length: usize = head
        .split("\r\n")
        .find_map(|line| line.strip_prefix("content-length:"))
        .ok_or("a request without Content-Length")?
        .trim()
        .parse()?;
    let mut body = vec![0; length.checked_sub(1).ok_or("a request without a body")?];
    conn.read_exact(&mut body)?;
    Ok(())
}

/// Answers the first request with a reply without a length and every later one with mail,
/// closing each with its last byte unread, and counts the requests.
fn serve(listener: &UnixListener, requests: &AtomicUsize) -> Result<()> {
    let no_length = reply("", "oops");
    let mail = reply("Content-Length: 4\r\n", "mail");
    for conn in listener.incoming() {
        let mut conn = conn?;
        read_all_but_last(&mut conn)?;
        let answer = if requests.fetch_add(1, Ordering::SeqCst) == 0 {
            &no_length
        } else {
            &mail
        };
        conn.write_all(answer)?;
    }
    Ok(())
}

/// A directory of the test's own, removed however the test ends.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Runs `client wait` against the stub; its exit code and the requests the stub read.
fn wait_on_a_reset(client: &str, name: &str) -> Result<(Option<i32>, usize)> {
    // Under /tmp: a socket path must fit in about 104 bytes.
    let dir = Scratch(PathBuf::from(format!(
        "/tmp/bz-hook-reset-{}-{name}",
        std::process::id()
    )));
    fs::create_dir_all(&dir.0)?;
    let socket = dir.0.join("bazhen.sock");
    let listener = UnixListener::bind(&socket)?;
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&requests);
    // Left blocked in accept when the test ends, which ends its process.
    thread::spawn(move || serve(&listener, &counted));

    let mut child = Command::new(client)
        .arg("wait")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("BAZHEN_AGENT_ID", "agent_reset")
        .env("BAZHEN_SOCKET", &socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A group of its own, so a client still running at the deadline is stopped with its curl.
        .process_group(0)
        .spawn()?;
    child.stdin.take().ok_or("no stdin")?.write_all(b"{}")?;
    let group = format!("-{}", child.id());
    let (done, exited) = mpsc::channel();
    thread::spawn(move || done.send(child.wait()));
    let status = exited.recv_timeout(DEADLINE).map_err(|_| {
        // TERM, which the script traps to remove its own temporary directory.
        let _ = Command::new("kill").args(["-TERM", &group]).status();
        format!("{client} was still running after {DEADLINE:?}")
    })??;
    Ok((status.code(), requests.load(Ordering::SeqCst)))
}

#[test]
fn a_close_with_bytes_unread_resets_on_linux_alone() -> Result<()> {
    let (mut client, mut daemon) = UnixStream::pair()?;
    client.write_all(b"unread")?;
    daemon.write_all(b"reply")?;
    drop(daemon);
    let mut reply = [0; 5];
    client.read_exact(&mut reply)?;
    let after = client.read(&mut [0]).map_err(|e| e.kind());
    assert_eq!(after, AFTER_A_CLOSE_WITH_BYTES_UNREAD);
    Ok(())
}

#[test]
fn the_binary_waiter_refuses_a_reply_without_a_length_that_a_reset_follows() -> Result<()> {
    assert_eq!(wait_on_a_reset(BINARY, "binary")?, (Some(0), 1));
    Ok(())
}

#[test]
fn the_script_waiter_refuses_a_reply_without_a_length_that_a_reset_follows() -> Result<()> {
    assert_eq!(wait_on_a_reset(SCRIPT, "script")?, (Some(0), 1));
    Ok(())
}
