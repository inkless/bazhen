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
        // JSON escapes C0 controls but writes DEL and the C1 controls as they are.
        let text = printable(&screen.text);
        return pretty(&TerminalScreen { text, ..screen });
    }
    Ok(printed(&screen.text))
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

/// The text as printed: `printable`, without the newline its last row ends in, which printing
/// adds back.
fn printed(text: &str) -> String {
    let mut text = printable(text);
    if text.ends_with('\n') {
        text.pop();
    }
    text
}

/// The text with any control but a newline, which the daemon never sends, written as U+FFFD all
/// the same, so a screen can't act on the terminal it is printed to, as text or as JSON.
fn printable(text: &str) -> String {
    text.chars()
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
    fn a_screen_is_printed_without_the_newline_its_last_row_ends_in() {
        assert_eq!(printed("one\n\x1b\n"), "one\n\u{fffd}");
        assert_eq!(printed("one"), "one");
        assert_eq!(printed(""), "");
    }

    #[test]
    fn every_control_but_a_newline_is_printed_as_a_replacement() {
        assert_eq!(
            printable("one\n\x1b[31mtwo\u{7f}\u{9b}\r\n"),
            "one\n\u{fffd}[31mtwo\u{fffd}\u{fffd}\u{fffd}\n"
        );
    }
}
