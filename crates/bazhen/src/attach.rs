//! `bazhen attach <agent|shell|terminal>`: the person's own terminal on one of Bazhen's, through
//! the daemon's socket, as an interactive view like the web app's. `Ctrl-\ Ctrl-\` detaches.
//!
//! Its attachment state is public so the fuzz targets in `fuzz/` can reach it.

pub mod attachment;
mod link;
mod tty;

use std::path::Path;

use bazhen_client::Caller;
use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::id::PROTOCOL_ID;
use serde::Deserialize;

use self::attachment::{Attachment, Ending};
use self::link::Outcome;
use crate::args::Parsed;
use crate::call::{ANOTHER_BUILD, CALL, Daemon, Failed};
use crate::out::Out;
use crate::{Exit, USAGE};

/// All attaching reads of `/v1/health`, so a daemon of another build still answers it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answering {
    protocol_id: String,
}

/// Attaches to the terminal `p` names, through the daemon at `socket`.
pub(crate) fn run(
    p: &Parsed,
    socket: &Path,
    daemon: &Daemon,
    out: &mut Out,
) -> Result<Exit, Failed> {
    let stray: Vec<&str> = p.given().filter(|o| *o != "home").collect();
    let (Some(target), None, true) = (p.word(1), p.word(2), stray.is_empty()) else {
        out.err(&format!(
            "bazhen attach takes one agent, shell or terminal, and no option but --home\n{USAGE}"
        ));
        return Ok(Exit::Usage);
    };
    let health: Answering = daemon.get("/v1/health", CALL)?;
    if health.protocol_id != PROTOCOL_ID {
        out.err(ANOTHER_BUILD);
        return Ok(Exit::Failed);
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
        out.err("bazhen attach takes over a terminal: run it in one, not from a pipe or a script");
        return Ok(Exit::Failed);
    }
    let caller = Caller::from_env();
    let size =
        tty::size().map_err(|e| Failed::Refused(format!("can't read the terminal's size: {e}")))?;
    let mut ws = link::open(socket, &terminal, &caller, &Attachment::hello(size))?;
    let watching = |e: std::io::Error| Failed::Refused(format!("can't watch for signals: {e}"));
    let resizes = tty::Wakeups::resizes().map_err(watching)?;
    let stops = tty::Stops::watch().map_err(watching)?;
    let raw = tty::Raw::enter()
        .map_err(|e| Failed::Refused(format!("can't take over the terminal: {e}")))?;
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
    for note in &notes {
        out.err(&format!("bazhen: {note}"));
    }
    Ok(match outcome {
        Ok(Outcome::Ended(Ending::Detached)) => {
            out.err(&format!("detached from {target}"));
            Exit::Done
        }
        Ok(Outcome::Ended(Ending::Stopped)) => {
            out.err(&format!("stopped by a signal; {target} goes on"));
            Exit::Failed
        }
        Ok(Outcome::Ended(Ending::Exited)) => {
            out.err(&format!("{target}: the terminal exited"));
            Exit::Done
        }
        Ok(Outcome::Ended(Ending::Evicted)) => {
            out.err("fell behind the terminal's output twice in a row: attach again");
            Exit::Failed
        }
        Ok(Outcome::Ended(Ending::Lost)) => {
            out.err(&format!("the daemon lost {target}'s terminal"));
            Exit::Failed
        }
        Ok(Outcome::Ended(Ending::Failed(why))) => {
            out.err(&why);
            Exit::Failed
        }
        Ok(Outcome::Gone) => {
            out.err("the daemon stopped answering");
            Exit::NotRunning
        }
        Err(e) => {
            out.err(&format!("the attachment broke: {e}"));
            Exit::Failed
        }
    })
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
