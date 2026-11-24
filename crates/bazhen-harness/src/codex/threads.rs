//! Codex's threads: those a TUI starts, and the one a terminal title names.

use super::wire::{field, nullish_bool, nullish_string, string};
use crate::js::Js;

/// A started or listed thread's id, when it is one a human could be shown: not one Codex makes to
/// write a title, which is ephemeral.
fn shown(thread: &Js) -> Option<&str> {
    let id = string(thread, "id")?;
    let ephemeral = nullish_bool(thread, "ephemeral").ok()?;
    let source = nullish_string(thread, "threadSource").ok()?;
    (ephemeral != Some(true) && source != Some("thread_title")).then_some(id)
}

/// A new thread's id, from `thread/started`, as a TUI's `/new` or `/fork` makes; none for a title
/// thread or any other notification.
pub(super) fn read_thread_started(method: &str, params: &Js) -> Option<String> {
    if method != "thread/started" {
        return None;
    }
    shown(field(params, "thread")?).map(str::to_owned)
}

/// Whitespace as JavaScript's `trim` takes it: Unicode's, but U+0085, and the byte-order mark.
pub(super) fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The thread id a TUI's terminal title names, as the prefix every id it could be starts with:
/// the id whole, or cut short with `...` or `…`. None for a title that isn't one, as the user's
/// own title config makes (foundation-design §5.8).
pub(super) fn title_prefix(title: &str) -> Option<&str> {
    let title = title.trim_matches(js_space);
    let (head, rest) = title.split_at_checked(9)?;
    let (hex, dash) = head.split_at_checked(8)?;
    if dash != "-" || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let run = rest
        .bytes()
        .take_while(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
        .count();
    let (tail, cut) = rest.split_at_checked(run)?;
    ((20..=27).contains(&tail.len()) && matches!(cut, "" | "..." | "…"))
        .then(|| title.get(..9 + run))
        .flatten()
}
