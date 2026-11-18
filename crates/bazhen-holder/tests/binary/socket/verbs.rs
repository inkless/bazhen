//! What a connection asks of the terminal through the built binary: input, its size, signals, its
//! tags, its foreground and its screen as text.

use std::collections::BTreeMap;
use std::time::Instant;

use bazhen_holder_proto::body::{
    Cols, Count, ErrorBody, Foreground, Rows, Screen, ScreenRequest, SetTagsRequest, Signal,
    SignalRequest, Size, TagName, TagValue, Tags,
};
use bazhen_holder_proto::{Reply, Request};

use super::{Client, is_ok, serving};
use crate::{DEADLINE, Result, home, start_time, sweep};

impl Client {
    pub(super) fn input(&mut self, bytes: &[u8]) -> Result<()> {
        let id = self.id();
        self.send(&Request::Input {
            id,
            bytes: bytes.to_vec(),
        })
    }

    /// Sends `request` and returns its answer, keeping any output that comes before it in `seen`.
    pub(super) fn ask(&mut self, request: &Request, seen: &mut Vec<u8>) -> Result<Reply> {
        self.send(request)?;
        loop {
            match self.reply()? {
                Reply::Data { bytes, .. } => seen.extend_from_slice(&bytes),
                reply if is_report(&reply) => {}
                Reply::Ok { id, .. }
                | Reply::Error { id, .. }
                | Reply::Foreground { id, .. }
                | Reply::Screen { id, .. }
                    if id != request.id() =>
                {
                    return Err(format!("an answer to {id:?} while waiting for another").into());
                }
                reply => return Ok(reply),
            }
        }
    }

    /// Output until it holds `needle`, appended to `seen`.
    pub(super) fn output_until(&mut self, seen: &mut Vec<u8>, needle: &str) -> Result<()> {
        let deadline = Instant::now() + DEADLINE;
        while !String::from_utf8_lossy(seen).contains(needle) {
            if Instant::now() > deadline {
                return Err(
                    format!("{needle:?} never came: {:?}", String::from_utf8_lossy(seen)).into(),
                );
            }
            match self.reply()? {
                Reply::Data { bytes, .. } => seen.extend_from_slice(&bytes),
                reply if is_report(&reply) => {}
                other => return Err(format!("sent {other:?}").into()),
            }
        }
        Ok(())
    }

    fn resize(&mut self, cols: u64, rows: u64) -> Result<Request> {
        let body = Size {
            cols: Cols::new(cols)?,
            rows: Rows::new(rows)?,
        };
        Ok(Request::Resize {
            id: self.id(),
            body,
        })
    }

    fn signal(&mut self, signal: Signal) -> Request {
        Request::Signal {
            id: self.id(),
            body: SignalRequest { signal },
        }
    }

    fn foreground(&mut self) -> Result<std::result::Result<Foreground, ErrorBody>> {
        let request = Request::Foreground { id: self.id() };
        match self.ask(&request, &mut Vec::new())? {
            Reply::Foreground { body, .. } => Ok(Ok(body)),
            Reply::Error { body, .. } => Ok(Err(body)),
            other => Err(format!("foreground was answered {other:?}").into()),
        }
    }

    fn screen(&mut self, history: u64) -> Result<Screen> {
        let request = Request::Screen {
            id: self.id(),
            body: ScreenRequest {
                history: Count::new(history)?,
            },
        };
        match self.ask(&request, &mut Vec::new())? {
            Reply::Screen { body, .. } => Ok(body),
            other => Err(format!("screen was answered {other:?}").into()),
        }
    }

    /// Output until `exited`, appended to `seen`.
    pub(super) fn output_to_exit(&mut self, seen: &mut Vec<u8>) -> Result<()> {
        loop {
            match self.reply()? {
                Reply::Data { bytes, .. } => seen.extend_from_slice(&bytes),
                Reply::Exited(_) => return Ok(()),
                other => return Err(format!("sent {other:?}").into()),
            }
        }
    }

    /// Sends `bytes` as one `input` and something that is always answered after it, and returns
    /// the error `input` was refused with, if it was.
    fn input_refused(&mut self, bytes: &[u8]) -> Result<Option<ErrorBody>> {
        let input = Request::Input {
            id: self.id(),
            bytes: bytes.to_vec(),
        };
        let marker = Request::SetTags {
            id: self.id(),
            body: SetTagsRequest {
                tags: Tags::new(BTreeMap::new())?,
            },
        };
        self.send(&input)?;
        self.send(&marker)?;
        let mut refused = None;
        loop {
            match self.reply()? {
                Reply::Data { .. } => {}
                Reply::Error { id, body } if id == input.id() => refused = Some(body),
                Reply::Ok { id, .. } if id == marker.id() => return Ok(refused),
                other => return Err(format!("sent {other:?}").into()),
            }
        }
    }

    /// A writer subscribed from the start, once `marker` shows the child is ready.
    pub(super) fn writer_after(&mut self, marker: &str) -> Result<Vec<u8>> {
        assert!(self.hello(true)?.writer, "no writer slot");
        assert!(is_ok(&self.subscribe(Some((0, 0)))?));
        let mut seen = Vec::new();
        self.output_until(&mut seen, marker)?;
        Ok(seen)
    }
}

/// A report of the title, the screen or the size, which comes whenever they change.
fn is_report(reply: &Reply) -> bool {
    matches!(
        reply,
        Reply::Resized(_) | Reply::Title(_) | Reply::Alternate(_)
    )
}

fn code(reply: &Reply) -> Option<&str> {
    match reply {
        Reply::Error { body, .. } => Some(&body.code),
        _ => None,
    }
}

/// A child in raw mode that echoes the next 80,000 bytes it reads, then exits.
const ECHO_BYTES: &str = "stty raw -echo; echo R; exec head -c 80000";

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_writers_input_reaches_the_child_in_order() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("input").unwrap();
    let (_holder, socket) = serving(&home, &["sh", "-c", ECHO_BYTES]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    let mut seen = writer.writer_after("R").unwrap();
    let sent: Vec<u8> = (0..80_000u32).map(|i| b'a' + (i % 26) as u8).collect();
    for frame in sent.chunks(7_000) {
        writer.input(frame).unwrap();
    }
    writer.output_to_exit(&mut seen).unwrap();
    assert!(seen.ends_with(&sent), "the child read other input");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn takes_input_and_resizes_only_from_the_writer() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("notwriter").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    assert!(writer.hello(true).unwrap().writer);
    let mut other = Client::connect(&socket).unwrap();
    assert!(!other.hello(true).unwrap().writer);
    let input = Request::Input {
        id: other.id(),
        bytes: b"x".to_vec(),
    };
    assert_eq!(other.refused(&input).unwrap().code, "not-writer");
    let resize = other.resize(100, 30).unwrap();
    assert_eq!(other.refused(&resize).unwrap().code, "not-writer");
    let resize = writer.resize(100, 30).unwrap();
    assert!(
        writer
            .ask(&resize, &mut Vec::new())
            .map(|r| code(&r).is_none())
            .unwrap()
    );
}

/// A holder serving a child in raw mode that never reads, and its writer, whose input has filled
/// the queue: the frame that didn't fit is refused, and returned.
fn stuck(home: &crate::Home) -> Result<(crate::Started, std::path::PathBuf, Client, ErrorBody)> {
    let script = "stty raw -echo; echo R; sleep 30";
    let (holder, socket) = serving(home, &["sh", "-c", script])?;
    let mut writer = Client::connect(&socket)?;
    writer.writer_after("R")?;
    let frame = vec![b'x'; 64 << 10];
    for _ in 0..64 {
        if let Some(refused) = writer.input_refused(&frame)? {
            return Ok((holder, socket, writer, refused));
        }
    }
    Err("4 MiB taken for a program that reads none".into())
}

/// A program that stops reading fills the queue, and the writer is told: the frame that didn't
/// fit, and every one after it until the program reads, even one that would fit.
#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn input_for_a_program_that_stops_reading_is_refused_until_it_reads() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("full").unwrap();
    let (_holder, socket, mut writer, refused) = stuck(&home).unwrap();
    assert_eq!(refused.code, "input-full");
    assert!(
        refused.message.contains("until the queue drains"),
        "{refused:?}"
    );
    let after = writer
        .input_refused(b"y")
        .unwrap()
        .expect("a small frame taken after one refused");
    assert_eq!(after.code, "input-full");
    let mut other = Client::connect(&socket).unwrap();
    assert_eq!(other.hello(false).unwrap().exit, None);
}

/// How long input stays stuck before the holder is looked at: well past the 2 CPU-seconds a test
/// holder may use, so one that spun on the master while it can't be written would be dead of
/// `SIGXCPU`. The time is what this measures, so it is waited out rather than polled for.
const STUCK_FOR: std::time::Duration = std::time::Duration::from_secs(5);

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_holder_whose_input_is_stuck_stays_idle() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("idle").unwrap();
    let (mut holder, socket, _writer, _) = stuck(&home).unwrap();
    std::thread::sleep(STUCK_FOR);
    assert_eq!(holder.state(), "still runs");
    let mut other = Client::connect(&socket).unwrap();
    assert_eq!(other.hello(false).unwrap().exit, None);
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn input_signals_and_foreground_after_the_childs_exit_are_refused_exited() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("after").unwrap();
    let (_holder, socket) = serving(&home, &["true"]).unwrap();
    let deadline = Instant::now() + DEADLINE;
    // Watched as a reader, so no connection left over from the wait still holds the writer when
    // the one the requests go through asks for it.
    while Client::connect(&socket)
        .unwrap()
        .hello(false)
        .unwrap()
        .exit
        .is_none()
    {
        assert!(Instant::now() < deadline, "the child never exited");
    }
    let mut writer = loop {
        let mut client = Client::connect(&socket).unwrap();
        if client.hello(true).unwrap().writer {
            break client;
        }
        assert!(
            Instant::now() < deadline,
            "no connection was made the writer"
        );
    };
    let input = Request::Input {
        id: writer.id(),
        bytes: b"x".to_vec(),
    };
    assert_eq!(writer.refused(&input).unwrap().code, "exited");
    let signal = writer.signal(Signal::Sigkill);
    assert_eq!(writer.refused(&signal).unwrap().code, "exited");
    assert_eq!(writer.foreground().unwrap().unwrap_err().code, "exited");
}

/// Counts `SIGWINCH` and, for each byte it reads, prints the count and its size. Raw, so each
/// byte is read as it comes; `q` ends it.
const WINCH_COUNTER: &str = r#"$| = 1; my $n = 0; $SIG{WINCH} = sub { $n++ }; alarm 20;
system("stty raw -echo"); print "R\n";
while (1) { my $r = sysread(STDIN, my $b, 1); next unless defined $r; last if !$r || $b eq "q";
  my $size = `stty size`; $size =~ s/\s+$//; print "winch $n size $size;\n"; }"#;

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_storm_of_resizes_costs_one_sigwinch_and_a_zero_size_is_clamped() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("resize").unwrap();
    let (_holder, socket) = serving(&home, &["perl", "-e", WINCH_COUNTER]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    let mut seen = writer.writer_after("R").unwrap();
    let mut storm = Vec::new();
    for cols in 10..110 {
        storm.extend(writer.resize(cols, 20).unwrap().encode().unwrap());
    }
    storm.extend(writer.resize(120, 40).unwrap().encode().unwrap());
    std::io::Write::write_all(&mut writer.stream, &storm).unwrap();
    let mut answered = 0;
    while answered < 101 {
        match writer.reply().unwrap() {
            Reply::Data { bytes, .. } => seen.extend_from_slice(&bytes),
            reply if is_report(&reply) => {}
            reply if code(&reply).is_none() => answered += 1,
            other => panic!("answered {other:?}"),
        }
    }
    writer.input(b"x").unwrap();
    writer.output_until(&mut seen, "size 40 120;").unwrap();
    let text = String::from_utf8_lossy(&seen).into_owned();
    let winches: u32 = text
        .split("winch ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .and_then(|n| n.parse().ok())
        .unwrap();
    assert!(
        (1..=3).contains(&winches),
        "{winches} SIGWINCHes for one storm"
    );
    let mut zero = Vec::new();
    let request = writer.resize(0, 0).unwrap();
    writer.ask(&request, &mut zero).unwrap();
    writer.input(b"x").unwrap();
    writer.output_until(&mut zero, "size 1 1;").unwrap();
    let size = Client::connect(&socket).unwrap().hello(false).unwrap().size;
    assert_eq!((size.cols.get(), size.rows.get()), (1, 1));
    writer.input(b"q").unwrap();
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn each_signal_reaches_the_child_and_ends_it_by_that_signal() {
    bazhen_test_signal::require_sandbox().unwrap();
    for signal in Signal::ALL {
        sweep().unwrap();
        let home = home("signal").unwrap();
        let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
        let mut client = Client::connect(&socket).unwrap();
        client.hello(false).unwrap();
        assert!(is_ok(&client.subscribe(None).unwrap()));
        let request = client.signal(signal);
        let answer = client.ask(&request, &mut Vec::new()).unwrap();
        assert!(code(&answer).is_none(), "{answer:?}");
        match client.reply().unwrap() {
            Reply::Exited(exited) => assert_eq!(
                exited.status,
                bazhen_holder_proto::body::ExitStatus::Signalled {
                    signal: signal.as_str().to_owned()
                }
            ),
            other => panic!("sent {other:?}"),
        }
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn set_tags_changes_what_hello_echoes() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("tags").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    let mut tags = BTreeMap::new();
    tags.insert(TagName::new("agent").unwrap(), TagValue::new("a1").unwrap());
    let tags = Tags::new(tags).unwrap();
    let request = Request::SetTags {
        id: client.id(),
        body: SetTagsRequest { tags: tags.clone() },
    };
    assert!(code(&client.ask(&request, &mut Vec::new()).unwrap()).is_none());
    assert_eq!(
        Client::connect(&socket).unwrap().hello(false).unwrap().tags,
        tags
    );
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_foreground_of_a_terminal_running_only_its_child_is_the_childs_group() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("fgchild").unwrap();
    let (_holder, socket) = serving(&home, &["sleep", "30"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    let hello = client.hello(false).unwrap();
    let foreground = client.foreground().unwrap().unwrap();
    assert_eq!(
        (foreground.pgid, foreground.pgid_start),
        (hello.child_pid, hello.child_start)
    );
    assert_eq!(
        (foreground.child_pid, foreground.child_start),
        (hello.child_pid, hello.child_start)
    );
}

/// Forks a job that takes the terminal's foreground in a group of its own and says so. With
/// `stay`, the job starts a second after the child, so the two starts differ. With `leave`, the job
/// forks a member into its group and exits, and is reaped: a group whose leader is gone holds the
/// terminal.
const JOB: &str = r#"use POSIX; $| = 1; alarm 20; my $how = shift;
select(undef, undef, undef, 1.2) if $how eq "stay";
my $job = fork // die; if (!$job) { setpgid(0, 0); $SIG{TTOU} = "IGNORE";
  tcsetpgrp(0, $$) or die "tcsetpgrp: $!";
  if ($how eq "leave") { my $member = fork // die; if (!$member) { sleep 20; POSIX::_exit(0) }
    POSIX::_exit(0) }
  print "fg $$;\n"; sleep 20; POSIX::_exit(0) }
if ($how eq "leave") { waitpid($job, 0); print "gone $job;\n" } sleep 20;"#;

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn the_foreground_is_a_jobs_group_with_when_its_leader_started() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("fgjob").unwrap();
    let (_holder, socket) = serving(&home, &["perl", "-e", JOB, "stay"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    let mut seen = Vec::new();
    client.output_until(&mut seen, ";").unwrap();
    let text = String::from_utf8_lossy(&seen).into_owned();
    let job: u64 = text
        .split("fg ")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .and_then(|n| n.parse().ok())
        .unwrap();
    let foreground = client.foreground().unwrap().unwrap();
    assert_eq!(foreground.pgid.get(), job);
    assert_ne!(foreground.pgid_start, foreground.child_start);
    let started = start_time(u32::try_from(job).unwrap()).unwrap();
    assert_eq!(foreground.pgid_start.get(), started);
}

/// A job that takes the terminal's foreground, puts a helper in a group of its own, then joins that
/// group: the terminal still names the job's old group, which has no member left, while the job's
/// pid, the old group's number, is alive and in another group.
const STALE: &str = r#"use POSIX; $| = 1; alarm 20;
my $job = fork // die; if (!$job) { setpgid(0, 0); $SIG{TTOU} = "IGNORE";
  tcsetpgrp(0, $$) or die "tcsetpgrp: $!";
  my $helper = fork // die; if (!$helper) { sleep 20; POSIX::_exit(0) }
  setpgid($helper, $helper) or die "setpgid helper: $!";
  setpgid(0, $helper) or die "setpgid: $!";
  print "moved $$;\n"; sleep 20; POSIX::_exit(0) }
sleep 20;"#;

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_foreground_group_with_no_member_left_is_refused_failed_though_its_number_is_a_live_pid() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("fgstale").unwrap();
    let (_holder, socket) = serving(&home, &["perl", "-e", STALE]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    client.output_until(&mut Vec::new(), "moved").unwrap();
    let refused = client.foreground().unwrap().unwrap_err();
    assert_eq!(refused.code, "failed", "{refused:?}");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_foreground_group_whose_leader_has_exited_is_refused_failed() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("fgleft").unwrap();
    let (_holder, socket) = serving(&home, &["perl", "-e", JOB, "leave"]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    assert!(is_ok(&client.subscribe(Some((0, 0))).unwrap()));
    client.output_until(&mut Vec::new(), "gone").unwrap();
    let refused = client.foreground().unwrap().unwrap_err();
    assert_eq!(refused.code, "failed");
    assert!(refused.message.contains("leader has exited"), "{refused:?}");
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_reader_reads_the_screen_as_text_without_its_colours() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("screen").unwrap();
    let script = "printf '\\033[1;31mbold red\\033[0m plain'; exec sleep 30";
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    assert!(!client.hello(false).unwrap().writer);
    let deadline = Instant::now() + DEADLINE;
    let mut screen = client.screen(0).unwrap();
    while !screen.text().contains("plain") {
        assert!(
            Instant::now() < deadline,
            "the output never reached the screen"
        );
        screen = client.screen(0).unwrap();
    }
    assert_eq!(
        (screen.text(), screen.history().get()),
        ("bold red plain\n", 0)
    );
}
