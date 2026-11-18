//! `terminals screen`: a terminal's screen as text, read through the daemon without its input.

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::terminals::TerminalScreen;

use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::encode_uri_component;
use crate::lifecycle::{answer, pretty};
use crate::out::Out;
use crate::target::{named, unknown};
use crate::tasks::{Step, Stop, usage};
use crate::{Exit, TERMINALS_USAGE};

/// The most rows of history a read may ask for, as the daemon takes them.
const HISTORY_MAX: u32 = 10_000;

/// Prints the screen of the terminal the command line names, its history first if asked for.
pub(crate) fn run(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    answer(verb(p, daemon), TERMINALS_USAGE, out)
}

fn verb(p: &Parsed, daemon: &Daemon) -> Step<String> {
    if let Some(other) = p.given().find(|o| !["history", "json", "home"].contains(o)) {
        return usage(format!("terminals screen takes no --{other}"));
    }
    let Some(target) = p.word(1) else {
        return usage("terminals screen takes an agent, shell or terminal");
    };
    if let Some(extra) = p.word(2) {
        return usage(format!("terminals screen takes no {extra}"));
    }
    let history = p.value("history").map_or(Ok(0), history)?;
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let terminal = match named(&state, target) {
        None => return Err(Stop::Refused(unknown(target))),
        Some(found) => found
            .terminal
            .ok_or_else(|| Stop::Refused(format!("{target} has no terminal to read")))?,
    };
    let path = format!(
        "/v1/terminals/{}/screen?history={history}",
        encode_uri_component(&terminal)
    );
    let screen: TerminalScreen = daemon.get(&path, CALL)?;
    if p.has("json") {
        return pretty(&screen);
    }
    Ok(shown(&screen.text))
}

/// `--history`'s rows, a whole number up to the most.
fn history(given: &str) -> Step<u32> {
    match given.parse::<u32>() {
        Ok(rows) if rows <= HISTORY_MAX && given.bytes().all(|b| b.is_ascii_digit()) => Ok(rows),
        _ => usage(format!(
            "--history is a whole number of rows from 0 to {HISTORY_MAX}, not {given}"
        )),
    }
}

/// The text as printed, without the newline its last row ends in, which printing adds back. Any
/// control but a newline, which the daemon never sends, is written as U+FFFD all the same, so a
/// screen can't act on the terminal it is printed to.
fn shown(text: &str) -> String {
    text.strip_suffix('\n')
        .unwrap_or(text)
        .chars()
        .map(|c| {
            if c.is_control() && c != '\n' {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_takes_a_whole_number_of_rows_up_to_the_most() {
        let read: Vec<Option<u32>> = ["0", "42", "10000", "10001", "-1", "+1", "1.5", "x", ""]
            .into_iter()
            .map(|given| history(given).ok())
            .collect();
        assert_eq!(
            read,
            [
                Some(0),
                Some(42),
                Some(10_000),
                None,
                None,
                None,
                None,
                None,
                None
            ]
        );
    }

    #[test]
    fn a_screen_is_shown_without_its_last_newline_and_a_control_as_a_replacement() {
        assert_eq!(
            shown("one\n\x1b[31mtwo\u{9b}\n"),
            "one\n\u{fffd}[31mtwo\u{fffd}"
        );
        assert_eq!(shown(""), "");
    }
}
