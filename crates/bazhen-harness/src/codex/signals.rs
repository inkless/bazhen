//! What Codex's notifications say a thread is doing: its status, its turns, the account's limits,
//! the items a turn starts and the compactions it finishes.

use super::wire::{field, object, string};
use crate::js::Js;
use crate::report::LimitStop;
use crate::text::{iso_of_unix_seconds, utf16_len, whole};
use bazhen_protocol::agents::{ActivityValue, UsageLimit};

/// A `ThreadStatus` as activity: `active` is working unless a flag says it waits on the human.
/// `notLoaded`, and a status this build doesn't know, are unknown, so a stale one isn't left
/// showing. None for something that is no status at all.
pub(super) fn activity_of(status: Option<&Js>) -> Option<ActivityValue> {
    let kind = string(status?, "type")?;
    let flags = match status?.field("activeFlags") {
        None => Vec::new(),
        Some(Js::Array(flags)) => flags.iter().map(Js::as_str).collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(match kind {
        "active" if flags.contains(&"waitingOnApproval") => ActivityValue::NeedsApproval,
        "active" if flags.contains(&"waitingOnUserInput") => ActivityValue::WaitingInput,
        "active" => ActivityValue::Working,
        "idle" => ActivityValue::Idle,
        "systemError" => ActivityValue::Failed,
        _ => ActivityValue::Unknown,
    })
}

/// Whether a `ThreadStatus` says the thread is not loaded, and must be resumed to be followed.
pub(super) fn is_not_loaded(status: Option<&Js>) -> bool {
    activity_of(status).is_some() && status.and_then(|s| string(s, "type")) == Some("notLoaded")
}

/// A thread's new activity, from `thread/status/changed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ThreadStatus {
    pub(super) thread_id: String,
    pub(super) activity: ActivityValue,
    pub(super) not_loaded: bool,
}

pub(super) fn read_thread_status(method: &str, params: &Js) -> Option<ThreadStatus> {
    if method != "thread/status/changed" {
        return None;
    }
    let thread_id = string(params, "threadId")?;
    let status = params.field("status");
    Some(ThreadStatus {
        thread_id: thread_id.to_owned(),
        activity: activity_of(status)?,
        not_loaded: is_not_loaded(status),
    })
}

/// A turn that started, or one that ended and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Turn {
    pub(super) thread_id: String,
    pub(super) started: bool,
    /// `completed`, `interrupted`, `failed`, or none when it doesn't say, which the thread's
    /// status then tells.
    pub(super) ended: Option<String>,
    /// The error a failed turn names.
    pub(super) error: Option<String>,
    /// Whether the account's limit may have caused it.
    pub(super) limit: Option<LimitStop>,
}

/// Codex's name for an error, as `TurnError.codexErrorInfo` gives it: the string, or the one key of
/// a variant that carries data, such as `httpConnectionFailed`.
fn error_name(info: Option<&Js>) -> Option<String> {
    let name = match info? {
        Js::String(name) if !name.is_empty() => name.as_str(),
        // Object.keys of an array names its indices.
        Js::Array(items) if items.len() == 1 => "0",
        // A variant's one key, even an empty one.
        Js::Object(entries) => match entries.as_slice() {
            [(key, _)] => key.as_str(),
            _ => return None,
        },
        _ => return None,
    };
    Some(whole(name, 200).to_owned())
}

/// A turn, from `turn/started` and `turn/completed`.
pub(super) fn read_turn(method: &str, params: &Js) -> Option<Turn> {
    let started = match method {
        "turn/started" => true,
        "turn/completed" => false,
        _ => return None,
    };
    let thread_id = string(params, "threadId")?;
    let turn = match params.field("turn") {
        None => None,
        Some(turn) => Some(object(turn)?),
    };
    let status = match turn.and_then(|t| t.field("status")) {
        None => None,
        Some(Js::String(status)) => Some(status.clone()),
        Some(_) => return None,
    };
    // A turn's error that isn't one is read as none.
    let info = turn
        .and_then(|t| t.field("error"))
        .and_then(object)
        .and_then(|e| e.field("codexErrorInfo"));
    let error = if started { None } else { error_name(info) };
    let limit = match error.as_deref() {
        Some("usageLimitExceeded") => Some(LimitStop::Quota),
        Some("rateLimitExceeded") => Some(LimitStop::Rate),
        _ => None,
    };
    Some(Turn {
        thread_id: thread_id.to_owned(),
        started,
        ended: if started { None } else { status },
        error,
        limit,
    })
}

/// One window of the account's limits, or none for one that isn't, which zod's `.catch` reads as
/// left out.
fn window(value: Option<&Js>) -> Option<(f64, Option<String>)> {
    let value = object(value?)?;
    let used = value
        .field("usedPercent")?
        .as_number()
        .filter(|p| *p >= 0.0)?;
    // zod's `z.unknown()` takes any value, but not none: a window with no reset isn't one.
    let resets_at = value
        .field("resetsAt")?
        .as_number()
        .and_then(iso_of_unix_seconds);
    Some((used, resets_at))
}

/// The windows an `account/rateLimits/updated` notification gives, each named by its limit and
/// slot, such as `codex.primary`. The update is sparse: a window it leaves out keeps what was last
/// said of it. Codex gives a reset in Unix seconds.
pub(super) fn read_rate_limits(method: &str, params: &Js) -> Option<Vec<UsageLimit>> {
    if method != "account/rateLimits/updated" {
        return None;
    }
    let limits = object(field(params, "rateLimits")?)?;
    let limit_id = limits
        .field("limitId")
        .and_then(Js::as_str)
        .filter(|id| (1..=40).contains(&utf16_len(id)));
    let named = |slot: &str| match limit_id {
        None => slot.to_owned(),
        Some(id) => format!("{id}.{slot}"),
    };
    Some(
        [("primary", "primary"), ("secondary", "secondary")]
            .into_iter()
            .filter_map(|(key, slot)| {
                let (used_percent, resets_at) = window(limits.field(key))?;
                Some(UsageLimit {
                    window: named(slot),
                    used_percent,
                    resets_at,
                })
            })
            .collect(),
    )
}

/// An item a turn started, and whether it is the user's input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ItemStarted {
    pub(super) thread_id: String,
    pub(super) user_input: bool,
}

/// The thread an item is on, and its type.
fn thread_item(params: &Js) -> Option<(&str, &str)> {
    let thread_id = string(params, "threadId")?;
    let kind = string(field(params, "item")?, "type")?;
    Some((thread_id, kind))
}

pub(super) fn read_item_started(method: &str, params: &Js) -> Option<ItemStarted> {
    if method != "item/started" {
        return None;
    }
    let (thread_id, kind) = thread_item(params)?;
    Some(ItemStarted {
        thread_id: thread_id.to_owned(),
        user_input: kind == "userMessage",
    })
}

/// The thread whose context a compaction item just finished compacting, from `item/completed`.
/// Codex's `thread/compacted` says the same, but Codex marks it deprecated in favour of the item.
pub(super) fn read_compaction(method: &str, params: &Js) -> Option<String> {
    if method != "item/completed" {
        return None;
    }
    let (thread_id, kind) = thread_item(params)?;
    (kind == "contextCompaction").then(|| thread_id.to_owned())
}
