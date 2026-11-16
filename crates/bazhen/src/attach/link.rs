//! One attachment through the daemon's socket: the terminal's stream as a WebSocket, and the loop
//! that moves keys, output and frames between it and the person's terminal.

use std::io::{self, ErrorKind, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;

use bazhen_client::Caller;
use bazhen_protocol::stream::StreamClientFrame;
use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::Errno;
use serde::Deserialize;
use tungstenite::handshake::client::Request;
use tungstenite::{HandshakeError, Message, WebSocket};

use super::attachment::{Attachment, Effect, Ending};
use super::tty::{self, Resizes};
use crate::call::{ANOTHER_BUILD, CALL, Failed};
use crate::fmt::encode_uri_component;

/// The most keys read from the person's terminal at once.
const KEYS_AT_ONCE: usize = 4096;

/// How an attachment's loop came to an end.
#[derive(Debug)]
pub(crate) enum Outcome {
    Ended(Ending),
    /// The daemon stopped answering.
    Gone,
}

/// A refusal's body, as far as the person needs it.
#[derive(Deserialize)]
struct Refusal {
    message: String,
}

/// The stream of `terminal` through the daemon at `socket`, as `caller`, joined with `hello`.
pub(crate) fn open(
    socket: &Path,
    terminal: &str,
    caller: &Caller,
    hello: &StreamClientFrame,
) -> Result<WebSocket<UnixStream>, Failed> {
    let stream = UnixStream::connect(socket).map_err(|_| Failed::NotRunning)?;
    stream
        .set_read_timeout(Some(CALL))
        .and_then(|()| stream.set_write_timeout(Some(CALL)))
        .map_err(|_| Failed::NotRunning)?;
    let mut request = Request::builder()
        .uri(format!(
            "ws://localhost/v1/terminals/{}/stream",
            encode_uri_component(terminal)
        ))
        .header("Host", "localhost")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        );
    let said = caller
        .headers()
        .map_err(|e| Failed::Unsendable(e.to_string()))?;
    for (name, value) in said {
        request = request.header(name, value);
    }
    let request = request
        .body(())
        .map_err(|e| Failed::Unsendable(e.to_string()))?;
    match tungstenite::client::client(request, stream) {
        Ok((mut ws, _)) => {
            let hello =
                serde_json::to_string(hello).map_err(|e| Failed::Unsendable(e.to_string()))?;
            ws.send(Message::text(hello))
                .map_err(|_| Failed::NotRunning)?;
            ws.get_ref()
                .set_read_timeout(None)
                .and_then(|()| ws.get_ref().set_write_timeout(None))
                .and_then(|()| ws.get_ref().set_nonblocking(true))
                .map_err(|_| Failed::NotRunning)?;
            Ok(ws)
        }
        Err(HandshakeError::Failure(tungstenite::Error::Http(response))) => {
            if response.status() == 404 {
                return Err(Failed::Refused(ANOTHER_BUILD.to_owned()));
            }
            let body = response.body().as_deref().unwrap_or_default();
            let said = serde_json::from_slice::<Refusal>(body).map(|r| r.message);
            Err(Failed::Refused(said.unwrap_or_else(|_| {
                format!("the daemon refused to attach: HTTP {}", response.status())
            })))
        }
        Err(_) => Err(Failed::NotRunning),
    }
}

/// Moves keys, output and frames until the attachment ends. The notices the daemon sent on the
/// way are left in `notes`.
pub(crate) fn pump(
    ws: &mut WebSocket<UnixStream>,
    attachment: &mut Attachment,
    resizes: &Resizes,
    notes: &mut Vec<String>,
) -> io::Result<Outcome> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut keys = [0u8; KEYS_AT_ONCE];
    let mut unsent = false;
    loop {
        let wanted = if unsent {
            PollFlags::IN | PollFlags::OUT
        } else {
            PollFlags::IN
        };
        let mut fds = [
            PollFd::new(&stdin, PollFlags::IN),
            PollFd::new(ws.get_ref(), wanted),
            PollFd::from_borrowed_fd(resizes.fd(), PollFlags::IN),
        ];
        match poll(&mut fds, None) {
            Ok(_) => {}
            Err(Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
        let [typed, daemon, winch] = fds.map(|fd| fd.revents());
        let mut effects = Vec::new();
        if !winch.is_empty() {
            resizes.clear();
            effects.push(Attachment::resized(tty::size()?));
        }
        if !typed.is_empty() {
            match rustix::io::read(&stdin, &mut keys) {
                Ok(0) => return Ok(Outcome::Ended(Ending::Detached)),
                Ok(n) => effects.extend(attachment.keys(keys.get(..n).unwrap_or_default())),
                Err(Errno::INTR | Errno::AGAIN) => {}
                // The person's terminal is gone, and the attachment with it.
                Err(_) => return Ok(Outcome::Ended(Ending::Detached)),
            }
        }
        if !daemon.is_empty() {
            loop {
                match ws.read() {
                    Ok(Message::Binary(output)) => stdout.write_all(&output)?,
                    Ok(Message::Text(text)) => effects.extend(attachment.frame(text.as_str())),
                    Ok(Message::Close(_)) => return Ok(Outcome::Gone),
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => return Ok(Outcome::Gone),
                }
            }
            stdout.flush()?;
        }
        for effect in effects {
            let message = match effect {
                Effect::Send(frame) => Message::text(serde_json::to_string(&frame)?),
                Effect::Input(keys) => Message::binary(keys),
                Effect::Note(note) => {
                    notes.push(note);
                    continue;
                }
                Effect::End(ending) => {
                    // A goodbye the daemon may not hear: it ends the view on the hang-up anyway.
                    let _ = ws.close(None).and_then(|()| ws.flush());
                    return Ok(Outcome::Ended(ending));
                }
            };
            match ws.write(message) {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                Err(_) => return Ok(Outcome::Gone),
            }
        }
        match ws.flush() {
            Ok(()) => unsent = false,
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => unsent = true,
            Err(_) => return Ok(Outcome::Gone),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach::attachment::{Attachment, Size};
    use std::io::Read as _;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::thread;
    use tungstenite::handshake::server::{Callback, ErrorResponse, Request as Asked, Response};

    /// Tells the test the path and agent token an upgrade asked with, and accepts it.
    struct Asking(std::sync::mpsc::Sender<(String, Option<String>)>);

    impl Callback for Asking {
        fn on_request(self, req: &Asked, res: Response) -> Result<Response, ErrorResponse> {
            let token = req.headers().get("bazhen-agent-token");
            let token = token.map(|v| v.to_str().unwrap().to_owned());
            self.0.send((req.uri().path().to_owned(), token)).unwrap();
            Ok(res)
        }
    }

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    /// A socket path of the test's own, in a directory removed when the guard drops.
    struct Dir(PathBuf);

    impl Dir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("bz-link-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn socket(&self) -> PathBuf {
            self.0.join("bazhen.sock")
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn upgrades_the_terminals_stream_as_the_caller_and_joins_with_its_hello() {
        let dir = Dir::new("join");
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let (tell, asked) = std::sync::mpsc::channel();
            let mut ws = tungstenite::accept_hdr(stream, Asking(tell)).unwrap();
            let asked = asked.recv().unwrap();
            let hello = ws.read().unwrap().into_text().unwrap().to_string();
            (asked, hello)
        });
        let hello = Attachment::hello(Size {
            cols: 100,
            rows: 30,
        });
        let caller = Caller::with_token(Some(TOKEN.to_owned()));
        let ws = open(&dir.socket(), "term_x", &caller, &hello).unwrap();
        let ((path, token), said) = server.join().unwrap();
        drop(ws);
        assert_eq!(path, "/v1/terminals/term_x/stream");
        assert_eq!(token.as_deref(), Some(TOKEN));
        assert_eq!(said, serde_json::to_string(&hello).unwrap());
    }

    #[test]
    fn says_why_the_daemon_refused_to_attach() {
        let dir = Dir::new("refused");
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = [0u8; 4096];
            let _ = stream.read(&mut head).unwrap();
            let body = r#"{"error":"forbidden","message":"an agent can't attach to a terminal"}"#;
            write!(
                stream,
                "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        let hello = Attachment::hello(Size { cols: 80, rows: 24 });
        let refused = open(&dir.socket(), "term_x", &Caller::default(), &hello).unwrap_err();
        server.join().unwrap();
        assert!(
            matches!(&refused, Failed::Refused(m) if m == "an agent can't attach to a terminal"),
            "{refused:?}"
        );
    }

    #[test]
    fn takes_a_daemon_that_serves_no_stream_on_its_socket_for_another_build() {
        let dir = Dir::new("older");
        let listener = UnixListener::bind(dir.socket()).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = [0u8; 4096];
            let _ = stream.read(&mut head).unwrap();
            stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let hello = Attachment::hello(Size { cols: 80, rows: 24 });
        let older = open(&dir.socket(), "term_x", &Caller::default(), &hello).unwrap_err();
        server.join().unwrap();
        assert!(
            matches!(&older, Failed::Refused(m) if m == ANOTHER_BUILD),
            "{older:?}"
        );
    }

    #[test]
    fn finds_no_daemon_where_nothing_listens() {
        let dir = Dir::new("none");
        let hello = Attachment::hello(Size { cols: 80, rows: 24 });
        let none = open(&dir.socket(), "term_x", &Caller::default(), &hello).unwrap_err();
        assert!(matches!(none, Failed::NotRunning), "{none:?}");
    }
}
