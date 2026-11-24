//! Codex's threads: those a TUI starts, the one a terminal title names, and the config a thread
//! is given.

use super::wire::{field, nullish_bool, nullish_string, string};
use crate::js::Js;
use std::fmt::Write as _;

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

/// One page of a `thread/list` answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct ThreadPage {
    /// The shown threads, newest first as the server sorts them.
    pub(super) threads: Vec<String>,
    /// The next page's cursor; none when this is the last, or an answer it can't read.
    pub(super) next_cursor: Option<String>,
}

pub(super) fn read_thread_list(result: &Js) -> ThreadPage {
    let page = || {
        let Some(Js::Array(data)) = field(result, "data") else {
            return None;
        };
        let next_cursor = nullish_string(result, "nextCursor").ok()?;
        Some(ThreadPage {
            threads: data
                .iter()
                .filter_map(|t| shown(t).map(str::to_owned))
                .collect(),
            next_cursor: next_cursor.map(str::to_owned),
        })
    };
    page().unwrap_or_default()
}

/// The ids among `ids` that start with `prefix`, each once, in the order they came.
pub(super) fn matching<'a>(prefix: &str, ids: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for id in ids {
        if id.starts_with(prefix) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
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

/// One `-c` setting's value: a number is written bare, as Codex refuses a string where its config
/// takes an integer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Setting {
    Text(String),
    Number(u64),
}

/// What a thread loaded with Bazhen's daemon at `socket` is given. Codex keeps a thread's config
/// from the client that loaded it, so the daemon sends it on the threads it loads and the TUI on
/// those it loads itself. The server's own environment is whatever started it, which an agent's
/// tool call can be, so the thread sets the agent's id and token file empty, which the CLI and the
/// daemon read as none. Not `exclude`: a list in a thread's config replaces the user's.
pub(super) fn thread_config(socket: &str) -> Vec<(&'static str, Setting)> {
    vec![
        (
            "shell_environment_policy.set.BAZHEN_SOCKET",
            Setting::Text(socket.to_owned()),
        ),
        (
            "shell_environment_policy.set.BAZHEN_AGENT_ID",
            Setting::Text(String::new()),
        ),
        (
            "shell_environment_policy.set.BAZHEN_AGENT_AUTH_FILE",
            Setting::Text(String::new()),
        ),
    ]
}

/// What a thread is given so it compacts at `tokens`; nothing, to leave Codex's own setting.
pub(super) fn compact_config(tokens: Option<u64>) -> Vec<(&'static str, Setting)> {
    tokens
        .map(|tokens| ("model_auto_compact_token_limit", Setting::Number(tokens)))
        .into_iter()
        .collect()
}

/// `value` as a TOML basic string. Codex reads a `-c` value as TOML and, when that fails, takes the
/// raw text with spaces and quotes trimmed from its ends, so a path left unescaped reaches the
/// thread as some other path, with no error.
pub(super) fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '\0'..='\u{1f}' | '\u{7f}' => {
                // Writing to a String can't fail.
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
