//! `bazhen terminals attach <agent|shell|terminal>`: the person's own terminal on one of Bazhen's, through
//! the daemon's socket, as an interactive view like the web app's; or with `--direct`, straight to
//! a terminal's holder when the daemon is down. `Ctrl-\ Ctrl-\` detaches.
//!
//! Its attachment state is public so the fuzz targets in `fuzz/` can reach it.

pub mod attachment;
pub mod direct;
mod link;
pub(crate) mod tty;

use std::io;
use std::path::Path;

use bazhen_client::Caller;
use bazhen_protocol::agents::{Agent, ExitStatus, HarnessId, StateSnapshot};
use bazhen_protocol::id::PROTOCOL_ID;
use bazhen_protocol::ids::is_id;
use serde::Deserialize;

use self::attachment::{Attachment, Ending};
use self::direct::Direct;
use self::link::Outcome;
use crate::args::Parsed;
use crate::call::{ANOTHER_BUILD, CALL, Daemon, Failed};
use crate::out::Out;
use crate::target::{Named, agent_named, named, unknown};
use crate::{Exit, TERMINALS_USAGE};

const NOT_A_TERMINAL: &str =
    "bazhen terminals attach takes over a terminal: run it in one, not from a pipe or a script";

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
            "bazhen terminals attach takes one agent, shell or terminal, and no option but --direct and \
             --home\n{TERMINALS_USAGE}"
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
                     around it: `bazhen terminals attach --direct {target}` can view the terminal"
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
            Err(Failed::Rejected(rejection)) => {
                break Ok(Outcome::Ended(Ending::Failed(rejection.to_string())));
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
    let after = exited_agent(&done, daemon, target);
    Ok(report(done, target, after.as_ref(), &notes, out))
}

/// The agent `target` names, once its program's exit ended the attachment, for what to do next;
/// none for any other ending, a shell or a terminal, or a daemon that can't say. The daemon may
/// not have recorded the exit yet, so only what the exit doesn't change is read from it.
fn exited_agent(done: &Done, daemon: &Daemon, target: &str) -> Option<Agent> {
    if !matches!(done, Done::Ended(Ending::ProgramExited(_))) {
        return None;
    }
    let state: StateSnapshot = daemon.get("/v1/state", CALL).ok()?;
    agent_named(&state, target).cloned()
}

/// Attaches straight to `target`'s holder, in `holders`. It asks to type only when no daemon
/// answers, and says so when it can't.
fn straight(holders: &Path, socket: &Path, target: &str, out: &mut Out) -> Result<Exit, Failed> {
    if !is_id("term", target) {
        out.err("bazhen terminals attach --direct takes a terminal id: names are the daemon's to resolve");
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
    Ok(report(done, target, None, &notes, out))
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
/// once the person's terminal is theirs again. `agent` is what `target` names, once its program's
/// exit ended it.
fn report(
    done: Done,
    target: &str,
    agent: Option<&Agent>,
    notes: &[String],
    out: &mut Out,
) -> Exit {
    for note in notes {
        out.err(&format!("bazhen: {note}"));
    }
    let (said, exit) = match done {
        Done::Ended(Ending::Detached) => (format!("detached from {target}"), Exit::Done),
        Done::Ended(Ending::Yielded) => (
            format!(
                "the daemon is back, so this attachment let go of {target}'s input: \
                 `bazhen terminals attach {target}` goes on through it"
            ),
            Exit::Done,
        ),
        Done::Ended(Ending::Stopped) => (
            format!("stopped by a signal; {target} goes on"),
            Exit::Failed,
        ),
        Done::Ended(Ending::ProgramExited(status)) => {
            (program_exited(target, agent, &status), Exit::Done)
        }
        Done::Ended(Ending::Closed) => (format!("{target}: the terminal closed"), Exit::Done),
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

/// Says that `target`'s program exited, and for an agent, what's kept and what starts it again.
fn program_exited(target: &str, agent: Option<&Agent>, status: &ExitStatus) -> String {
    let how = match status {
        ExitStatus::Exited { code } => format!("code {code}"),
        ExitStatus::Signalled { signal } => format!("signal {signal}"),
        ExitStatus::Unknown => "how is unknown".to_owned(),
    };
    let Some(agent) = agent else {
        return format!("{target}: its program exited ({how})");
    };
    let name = &agent.name;
    let harness = match agent.harness {
        HarnessId::ClaudeCode => "Claude Code",
        HarnessId::Codex => "Codex",
    };
    let close = format!("`bazhen agents close {name}` ends it");
    if agent.resumable {
        format!(
            "{name}: {harness} exited ({how}); its terminal and thread are kept. `bazhen agents \
             respawn {name}` starts it again on the same thread; {close}."
        )
    } else {
        format!(
            "{name}: {harness} exited ({how}); its terminal is kept, but no thread to resume. \
             `bazhen agents relaunch {name} --fresh` starts it on a new one; {close}."
        )
    }
}

/// The terminal `target` names, refused, saying why, when there's none or it can't be attached to.
fn terminal_of(state: &StateSnapshot, target: &str) -> Result<String, String> {
    match named(state, target) {
        None => Err(unknown(target)),
        Some(Named {
            terminal: Some(terminal),
            attachable: true,
            ..
        }) => Ok(terminal),
        Some(Named { unserved: true, .. }) => Err(format!(
            "{target} runs on a holder this build can't speak to: restart it, then attach"
        )),
        Some(_) => Err(format!("{target} has no running terminal to attach to")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The protocol's example agent, as a Codex agent named `name` whose thread may resume.
    fn codex(name: &str, resumable: bool) -> Agent {
        let examples: serde_json::Value = bazhen_protocol::wire::from_slice(include_bytes!(
            "../../../packages/protocol/fixtures/api/StateSnapshot.json"
        ))
        .unwrap();
        let state: StateSnapshot = serde_json::from_value(examples[0]["wire"].clone()).unwrap();
        let mut agent = state.agents[0].clone();
        agent.name = name.to_owned();
        agent.harness = HarnessId::Codex;
        agent.resumable = resumable;
        agent
    }

    #[test]
    fn says_what_an_agents_exit_keeps_and_what_starts_it_again() {
        let resumes = codex("scout", true);
        let fresh = codex("scout", false);
        let code = |code| ExitStatus::Exited { code };
        assert_eq!(
            [
                program_exited("term_x", Some(&resumes), &code(0)),
                program_exited("scout", Some(&fresh), &code(1)),
            ],
            [
                "scout: Codex exited (code 0); its terminal and thread are kept. `bazhen agents \
                 respawn scout` starts it again on the same thread; `bazhen agents close scout` \
                 ends it.",
                "scout: Codex exited (code 1); its terminal is kept, but no thread to resume. \
                 `bazhen agents relaunch scout --fresh` starts it on a new one; `bazhen agents \
                 close scout` ends it.",
            ]
        );
    }

    #[test]
    fn says_only_that_a_shells_or_terminals_program_exited() {
        let signalled = ExitStatus::Signalled {
            signal: "SIGHUP".to_owned(),
        };
        assert_eq!(
            [
                program_exited("build", None, &ExitStatus::Exited { code: 2 }),
                program_exited("term_x", None, &signalled),
                program_exited("term_x", None, &ExitStatus::Unknown),
            ],
            [
                "build: its program exited (code 2)",
                "term_x: its program exited (signal SIGHUP)",
                "term_x: its program exited (how is unknown)",
            ]
        );
    }
}
