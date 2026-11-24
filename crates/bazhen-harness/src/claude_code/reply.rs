//! What Claude Code is answered with once the daemon resolves what it held: a wake, a fold, or
//! a permission decision.

use crate::js::Js;
use crate::text::utf16_len;
use crate::{Answer, HookOutput, Mail, Pending, Resolution};
use bazhen_core::mail::{mail_label, quote_labels};
use bazhen_protocol::mail::HOOK_REPLY_MAX_BYTES;
use bazhen_protocol::mail_events::ApprovalDecision;

/// The most text a fold hands over: Claude Code 2.1.322 cuts a `PostToolUse`'s
/// `additionalContext` at about 10,000 characters, where a wake's stderr arrives whole. Mail
/// that doesn't fit waits for a wake.
pub(super) const FOLD_MAX_CHARS: usize = 9_000;

/// The most messages one wake or fold hands over.
const MAX_WAKE_MESSAGES: usize = 100;

pub(super) fn answer(to: &Pending<'_>, with: Resolution<'_>) -> Answer {
    Answer::Hook(match (to, with) {
        (Pending::Waiter, Resolution::Mail(queued)) => {
            let fit = fitting(
                queued,
                |m| wake_text(&[*m]).len(),
                HOOK_REPLY_MAX_BYTES,
                true,
            );
            if fit.is_empty() {
                HookOutput::quiet()
            } else {
                // Exit 2 with the mail on stderr wakes the idle session.
                HookOutput {
                    exit_code: 2,
                    stdout: String::new(),
                    stderr: wake_text(fit),
                    carried: fit.iter().map(|m| m.id.to_owned()).collect(),
                }
            }
        }
        (Pending::Fold, Resolution::Mail(queued)) => {
            let fit = fitting(
                queued,
                |m| utf16_len(&wake_text(&[*m])),
                FOLD_MAX_CHARS,
                false,
            );
            if fit.is_empty() {
                HookOutput::quiet()
            } else {
                HookOutput {
                    stdout: fold_reply(&wake_text(fit)),
                    carried: fit.iter().map(|m| m.id.to_owned()).collect(),
                    ..HookOutput::quiet()
                }
            }
        }
        (Pending::Approval, Resolution::Decision(decision)) => HookOutput {
            stdout: approval_reply(decision),
            ..HookOutput::quiet()
        },
        (Pending::ServerRequest { .. }, _) => return Answer::Unavailable,
        _ => HookOutput::quiet(),
    })
}

/// The oldest messages whose text fits within `max`, each of `size`: a wake's within one hook
/// reply, since a client refuses a larger one, which would hold back all of them, and a fold's
/// within what Claude Code passes on whole. The rest stay queued. A wake always takes the first,
/// since a body is at most 20,000 characters; a fold takes none it would cut short.
fn fitting<'q, 'a>(
    queued: &'q [Mail<'a>],
    size: impl Fn(&Mail<'a>) -> usize,
    max: usize,
    first_always: bool,
) -> &'q [Mail<'a>] {
    // Each message's own text, plus the blank line a wake puts between two.
    let mut total: usize = 0;
    let mut fit = 0;
    for (i, m) in queued.iter().take(MAX_WAKE_MESSAGES).enumerate() {
        total += size(m) + if i == 0 { 0 } else { 2 };
        if total > max && (fit > 0 || !first_always) {
            break;
        }
        fit += 1;
    }
    queued.get(..fit).unwrap_or_default()
}

/// What a wake hands the model: Claude Code shows it as a system notification, not user input,
/// and its `UserPromptSubmit` carries it verbatim, so each message's id confirms it was seen. A
/// message offered before may already have reached the agent, and says so (foundation-design
/// §5.6).
pub(super) fn wake_text(messages: &[Mail<'_>]) -> String {
    messages
        .iter()
        .map(|m| {
            let again = m.first_offered.map_or(String::new(), |first| {
                format!(
                    "(possible re-delivery of {}, first offered {first})\n",
                    m.id
                )
            });
            format!("{}\n{again}{}", mail_label(m.id), quote_labels(m.body))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn hook_specific(entries: Vec<(&str, Js)>) -> String {
    let inner = Js::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    );
    Js::Object(vec![("hookSpecificOutput".to_owned(), inner)]).stringify()
}

/// The hook output that answers a `PermissionRequest`, dismissing the TUI's own prompt.
pub(super) fn approval_reply(decision: ApprovalDecision) -> String {
    let mut answer = vec![(
        "behavior".to_owned(),
        Js::String(
            match decision {
                ApprovalDecision::Allow => "allow",
                ApprovalDecision::Deny => "deny",
            }
            .to_owned(),
        ),
    )];
    if decision == ApprovalDecision::Deny {
        answer.push((
            "message".to_owned(),
            Js::String("Denied from the Bazhen inbox.".to_owned()),
        ));
    }
    hook_specific(vec![
        ("hookEventName", Js::String("PermissionRequest".to_owned())),
        ("decision", Js::Object(answer)),
    ])
}

/// The `PostToolUse` output that folds mail into the running turn: the model reads it beside the
/// tool's result (foundation-design §5.6), in the same words a wake uses.
pub(super) fn fold_reply(text: &str) -> String {
    hook_specific(vec![
        ("hookEventName", Js::String("PostToolUse".to_owned())),
        ("additionalContext", Js::String(text.to_owned())),
    ])
}
