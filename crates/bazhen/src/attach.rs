//! `bazhen attach <agent|shell|terminal>`: the person's own terminal on one of Bazhen's, through
//! the daemon's socket, as an interactive view like the web app's; or with `--direct`, straight to
//! a terminal's holder when the daemon is down. `Ctrl-\ Ctrl-\` detaches.
//!
//! Its attachment state is public so the fuzz targets in `fuzz/` can reach it.

pub mod attachment;
pub mod direct;
mod link;
mod tty;

use std::io;
use std::path::Path;

use bazhen_client::Caller;
use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::id::PROTOCOL_ID;
use bazhen_protocol::ids::is_id;
use serde::Deserialize;

use self::attachment::{Attachment, Ending};
use self::direct::Direct;
use self::link::Outcome;
use crate::args::Parsed;
use crate::call::{ANOTHER_BUILD, CALL, Daemon, Failed};
use crate::out::Out;
use crate::{Exit, USAGE};

const NOT_A_TERMINAL: &str =
    "bazhen attach takes over a terminal: run it in one, not from a pipe or a script";

/// All attaching reads of `/v1/health`, so a daemon of another build still answers it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answering {
    protocol_id: String,
}

/// How an attachment came to an end, by either path.
enum Done {
    Ended(Ending),
    /// The daemon stopped answering.
    DaemonGone,
    /// The holder hung up.
    HolderGone,
    Broke(io::Error),
}

/// Attaches to the terminal `p` names, through the daemon at `socket` or, with `--direct` or no
/// daemon to answer, straight to its holder beside it.
pub(crate) fn run(
    p: &Parsed,
    socket: &Path,
    daemon: &Daemon,
    out: &mut Out,
) -> Result<Exit, Failed> {
    let stray: Vec<&str> = p
        .given()
        .filter(|o| *o != "home" && *o != "direct")
        .collect();
    let (Some(target), None, true) = (p.word(1), p.word(2), stray.is_empty()) else {
        out.err(&format!(
            "bazhen attach takes one agent, shell or terminal, and no option but --direct and \
             --home\n{USAGE}"
        ));
        return Ok(Exit::Usage);
    };
    let holders = socket.parent().unwrap_or(socket).join("holders");
    if p.has("direct") {
        return straight(&holders, socket, target, out);
    }
    match daemon.get::<Answering>("/v1/health", CALL) {
        Ok(health) if health.protocol_id != PROTOCOL_ID => {
            out.err(ANOTHER_BUILD);
            return Ok(Exit::Failed);
        }
        Ok(_) => {}
        Err(Failed::NotRunning) if is_id("term", target) => {
            if let Err(why) = direct::daemon_absent(socket) {
                out.err(&format!(
                    "the daemon doesn't answer, but may be running ({why}), so attach won't go \
                     around it: `bazhen attach --direct {target}` can view the terminal"
                ));
                return Ok(Exit::NotRunning);
            }
            out.err("bazhen is not running: attaching straight to the terminal's holder");
            return straight(&holders, socket, target, out);
        }
        Err(e) => return Err(e),
    }
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let terminal = match terminal_of(&state, target) {
        Ok(terminal) => terminal,
        Err(why) => {
            out.err(&why);
            return Ok(Exit::Failed);
        }
    };
    if !tty::interactive() {
        out.err(NOT_A_TERMINAL);
        return Ok(Exit::Failed);
    }
    let caller = Caller::from_env();
    let size =
        tty::size().map_err(|e| Failed::Refused(format!("can't read the terminal's size: {e}")))?;
    let mut ws = link::open(socket, &terminal, &caller, &Attachment::hello(size))?;
    let (resizes, stops, raw) = take_over()?;
    let mut notes = Vec::new();
    let mut rejoined = false;
    let outcome = loop {
        let mut attachment = Attachment::sized(tty::size().unwrap_or(size));
        let outcome = link::pump(&mut ws, &mut attachment, &resizes, &stops, &mut notes);
        if !matches!(outcome, Ok(Outcome::Ended(Ending::Evicted))) || rejoined {
            break outcome;
        }
        rejoined = true;
        let size = tty::size().unwrap_or(size);
        match link::open(socket, &terminal, &caller, &Attachment::hello(size)) {
            Ok(again) => ws = again,
            Err(Failed::NotRunning) => break Ok(Outcome::Gone),
            Err(Failed::Refused(why) | Failed::Unsendable(why)) => {
                break Ok(Outcome::Ended(Ending::Failed(why)));
            }
        }
        if let Err(e) = tty::clear() {
            break Err(e);
        }
    };
    drop(raw);
    let done = match outcome {
        Ok(Outcome::Ended(ending)) => Done::Ended(ending),
        Ok(Outcome::Gone) => Done::DaemonGone,
        Err(e) => Done::Broke(e),
    };
    Ok(report(done, target, &notes, out))
}

/// Attaches straight to `target`'s holder, in `holders`. It asks to type only when no daemon
/// answers, and says so when it can't.
fn straight(holders: &Path, socket: &Path, target: &str, out: &mut Out) -> Result<Exit, Failed> {
    if !is_id("term", target) {
        out.err("bazhen attach --direct takes a terminal id: names are the daemon's to resolve");
        return Ok(Exit::Usage);
    }
    if !tty::interactive() {
        out.err(NOT_A_TERMINAL);
        return Ok(Exit::Failed);
    }
    // Only a daemon that is surely not there can't be holding the terminal's input: one that is
    // slow, or whose socket can't be read, may be, so the attachment never types behind it.
    let absent = direct::daemon_absent(socket);
    let asks = absent.is_ok();
    let (mut stream, hello, mut decoder) = direct::open(holders, target, asks)?;
    let mut notes = Vec::new();
    if let Err(why) = absent {
        notes.push(format!(
            "a daemon may be running ({why}), so --direct only viewed the terminal: attach \
             without it to type"
        ));
    } else if !hello.writer {
        notes.push(
            "another connection holds the terminal's input, so this attachment only viewed it"
                .to_owned(),
        );
    }
    let mut direct = Direct::new(asks && hello.writer);
    let (resizes, stops, raw) = take_over()?;
    let outcome = direct::pump(
        &mut stream,
        &mut decoder,
        &mut direct,
        direct::Watched {
            resizes: &resizes,
            stops: &stops,
            daemon: socket,
        },
        &mut notes,
    );
    drop(raw);
    let done = match outcome {
        Ok(Some(ending)) => Done::Ended(ending),
        Ok(None) => Done::HolderGone,
        Err(e) => Done::Broke(e),
    };
    Ok(report(done, target, &notes, out))
}

/// The person's terminal, raw, with its resizes and the signals to stop watched.
fn take_over() -> Result<(tty::Wakeups, tty::Stops, tty::Raw), Failed> {
    let watching = |e: io::Error| Failed::Refused(format!("can't watch for signals: {e}"));
    let resizes = tty::Wakeups::resizes().map_err(watching)?;
    let stops = tty::Stops::watch().map_err(watching)?;
    let raw = tty::Raw::enter()
        .map_err(|e| Failed::Refused(format!("can't take over the terminal: {e}")))?;
    Ok((resizes, stops, raw))
}

/// Says how the attachment to `target` ended, with what the daemon or holder said on the way,
/// once the person's terminal is theirs again.
fn report(done: Done, target: &str, notes: &[String], out: &mut Out) -> Exit {
    for note in notes {
        out.err(&format!("bazhen: {note}"));
    }
    let (said, exit) = match done {
        Done::Ended(Ending::Detached) => (format!("detached from {target}"), Exit::Done),
        Done::Ended(Ending::Yielded) => (
            format!(
                "the daemon is back, so this attachment let go of {target}'s input: \
                 `bazhen attach {target}` goes on through it"
            ),
            Exit::Done,
        ),
        Done::Ended(Ending::Stopped) => (
            format!("stopped by a signal; {target} goes on"),
            Exit::Failed,
        ),
        Done::Ended(Ending::Exited) => (format!("{target}: the terminal exited"), Exit::Done),
        Done::Ended(Ending::Evicted) => (
            "fell behind the terminal's output twice in a row: attach again".to_owned(),
            Exit::Failed,
        ),
        Done::Ended(Ending::Lost) => (format!("the daemon lost {target}'s terminal"), Exit::Failed),
        Done::Ended(Ending::Failed(why)) => (why, Exit::Failed),
        Done::DaemonGone => ("the daemon stopped answering".to_owned(), Exit::NotRunning),
        Done::HolderGone => (
            format!("{target}'s holder hung up: the terminal has ended"),
            Exit::Failed,
        ),
        Done::Broke(e) => (format!("the attachment broke: {e}"), Exit::Failed),
    };
    out.err(&said);
    exit
}

/// The terminal `target` names: an agent's or a shell's, by its name or id, or a terminal by its
/// own id. Refused, saying why, when there's none or it can't be attached to.
fn terminal_of(state: &StateSnapshot, target: &str) -> Result<String, String> {
    let agent = state.agents.iter().find(|a| {
        a.id.as_str() == target
            || a.name == target
            || a.terminal_id.as_ref().is_some_and(|t| t.as_str() == target)
    });
    let found = agent
        .map(|a| {
            (
                a.terminal_id.as_ref(),
                a.attach_command.is_some(),
                a.needs_restart.as_ref(),
            )
        })
        .or_else(|| {
            state
                .shells
                .iter()
                .find(|s| s.id.as_str() == target || s.name.as_deref() == Some(target))
                .map(|s| {
                    (
                        Some(&s.id),
                        s.attach_command.is_some(),
                        s.needs_restart.as_ref(),
                    )
                })
        });
    match found {
        None => Err(format!("no agent, shell or terminal is named {target}")),
        Some((Some(terminal), true, _)) => Ok(terminal.as_str().to_owned()),
        Some((_, _, Some(restart))) if !restart.served => Err(format!(
            "{target} runs on a holder this build can't speak to: restart it, then attach"
        )),
        Some(_) => Err(format!("{target} has no running terminal to attach to")),
    }
}
