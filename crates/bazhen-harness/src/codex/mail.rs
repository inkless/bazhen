//! Bazhen's messages to a Codex agent: the text it reads, `codex queue`'s arguments that carry it,
//! and the turn that takes it.

use super::wire::{field, optional_string, string};
use crate::js::Js;
use bazhen_core::mail::{leading_mail_id, mail_label, quote_labels};

/// The Bazhen message a turn takes as the user's input, and its thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UserMessage {
    pub(super) thread_id: String,
    /// None for input that isn't one of Bazhen's messages.
    pub(super) message_id: Option<String>,
}

/// The user's input an `item/started` gives; none for any other item or notification.
pub(super) fn read_user_message(method: &str, params: &Js) -> Option<UserMessage> {
    if method != "item/started" {
        return None;
    }
    let thread_id = string(params, "threadId")?;
    let item = field(params, "item")?;
    if string(item, "type")? != "userMessage" {
        return None;
    }
    let Some(Js::Array(content)) = item.field("content") else {
        return None;
    };
    let texts = content
        .iter()
        .map(|part| match part {
            Js::Object(_) => optional_string(part, "text").ok(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let first = texts.first().copied().flatten().unwrap_or("");
    Some(UserMessage {
        thread_id: thread_id.to_owned(),
        message_id: leading_mail_id(first).map(str::to_owned),
    })
}

/// A message's text as the agent reads it. It always carries the message's id, so the turn that
/// takes it can be matched to it, whenever and however Codex delivers it (foundation-design §5.8).
pub(super) fn message_text(id: &str, body: &str) -> String {
    format!("{}\n{}", mail_label(id), quote_labels(body))
}

/// `codex queue`'s arguments for one message: to the app-server at `remote`, which wakes an idle
/// thread and otherwise waits for the turn boundary, or, with no server to reach, into the Codex
/// home, which holds it until one comes up. Never `turn/start` or `turn/steer`, which would cut
/// off a running turn's reply.
pub(super) fn queue_args(thread_id: &str, text: &str, remote: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "queue".to_owned(),
        "--thread".to_owned(),
        thread_id.to_owned(),
    ];
    if let Some(remote) = remote {
        args.extend(["--remote".to_owned(), remote.to_owned()]);
    }
    args.extend(["--message".to_owned(), text.to_owned()]);
    args
}
