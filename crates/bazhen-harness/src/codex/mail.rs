//! The turn that takes one of Bazhen's messages to a Codex agent.

use super::wire::{field, optional_string, string};
use crate::js::Js;
use bazhen_core::mail::leading_mail_id;

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
