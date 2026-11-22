//! `bazhen terminals attach --direct`: straight to a terminal's holder, over its own socket, for when the
//! daemon is down or broken. It types only while the daemon is surely not there, and lets go of
//! the terminal's input as soon as one is: the holder frees its one writer slot only when the
//! connection holding it hangs up, so a direct attach left open while the daemon runs would keep
//! the web app's keys from the terminal. It never closes or signals the terminal.

use std::io::{self, ErrorKind, Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{
    Cols, ExitStatus as HolderExit, HelloReply, HelloRequest, Rows, Size as HolderSize,
    SubscribeRequest, Versions,
};
use bazhen_holder_proto::{FrameDecoder, Reply, Request, RequestId, reply_decoder};
use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::Errno;

use bazhen_protocol::agents::ExitStatus;
use bazhen_protocol::detach_keys::DetachKeys;

use super::attachment::{DetachScan, Ending, Size};
use super::tty::{self, Stops, Wakeups};
use crate::absent::daemon_absent;
use crate::call::Failed;

/// How long a holder has to answer `hello`, as the daemon gives it.
const HELLO: Duration = Duration::from_secs(2);
/// How often an attachment that types looks again for a daemon that came back.
const RECHECK: Duration = Duration::from_secs(2);
/// The most read from the person's terminal, or the holder, at once.
const READ_AT_ONCE: usize = 64 << 10;

/// One thing to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A request for the holder.
    Send(Request),
    /// Bytes for the person's terminal.
    Show(Vec<u8>),
    /// Clears the person's screen, for a fresh snapshot.
    Clear,
    /// Something the person should read once their terminal is theirs again.
    Note(String),
    End(Ending),
}

/// A direct attachment's state between steps: whether it holds the writer slot, and the ids its
/// requests have used.
#[derive(Debug)]
pub struct Direct {
    keys: DetachScan,
    writer: bool,
    next: u32,
    /// Whether the person has been told their keys go nowhere.
    told: bool,
}

impl Direct {
    /// An attachment that may type, when `writer`, and detaches on `keys`.
    #[must_use]
    pub fn new(writer: bool, keys: DetachKeys) -> Self {
        Self {
            keys: DetachScan::new(keys),
            writer,
            next: 1,
            told: false,
        }
    }

    fn id(&mut self) -> RequestId {
        let id = RequestId(self.next);
        self.next = self.next.wrapping_add(1).max(1);
        id
    }

    /// The terminal as it is, then its output from there: a snapshot and a subscription, which
    /// the holder serves from one point.
    pub fn start(&mut self) -> Vec<Step> {
        let snapshot = Request::Snapshot { id: self.id() };
        let subscribe = Request::Subscribe {
            id: self.id(),
            body: SubscribeRequest { from: None },
        };
        vec![Step::Send(snapshot), Step::Send(subscribe)]
    }

    /// The keys typed: sent while this attachment holds the writer slot, dropped otherwise.
    pub fn keys(&mut self, keys: &[u8]) -> Vec<Step> {
        let (typed, detached) = self.keys.scan(keys);
        let mut steps = Vec::new();
        if !typed.is_empty() {
            if self.writer {
                let id = self.id();
                steps.push(Step::Send(Request::Input { id, bytes: typed }));
            } else {
                steps.extend(self.viewing());
            }
        }
        if detached {
            steps.push(Step::End(Ending::Detached));
        }
        steps
    }

    /// Whether this attachment types into the terminal.
    #[must_use]
    pub fn writes(&self) -> bool {
        self.writer
    }

    /// A daemon came back: an attachment that types lets go, so the daemon can.
    pub fn daemon_back(&mut self) -> Vec<Step> {
        if !self.writer {
            return vec![];
        }
        vec![Step::End(Ending::Yielded)]
    }

    /// The person's terminal resized: the holder's too, while this attachment holds the slot.
    pub fn resized(&mut self, size: Size) -> Vec<Step> {
        if !self.writer {
            return vec![];
        }
        let (Ok(cols), Ok(rows)) = (
            Cols::new(u64::from(size.cols)),
            Rows::new(u64::from(size.rows)),
        ) else {
            return vec![];
        };
        let id = self.id();
        vec![Step::Send(Request::Resize {
            id,
            body: HolderSize { cols, rows },
        })]
    }

    /// What the holder sent.
    pub fn reply(&mut self, reply: Reply) -> Vec<Step> {
        match reply {
            Reply::Snapshot { bytes, .. } | Reply::Data { bytes, .. } => vec![Step::Show(bytes)],
            Reply::Gap(_) => [Step::Clear].into_iter().chain(self.start()).collect(),
            Reply::Exited(exited) => vec![Step::End(program_exited(exited.status))],
            Reply::Error { body, .. } if body.request == "input" || body.request == "resize" => {
                if body.code == "not-writer" {
                    self.writer = false;
                    return self.viewing();
                }
                vec![]
            }
            Reply::Error { body, .. } if body.code == "stale-generation" => {
                [Step::Clear].into_iter().chain(self.start()).collect()
            }
            Reply::Error { body, .. } => vec![Step::End(Ending::Failed(format!(
                "the holder refused {}: {}",
                body.request, body.message
            )))],
            _ => vec![],
        }
    }

    fn viewing(&mut self) -> Vec<Step> {
        if std::mem::replace(&mut self.told, true) {
            return vec![];
        }
        vec![Step::Note(
            "this attachment only viewed the terminal: its keys went nowhere, as the daemon was \
             running or took the terminal's input back"
                .to_owned(),
        )]
    }
}

/// What an attachment's loop watches besides the terminal and the holder.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Watched<'a> {
    pub(crate) resizes: &'a Wakeups,
    pub(crate) stops: &'a Stops,
    /// The daemon's socket, looked at again every RECHECK while the attachment types.
    pub(crate) daemon: &'a Path,
}

/// The holder of `terminal`, beside the daemon's socket, said hello to as a writer when `writer`.
/// Refused when nothing answers there, or what does speaks no protocol this build does.
pub(crate) fn open(
    holders: &Path,
    terminal: &str,
    writer: bool,
) -> Result<(UnixStream, HelloReply, FrameDecoder<Reply>), Failed> {
    let socket = holders.join(format!("{terminal}.sock"));
    let gone = |e: io::Error| {
        Failed::Refused(format!(
            "no holder answers for {terminal} at {}: {e}",
            socket.display()
        ))
    };
    let mut stream = UnixStream::connect(&socket).map_err(gone)?;
    stream.set_read_timeout(Some(HELLO)).map_err(gone)?;
    let hello = Request::Hello {
        id: RequestId(0),
        body: HelloRequest {
            protocol: Versions::spoken(),
            writer: Some(writer),
        },
    };
    let frame = hello
        .encode()
        .map_err(|e| Failed::Unsendable(e.to_string()))?;
    stream.write_all(&frame).map_err(gone)?;
    let mut decoder = reply_decoder();
    let mut chunk = vec![0u8; READ_AT_ONCE];
    let by = Instant::now() + HELLO;
    while Instant::now() < by {
        match decoder.next_frame() {
            Ok(Some(Reply::Hello { body, .. })) => {
                let ready = stream
                    .set_read_timeout(None)
                    .and_then(|()| stream.set_nonblocking(true));
                after_hello(terminal, ready)?;
                return Ok((stream, body, decoder));
            }
            Ok(Some(Reply::Error { body, .. })) => {
                let spoken = body
                    .protocol
                    .and_then(|p| serde_json::to_value(p).ok())
                    .map_or_else(String::new, |p| {
                        let versions: Vec<&str> = p
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(serde_json::Value::as_str)
                            .collect();
                        format!(" (it speaks {})", versions.join(", "))
                    });
                return Err(Failed::Refused(format!(
                    "the holder of {terminal} refused to attach: {}{spoken}",
                    body.message
                )));
            }
            Ok(Some(_)) => {}
            Ok(None) => match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => decoder.push(chunk.get(..n).unwrap_or_default()),
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(gone(e)),
            },
            Err(malformed) => {
                return Err(Failed::Refused(format!(
                    "the holder of {terminal} answered what this build can't read: {}",
                    malformed.reason()
                )));
            }
        }
    }
    Err(Failed::Refused(format!(
        "the holder of {terminal} didn't say hello"
    )))
}

/// What a failure to set the holder's socket up, once it has said hello, means: the holder has
/// gone, as macOS says by refusing options on a socket whose other end has closed.
fn after_hello(terminal: &str, ready: io::Result<()>) -> Result<(), Failed> {
    ready.map_err(|_| {
        Failed::Refused(format!(
            "{terminal}'s holder hung up: the terminal has ended"
        ))
    })
}

/// Moves keys and output until the attachment ends, leaving what the person should read in
/// `notes`. `None` when the holder hung up.
pub(crate) fn pump(
    stream: &mut UnixStream,
    decoder: &mut FrameDecoder<Reply>,
    direct: &mut Direct,
    watched: Watched<'_>,
    notes: &mut Vec<String>,
) -> io::Result<Option<Ending>> {
    let Watched {
        resizes,
        stops,
        daemon,
    } = watched;
    let recheck = rustix::event::Timespec {
        tv_sec: i64::try_from(RECHECK.as_secs()).unwrap_or(i64::MAX),
        tv_nsec: 0,
    };
    let mut checked = Instant::now();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut chunk = vec![0u8; READ_AT_ONCE];
    let mut todo = direct.start();
    loop {
        for step in todo.drain(..) {
            match step {
                Step::Send(request) => {
                    let frame = request
                        .encode()
                        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e.to_string()))?;
                    write_whole(stream, &frame)?;
                }
                Step::Show(bytes) => stdout.write_all(&bytes)?,
                Step::Clear => tty::clear()?,
                Step::Note(note) => notes.push(note),
                Step::End(ending) => return Ok(Some(ending)),
            }
        }
        stdout.flush()?;
        let mut fds = [
            PollFd::new(&stdin, PollFlags::IN),
            PollFd::new(&*stream, PollFlags::IN),
            PollFd::from_borrowed_fd(resizes.fd(), PollFlags::IN),
            PollFd::from_borrowed_fd(stops.fd(), PollFlags::IN),
        ];
        let wait = direct.writes().then_some(&recheck);
        match poll(&mut fds, wait) {
            Ok(_) => {}
            Err(Errno::INTR) => continue,
            Err(e) => return Err(e.into()),
        }
        let [typed, holder, winch, stop] = fds.map(|fd| fd.revents());
        if direct.writes() && checked.elapsed() >= RECHECK {
            checked = Instant::now();
            if daemon_absent(daemon).is_err() {
                todo.extend(direct.daemon_back());
                continue;
            }
        }
        if !stop.is_empty() {
            return Ok(Some(Ending::Stopped));
        }
        if !winch.is_empty() {
            resizes.clear();
            todo.extend(direct.resized(tty::size()?));
        }
        if !typed.is_empty() {
            match rustix::io::read(&stdin, &mut chunk) {
                Ok(0) => return Ok(Some(Ending::Detached)),
                Ok(n) => todo.extend(direct.keys(chunk.get(..n).unwrap_or_default())),
                Err(Errno::INTR | Errno::AGAIN) => {}
                Err(_) => return Ok(Some(Ending::Detached)),
            }
        }
        if !holder.is_empty() {
            match stream.read(&mut chunk) {
                Ok(0) => return Ok(None),
                Ok(n) => decoder.push(chunk.get(..n).unwrap_or_default()),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => return Ok(None),
            }
            loop {
                match decoder.next_frame() {
                    Ok(Some(reply)) => todo.extend(direct.reply(reply)),
                    Ok(None) => break,
                    Err(malformed) => {
                        return Ok(Some(Ending::Failed(format!(
                            "the holder sent what this build can't read: {}",
                            malformed.reason()
                        ))));
                    }
                }
            }
        }
    }
}

/// A holder's word that its child exited, as the daemon's view says it.
fn program_exited(status: HolderExit) -> Ending {
    Ending::ProgramExited(match status {
        HolderExit::Exited { code } => ExitStatus::Exited { code: code.get() },
        HolderExit::Signalled { signal } => ExitStatus::Signalled { signal },
        HolderExit::Unknown => ExitStatus::Unknown,
    })
}

/// Writes all of `frame` to the non-blocking `stream`, waiting while the holder catches up.
fn write_whole(stream: &mut UnixStream, frame: &[u8]) -> io::Result<()> {
    let mut rest = frame;
    while !rest.is_empty() {
        match stream.write(rest) {
            Ok(0) => return Err(ErrorKind::WriteZero.into()),
            Ok(n) => rest = rest.get(n..).unwrap_or_default(),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                let mut fd = [PollFd::new(&*stream, PollFlags::OUT)];
                match poll(&mut fd, None) {
                    Ok(_) | Err(Errno::INTR) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Dir;
    use bazhen_holder_proto::body::{ErrorBody, ErrorCode};
    use bazhen_holder_proto::request_decoder;
    use serde_json::json;
    use std::os::unix::net::UnixListener;
    use std::thread;

    fn sent(steps: &[Step]) -> Vec<&'static str> {
        steps
            .iter()
            .map(|step| match step {
                Step::Send(Request::Snapshot { .. }) => "snapshot",
                Step::Send(Request::Subscribe { .. }) => "subscribe",
                Step::Send(Request::Input { .. }) => "input",
                Step::Send(Request::Resize { .. }) => "resize",
                Step::Send(_) => "other",
                Step::Show(_) => "show",
                Step::Clear => "clear",
                Step::Note(_) => "note",
                Step::End(_) => "end",
            })
            .collect()
    }

    fn refused(request: &str, code: ErrorCode) -> Reply {
        Reply::Error {
            id: RequestId(9),
            body: ErrorBody::new(request, code, "no"),
        }
    }

    #[test]
    fn types_and_resizes_while_it_holds_the_writer_slot_and_detaches_either_way() {
        let size = Size {
            cols: 100,
            rows: 30,
        };
        let mut writer = Direct::new(true, DetachKeys::default());
        let mut viewer = Direct::new(false, DetachKeys::default());
        assert_eq!(sent(&writer.keys(b"ls")), ["input"]);
        assert_eq!(sent(&writer.resized(size)), ["resize"]);
        assert_eq!(sent(&viewer.keys(b"ls")), ["note"]);
        assert_eq!(sent(&viewer.keys(b"ls")), Vec::<&str>::new());
        assert_eq!(sent(&viewer.resized(size)), Vec::<&str>::new());
        assert_eq!(
            [
                writer.keys(DetachKeys::default().bytes()),
                viewer.keys(DetachKeys::default().bytes())
            ],
            [
                vec![Step::End(Ending::Detached)],
                vec![Step::End(Ending::Detached)]
            ]
        );
    }

    #[test]
    fn stops_typing_once_the_holder_says_another_connection_has_its_input() {
        let mut d = Direct::new(true, DetachKeys::default());
        let told = d.reply(refused("input", ErrorCode::NotWriter));
        assert_eq!(sent(&told), ["note"]);
        assert_eq!(sent(&d.keys(b"x")), Vec::<&str>::new());
        assert_eq!(
            sent(&d.reply(refused("input", ErrorCode::InputFull))),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn shows_output_snapshots_again_after_a_gap_and_ends_when_the_child_exits() {
        let mut d = Direct::new(false, DetachKeys::default());
        let data = Reply::Data {
            offset: serde_json::from_value(json!(5)).unwrap(),
            bytes: b"hi".to_vec(),
        };
        let gap = Reply::Gap(serde_json::from_value(json!({ "from": 0, "to": 9 })).unwrap());
        let exited = Reply::Exited(
            serde_json::from_value(json!({
                "generation": 0,
                "status": { "type": "exited", "code": 0 }
            }))
            .unwrap(),
        );
        assert_eq!(d.reply(data), [Step::Show(b"hi".to_vec())]);
        assert_eq!(sent(&d.reply(gap)), ["clear", "snapshot", "subscribe"]);
        assert_eq!(
            sent(&d.reply(refused("subscribe", ErrorCode::StaleGeneration))),
            ["clear", "snapshot", "subscribe"]
        );
        assert_eq!(
            d.reply(exited),
            [Step::End(Ending::ProgramExited(ExitStatus::Exited {
                code: 0
            }))]
        );
        let signalled = Reply::Exited(
            serde_json::from_value(json!({
                "generation": 1,
                "status": { "type": "signalled", "signal": "SIGHUP" }
            }))
            .unwrap(),
        );
        assert_eq!(
            d.reply(signalled),
            [Step::End(Ending::ProgramExited(ExitStatus::Signalled {
                signal: "SIGHUP".to_owned()
            }))]
        );
        assert!(matches!(
            d.reply(refused("snapshot", ErrorCode::Unavailable)).as_slice(),
            [Step::End(Ending::Failed(m))] if m.starts_with("the holder refused snapshot")
        ));
    }

    /// A holder of `term_x` in `dir` that reads one hello, answers with `answer` made from the
    /// hello's id, and once the client has hung up returns whether it asked to write.
    fn holder(dir: &Dir, answer: fn(RequestId) -> Reply) -> thread::JoinHandle<Option<bool>> {
        let listener = UnixListener::bind(dir.0.join("term_x.sock")).unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut decoder = request_decoder();
            let mut chunk = [0u8; 4096];
            loop {
                if let Some(Request::Hello { id, body }) = decoder.next_frame().unwrap() {
                    stream.write_all(&answer(id).encode().unwrap()).unwrap();
                    // Open until the client hangs up, as a holder stays: macOS refuses to set
                    // options on a socket whose other end has closed.
                    while stream.read(&mut chunk).is_ok_and(|n| n > 0) {}
                    return body.writer;
                }
                let n = stream.read(&mut chunk).unwrap();
                decoder.push(&chunk[..n]);
            }
        })
    }

    fn welcome(id: RequestId) -> Reply {
        let body = serde_json::from_value(json!({
            "version": "1.2", "protocol": ["1.2"], "terminalId": "term_x", "tags": {},
            "generation": 0, "holderPid": 4242, "holderStart": 1, "childPid": 4243,
            "childStart": 1, "exit": null, "size": { "cols": 80, "rows": 24 }, "offset": 0,
            "title": "", "alternate": false, "historyLines": 10, "writer": true
        }))
        .unwrap();
        Reply::Hello { id, body }
    }

    fn unspoken(id: RequestId) -> Reply {
        let body = serde_json::from_value(json!({
            "request": "hello", "code": "no-shared-version", "message": "no major in common",
            "protocol": ["2.0"]
        }))
        .unwrap();
        Reply::Error { id, body }
    }

    #[test]
    fn says_hello_asking_to_write_only_when_told_to() {
        let asking = Dir::new("asking");
        let viewing = Dir::new("viewing");
        let asked = holder(&asking, welcome);
        let (_, hello, _) = open(&asking.0, "term_x", true).unwrap();
        let not_asked = holder(&viewing, welcome);
        open(&viewing.0, "term_x", false).unwrap();
        assert_eq!(
            [asked.join().unwrap(), not_asked.join().unwrap()],
            [Some(true), Some(false)]
        );
        assert!(hello.writer);
    }

    #[test]
    fn says_why_a_holder_it_can_t_speak_to_refused() {
        let dir = Dir::new("unspoken");
        let server = holder(&dir, unspoken);
        let refused = open(&dir.0, "term_x", true).unwrap_err();
        server.join().unwrap();
        assert!(
            matches!(&refused, Failed::Refused(m)
                if m == "the holder of term_x refused to attach: no major in common (it speaks 2.0)"),
            "{refused:?}"
        );
    }

    #[test]
    fn lets_go_of_the_input_for_a_daemon_that_came_back_only_while_typing() {
        let mut writer = Direct::new(true, DetachKeys::default());
        let mut viewer = Direct::new(false, DetachKeys::default());
        assert_eq!(writer.daemon_back(), [Step::End(Ending::Yielded)]);
        assert_eq!(viewer.daemon_back(), []);
    }

    #[test]
    fn takes_a_holder_gone_after_its_hello_for_a_terminal_that_ended() {
        let refused = io::Error::from_raw_os_error(22);
        let gone = after_hello("term_x", Err(refused)).unwrap_err();
        assert!(after_hello("term_x", Ok(())).is_ok());
        assert!(
            matches!(&gone, Failed::Refused(m) if m == "term_x's holder hung up: the terminal has ended"),
            "{gone:?}"
        );
    }

    #[test]
    fn says_no_holder_answers_where_none_listens() {
        let dir = Dir::new("none");
        let none = open(&dir.0, "term_x", true).unwrap_err();
        assert!(
            matches!(&none, Failed::Refused(m) if m.starts_with("no holder answers for term_x")),
            "{none:?}"
        );
    }
}
