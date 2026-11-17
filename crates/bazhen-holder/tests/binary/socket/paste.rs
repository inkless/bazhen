//! A `paste` through the built binary: typed only into a program that would read it as text now,
//! and otherwise refused naming the check that failed, never the text.

use std::io::Write as _;
use std::path::Path;

use bazhen_holder_proto::body::{Generation, PasteRequest};
use bazhen_holder_proto::{Reply, Request, RequestId};

use super::{Client, is_ok, serving};
use crate::{Result, home, sweep};

/// The text every test pastes, which no answer and no log line may hold.
const TEXT: &str = "echo pasted";

type Answer = std::result::Result<(), (String, String)>;

fn refused(code: &str, message: &str) -> Answer {
    Err((code.to_owned(), message.to_owned()))
}

impl Client {
    /// Pastes `TEXT`, keeping output that comes before the answer in `seen`; refused, the error's
    /// code and message.
    fn paste(&mut self, generation: u64, brackets: bool, seen: &mut Vec<u8>) -> Result<Answer> {
        let request = Request::Paste {
            id: self.id(),
            body: PasteRequest::new(Generation::new(generation)?, TEXT.to_owned(), brackets)?,
        };
        match self.ask(&request, seen)? {
            Reply::Ok { body, .. } if body.request == "paste" => Ok(Ok(())),
            Reply::Error { body, .. } => Ok(Err((body.code, body.message))),
            other => Err(format!("paste was answered {other:?}").into()),
        }
    }

    /// A reader subscribed from the start, once `marker` shows the child is ready.
    fn reader_after(&mut self, marker: &str) -> Result<Vec<u8>> {
        self.hello(false)?;
        assert!(is_ok(&self.subscribe(Some((0, 0)))?));
        let mut seen = Vec::new();
        self.output_until(&mut seen, marker)?;
        Ok(seen)
    }
}

/// Whether the holder's log holds the pasted text.
fn logged_the_text(socket: &Path) -> Result<bool> {
    Ok(std::fs::read_to_string(socket.with_extension("log"))?.contains(TEXT))
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_raw_reader_takes_a_paste_marked_when_asked_or_when_it_has_bracketed_paste_on() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    for (name, mode, brackets, marks) in [
        ("plain", "", false, ("", "")),
        ("asked", "", true, ("\x1b[200~", "\x1b[201~")),
        ("mode", r"\033[?2004h", false, ("\x1b[200~", "\x1b[201~")),
    ] {
        let home = home(&format!("paste-{name}")).unwrap();
        let script = format!("stty -icanon -echo; printf '{mode}R'; exec cat");
        let (_holder, socket) = serving(&home, &["sh", "-c", &script]).unwrap();
        let mut reader = Client::connect(&socket).unwrap();
        let mut seen = reader.reader_after("R").unwrap();
        assert_eq!(
            reader.paste(0, brackets, &mut seen).unwrap(),
            Ok(()),
            "{name}"
        );
        reader.output_until(&mut seen, TEXT).unwrap();
        let read = |seen: &[u8]| {
            String::from_utf8_lossy(seen)
                .split_once('R')
                .unwrap()
                .1
                .to_owned()
        };
        assert_eq!(read(&seen).split(TEXT).next(), Some(marks.0), "{name}");
        reader
            .output_until(&mut seen, &format!("{TEXT}{}", marks.1))
            .unwrap();
        assert_eq!(
            read(&seen),
            format!("{}{TEXT}{}", marks.0, marks.1),
            "{name}"
        );
        assert!(!logged_the_text(&socket).unwrap(), "{name}");
    }
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_program_reading_whole_lines_is_not_ready_and_is_typed_nothing() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-lines").unwrap();
    let script = r#"stty -echo; printf R; read line; printf '[%s]' "$line""#;
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    let mut seen = writer.writer_after("R").unwrap();
    assert_eq!(
        writer.paste(0, true, &mut seen).unwrap(),
        refused(
            "not-ready",
            "the program reads whole lines, not at a line editor"
        )
    );
    writer.input(b"typed\n").unwrap();
    writer.output_to_exit(&mut seen).unwrap();
    assert!(String::from_utf8_lossy(&seen).ends_with("[typed]"));
    assert!(!logged_the_text(&socket).unwrap());
}

/// Leaves canonical mode, then runs a job that takes the terminal's foreground, as a shell running
/// a command does.
const JOB: &str = r#"use POSIX; $| = 1; alarm 20;
system("stty", "-icanon", "-echo") == 0 or die "stty";
my $job = fork // die; if (!$job) { setpgid(0, 0); $SIG{TTOU} = "IGNORE";
  tcsetpgrp(0, $$) or die "tcsetpgrp: $!"; print "fg;"; sleep 20; POSIX::_exit(0) }
sleep 20;"#;

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_child_whose_job_holds_the_foreground_is_not_ready() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-job").unwrap();
    let (_holder, socket) = serving(&home, &["perl", "-e", JOB]).unwrap();
    let mut reader = Client::connect(&socket).unwrap();
    let mut seen = reader.reader_after("fg;").unwrap();
    assert_eq!(
        reader.paste(0, true, &mut seen).unwrap(),
        refused(
            "not-ready",
            "another process group holds the terminal's foreground"
        )
    );
    assert!(!logged_the_text(&socket).unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn input_not_yet_read_makes_a_paste_not_ready() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-ahead").unwrap();
    let script = "stty -icanon -echo; printf R; exec sleep 20";
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    let mut seen = writer.writer_after("R").unwrap();
    writer.input(b"x").unwrap();
    // Pasted at once, the byte may still be in the holder's queue; once written it is unread.
    let queued = refused(
        "not-ready",
        "input the holder queued for the program is still unwritten",
    );
    let answer = std::iter::repeat_with(|| writer.paste(0, true, &mut seen).unwrap())
        .take(100)
        .find(|answer| *answer != queued);
    assert_eq!(
        answer,
        Some(refused("not-ready", "input typed ahead waits unread"))
    );
    assert!(!logged_the_text(&socket).unwrap());
}

/// Raw, asks the terminal for its attributes, and prints back what it reads: the reply.
const ASKS_DA1: &str = r"stty -icanon -echo; printf '\033[c'; exec cat";

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_paste_right_after_the_program_read_the_holders_reply_is_typed() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-reply").unwrap();
    let (_holder, socket) = serving(&home, &["sh", "-c", ASKS_DA1]).unwrap();
    let mut reader = Client::connect(&socket).unwrap();
    // The reply starts `ESC [ ?`; the query doesn't. Once cat prints it back, nothing waits unread.
    let mut seen = reader.reader_after("\x1b[?").unwrap();
    assert_eq!(reader.paste(0, false, &mut seen).unwrap(), Ok(()));
    reader.output_until(&mut seen, TEXT).unwrap();
    assert!(!logged_the_text(&socket).unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_paste_for_another_generation_or_an_exited_child_is_refused() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-gone").unwrap();
    let script = "stty -icanon -echo; printf R; head -c 1 >/dev/null";
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut writer = Client::connect(&socket).unwrap();
    let mut seen = writer.writer_after("R").unwrap();
    assert_eq!(
        writer.paste(1, true, &mut seen).unwrap(),
        refused(
            "stale-generation",
            "the paste is for a child a respawn has replaced"
        )
    );
    writer.input(b"x").unwrap();
    writer.output_to_exit(&mut seen).unwrap();
    assert_eq!(
        writer.paste(0, true, &mut seen).unwrap(),
        refused("exited", "the child has exited")
    );
    assert_eq!(String::from_utf8_lossy(&seen), "R");
    assert!(!logged_the_text(&socket).unwrap());
}

#[test]
#[ignore = "signals processes; runs in pnpm test:real rust"]
fn a_paste_holding_a_control_character_is_invalid_and_its_connection_hung_up() {
    bazhen_test_signal::require_sandbox().unwrap();
    sweep().unwrap();
    let home = home("paste-key").unwrap();
    let script = "stty -icanon -echo; printf R; exec sleep 20";
    let (_holder, socket) = serving(&home, &["sh", "-c", script]).unwrap();
    let mut client = Client::connect(&socket).unwrap();
    client.hello(false).unwrap();
    let body = format!(r#"{{"generation":0,"text":"{TEXT}\u0003","brackets":true}}"#);
    let length = u32::try_from(body.len() + 5).unwrap().to_be_bytes();
    let frame = [&length[..], &[0x48], &4u32.to_be_bytes(), body.as_bytes()].concat();
    client.stream.write_all(&frame).unwrap();
    match client.reply().unwrap() {
        Reply::Error { id, body } => {
            assert_eq!((id, body.code.as_str()), (RequestId(4), "invalid"));
            assert!(!body.message.contains(TEXT), "{}", body.message);
        }
        other => panic!("answered {other:?}"),
    }
    assert!(client.hangs_up().unwrap());
    assert!(!logged_the_text(&socket).unwrap());
}
