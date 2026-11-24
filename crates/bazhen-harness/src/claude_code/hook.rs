//! Claude Code's hooks as the daemon acts on them, whatever Claude Code calls them. The daemon
//! never sees Claude Code's formats.

use super::APPROVAL_WAIT_MS;
use crate::js::Js;
use crate::text::{iso_of_unix_seconds, utf16_len, whole};
use crate::{
    Gate, HarnessActivity, Held, Ingested, Keyed, LimitStop, Observed, Origin, Reply, SentMessage,
    SessionRef, ToolKey,
};
use bazhen_core::mail::mail_label;
use bazhen_protocol::agent_events::{CompactedSign, ReadySign};
use bazhen_protocol::agents::{ActivityValue, ExternalRefKind, Usage, UsageLimit};
use bazhen_protocol::ids::AgentId;

/// One of the hooks a launch installed, read.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Hook {
    /// The waiter; `session_started` when it runs for a `SessionStart`, which may move the
    /// binding, and `compacted` when that `SessionStart` only compacted the session the agent is
    /// in.
    Wait {
        session_started: bool,
        compacted: bool,
        /// The turn whose end this waiter runs for, as the Stop or `StopFailure` report says too.
        turn_end: Option<TurnEnd>,
    },
    ToolStarted {
        tool: ToolKey,
        use_id: String,
    },
    Permission {
        summary: String,
        tool: ToolKey,
    },
    /// The agent asks the human a question, which only the TUI can take an answer to.
    Question {
        summary: String,
        tool: ToolKey,
    },
    PromptStarted {
        prompt: String,
        prompt_id: Option<String>,
    },
    TurnEnded {
        prompt_id: Option<String>,
    },
    TurnFailed {
        prompt_id: Option<String>,
        error: Option<String>,
    },
    ToolSettled {
        use_id: String,
        /// A `PostToolUse`, whose reply can fold mail into the turn; a failed call's can't.
        fold: Option<Fold>,
    },
    /// The status line redrew, saying which model runs and how full its context is.
    Statusline {
        usage: Usage,
    },
    SubagentStarted {
        id: String,
    },
    SubagentStopped {
        id: String,
    },
    Ignored,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TurnEnd {
    prompt_id: Option<String>,
    failed: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Fold {
    prompt_id: Option<String>,
    /// The agent's own `SendMessage`, to the session `to` names.
    sent: Option<SentMessage>,
}

/// Reads one hook's report: the facts it gives, in the order the daemon applies them, and how
/// to answer it.
pub(super) fn ingest(event: &str, payload: &Js, agent: &AgentId, offered: &[String]) -> Ingested {
    let hook = read_hook(event, payload);
    let activity = activity_of(&hook);
    // A turn's end settles the mail it took before its activity is recorded, so the idle it
    // reports comes after every message that turn carried.
    let ends_turn = matches!(
        hook,
        Hook::Wait { .. } | Hook::TurnEnded { .. } | Hook::TurnFailed { .. }
    );
    // A turn's end closes the questions it asked, whoever's session it was.
    let turn_over = matches!(hook, Hook::TurnEnded { .. } | Hook::TurnFailed { .. });
    let (before, after) = if ends_turn {
        (None, activity)
    } else {
        (activity, None)
    };
    let read = facts_of(hook, offered);
    // A waiter's report counts only from the agent's own session, its activity with it.
    let after_gate = if read.reply_gate == Gate::Owner {
        Gate::Owner
    } else {
        Gate::InSession
    };
    let facts = before
        .map(|a| (Gate::InSession, Observed::Activity(a)))
        .into_iter()
        .chain(read.facts)
        .chain(after.map(|a| (after_gate, Observed::Activity(a))))
        .chain(turn_over.then_some((Gate::None, Observed::TurnOver)));
    Ingested {
        observed: facts
            .map(|(gate, fact)| Keyed::agent(agent, gate, fact))
            .collect(),
        origin: Some(origin_of(payload)),
        reply: read.reply,
        reply_gate: read.reply_gate,
    }
}

/// What a hook says beyond the activity it reports, each fact under its gate, and its reply.
struct Said {
    facts: Vec<(Gate, Observed)>,
    reply: Reply,
    reply_gate: Gate,
}

fn facts_of(hook: Hook, offered: &[String]) -> Said {
    let (none, in_session, owner) = (Gate::None, Gate::InSession, Gate::Owner);
    let mut facts: Vec<(Gate, Observed)> = Vec::new();
    let ready = Observed::Ready {
        sign: ReadySign::ClaudeHook,
    };
    let (mut reply, mut reply_gate) = (Reply::Quiet, none);
    match hook {
        Hook::Wait {
            session_started,
            compacted,
            turn_end,
        } => {
            facts.push((owner, ready));
            if session_started {
                facts.push((owner, Observed::SessionStarted { compacted }));
                if compacted {
                    let sign = CompactedSign::ClaudeHook;
                    facts.push((owner, Observed::Compacted { sign }));
                }
            }
            facts.extend(turn_end.map(|end| {
                let fact = match end {
                    TurnEnd {
                        prompt_id,
                        failed: true,
                        error,
                    } => Observed::TurnFailed { prompt_id, error },
                    TurnEnd { prompt_id, .. } => Observed::TurnEnded { prompt_id },
                };
                (owner, fact)
            }));
            (reply, reply_gate) = (Reply::Hold(Held::Waiter), owner);
        }
        Hook::Permission { summary, tool } => {
            facts.push((
                none,
                Observed::ApprovalAsked {
                    key: tool.clone(),
                    summary,
                    question: false,
                },
            ));
            reply = Reply::Hold(Held::Approval {
                key: tool,
                wait_ms: Some(APPROVAL_WAIT_MS),
            });
        }
        Hook::Question { summary, tool } => {
            facts.push((none, Observed::QuestionAsked { key: tool, summary }));
        }
        Hook::PromptStarted { prompt, prompt_id } => {
            let carries = offered
                .iter()
                .filter(|id| carries_wake(&prompt, id))
                .cloned()
                .collect();
            facts.extend([
                (owner, ready),
                (owner, Observed::PromptStarted { prompt_id, carries }),
                (owner, Observed::TurnStarted),
            ]);
        }
        Hook::TurnEnded { prompt_id } => {
            facts.extend([(owner, ready), (owner, Observed::TurnEnded { prompt_id })]);
        }
        Hook::TurnFailed { prompt_id, error } => {
            let fact = Observed::TurnFailed { prompt_id, error };
            facts.extend([(owner, ready), (owner, fact)]);
        }
        Hook::ToolStarted { tool, use_id } => {
            facts.push((none, Observed::ToolStarted { key: tool, use_id }));
        }
        Hook::ToolSettled { use_id, fold } => {
            let settled = Observed::ToolSettled {
                use_id: use_id.clone(),
            };
            facts.push((none, settled));
            if let Some(Fold { prompt_id, sent }) = fold {
                facts.push((owner, ready));
                facts.extend(sent.map(|sent| (owner, Observed::MessageObserved { use_id, sent })));
                if let Some(prompt_id) = prompt_id {
                    (reply, reply_gate) = (Reply::Hold(Held::Fold { prompt_id }), owner);
                }
            }
        }
        Hook::Statusline { usage } => facts.push((in_session, Observed::Usage(usage))),
        // What a subagent does is the agent's activity, from its session alone; the requests a
        // stopped one made are over whoever's session it ran in.
        Hook::SubagentStarted { id } => {
            facts.push((in_session, Observed::SubagentStarted { id }));
        }
        Hook::SubagentStopped { id } => facts.extend([
            (in_session, Observed::SubagentStopped { id: id.clone() }),
            (none, Observed::SubagentOver { id }),
        ]),
        Hook::Ignored => {}
    }
    Said {
        facts,
        reply,
        reply_gate,
    }
}

/// Whether a prompt carries this message as a wake handed it over, rather than naming its id in
/// passing, as a human or a background subagent quoting it might. Claude Code wraps the wake in
/// text of its own and rewrites tags in it, so the label is looked for anywhere. Mail can't fake
/// one, since a wake marks every label a body quotes; a label a person types, or a subagent
/// repeats, into a prompt still counts.
pub(super) fn carries_wake(prompt: &str, id: &str) -> bool {
    prompt.contains(&mail_label(id))
}

pub(super) fn read_hook(event: &str, payload: &Js) -> Hook {
    match event {
        "wait" => Hook::Wait {
            session_started: str_field(payload, "hook_event_name") == Some("SessionStart"),
            compacted: str_field(payload, "source") == Some("compact"),
            turn_end: turn_end_of(payload),
        },
        "PreToolUse" => match str_field(payload, "tool_use_id") {
            Some(use_id) => Hook::ToolStarted {
                tool: tool_key(payload),
                use_id: use_id.to_owned(),
            },
            None => Hook::Ignored,
        },
        "statusline" => Hook::Statusline {
            usage: usage_of(payload),
        },
        "SubagentStart" | "SubagentStop" => match str_field(payload, "agent_id") {
            Some(id) if !id.is_empty() => {
                let id = id.to_owned();
                if event == "SubagentStart" {
                    Hook::SubagentStarted { id }
                } else {
                    Hook::SubagentStopped { id }
                }
            }
            _ => Hook::Ignored,
        },
        // A question wants the human's choice, which allow or deny can't give: the TUI asks it.
        "PermissionRequest" if str_field(payload, "tool_name") == Some("AskUserQuestion") => {
            Hook::Question {
                summary: question_summary(payload),
                tool: tool_key(payload),
            }
        }
        "PermissionRequest" => Hook::Permission {
            summary: approval_summary(payload),
            tool: tool_key(payload),
        },
        "UserPromptSubmit" => Hook::PromptStarted {
            prompt: str_field(payload, "prompt").unwrap_or_default().to_owned(),
            prompt_id: prompt_id_of(payload),
        },
        "Stop" => Hook::TurnEnded {
            prompt_id: prompt_id_of(payload),
        },
        "StopFailure" => Hook::TurnFailed {
            prompt_id: prompt_id_of(payload),
            error: error_of(payload),
        },
        "PostToolUse" | "PostToolUseFailure" => match str_field(payload, "tool_use_id") {
            None => Hook::Ignored,
            Some(use_id) => Hook::ToolSettled {
                use_id: use_id.to_owned(),
                fold: (event == "PostToolUse").then(|| Fold {
                    prompt_id: prompt_id_of(payload),
                    sent: sent_of(payload),
                }),
            },
        },
        _ => Hook::Ignored,
    }
}

/// An API error that ends the turn. Claude Code reports a subscription's usage limit and an API
/// key's passing 429 alike as `rate_limit`, so that one may be the account's limit.
fn failure(error: Option<&str>) -> HarnessActivity {
    HarnessActivity {
        value: ActivityValue::Failed,
        detail: error.map(str::to_owned),
        limit: (error == Some("rate_limit")).then_some(LimitStop::Rate),
    }
}

/// What a hook says the agent is doing (foundation-design §4.6), or none for one that says
/// nothing: a prompt or a tool call means working, a permission request needs the human, a
/// turn's end leaves it idle, and an API error that ends the turn is a failure.
pub(super) fn activity_of(hook: &Hook) -> Option<HarnessActivity> {
    let of = |value| Some(HarnessActivity::of(value));
    match hook {
        Hook::PromptStarted { .. } | Hook::ToolStarted { .. } | Hook::ToolSettled { .. } => {
            of(ActivityValue::Working)
        }
        Hook::Permission { .. } => of(ActivityValue::NeedsApproval),
        Hook::Question { .. } => of(ActivityValue::WaitingInput),
        Hook::TurnEnded { .. } => of(ActivityValue::Idle),
        Hook::TurnFailed { error, .. } => Some(failure(error.as_deref())),
        // A session that starts or starts over waits for its first prompt; a compaction is
        // mid-turn.
        Hook::Wait {
            session_started: true,
            compacted,
            ..
        } => (!compacted).then(|| HarnessActivity::of(ActivityValue::Idle)),
        Hook::Wait { turn_end, .. } => turn_end.as_ref().map(|end| {
            if end.failed {
                failure(end.error.as_deref())
            } else {
                HarnessActivity::of(ActivityValue::Idle)
            }
        }),
        Hook::SubagentStarted { .. }
        | Hook::SubagentStopped { .. }
        | Hook::Statusline { .. }
        | Hook::Ignored => None,
    }
}

/// `payload[name]` when it is a string.
fn str_field<'a>(payload: &'a Js, name: &str) -> Option<&'a str> {
    payload.field(name).and_then(Js::as_str)
}

/// The turn a Stop or `StopFailure` payload ends, for a hook that runs beside those reports.
fn turn_end_of(payload: &Js) -> Option<TurnEnd> {
    let event = str_field(payload, "hook_event_name");
    matches!(event, Some("Stop" | "StopFailure")).then(|| TurnEnd {
        prompt_id: prompt_id_of(payload),
        failed: event == Some("StopFailure"),
        error: error_of(payload),
    })
}

/// Claude Code's name for the API error a `StopFailure` reports, such as `server_error`.
fn error_of(payload: &Js) -> Option<String> {
    str_field(payload, "error").map(|e| whole(e, 200).to_owned())
}

/// The prompt id on every hook but `SessionStart`, which ties a Stop to the prompt it ends.
fn prompt_id_of(payload: &Js) -> Option<String> {
    str_field(payload, "prompt_id").map(str::to_owned)
}

/// Which Claude Code session ran a hook, and which of its subagents did, if one did: compaction
/// runs as one (§3.1).
pub(super) fn origin_of(payload: &Js) -> Origin {
    Origin {
        session: str_field(payload, "session_id")
            .filter(|id| !id.is_empty())
            .map(|id| SessionRef {
                kind: ExternalRefKind::ClaudeSession,
                id: id.to_owned(),
            }),
        transcript: str_field(payload, "transcript_path")
            .filter(|path| path.starts_with('/'))
            .map(str::to_owned),
        subagent: str_field(payload, "agent_id").map(str::to_owned),
    }
}

/// Which tool call a `PermissionRequest` is about, as far as its payload says. It carries no
/// `tool_use_id`, so it is matched to a `PreToolUse` with the same caller (the agent or one of its
/// subagents), prompt, tool and exact input, whose `tool_use_id` the call's result then carries
/// (foundation-design §5.6).
fn tool_key(payload: &Js) -> ToolKey {
    let caller = str_field(payload, "agent_id").unwrap_or("main");
    let prompt_id = prompt_id_of(payload);
    let given = |name| match payload.field(name) {
        None | Some(Js::Null) => Js::Null,
        Some(value) => value.clone(),
    };
    let key = Js::Array(vec![
        Js::String(caller.to_owned()),
        prompt_id.clone().map_or(Js::Null, Js::String),
        given("tool_name"),
        given("tool_input"),
    ])
    .stringify();
    ToolKey {
        key,
        caller: (caller != "main").then(|| caller.to_owned()),
        prompt_id,
    }
}

/// The questions an `AskUserQuestion` asks, as one line.
fn question_summary(payload: &Js) -> String {
    let asked: Vec<&str> = match payload
        .field("tool_input")
        .and_then(|i| i.field("questions"))
    {
        Some(Js::Array(questions)) => questions
            .iter()
            .filter_map(|q| q.field("question").and_then(Js::as_str))
            .collect(),
        _ => Vec::new(),
    };
    if asked.is_empty() {
        "The agent asks you a question".to_owned()
    } else {
        whole(&asked.join(" / "), 300).to_owned()
    }
}

/// What a permission request is for, as the inbox shows it.
fn approval_summary(payload: &Js) -> String {
    let tool = str_field(payload, "tool_name").unwrap_or("A tool");
    let input = match payload.field("tool_input") {
        None | Some(Js::Null) => "{}".to_owned(),
        Some(input) => input.stringify(),
    };
    format!("{tool}: {}", whole(&input, 300))
}

/// A `SendMessage` the agent itself made, not one of its subagents. A structured message is a
/// teammate protocol request, not words for a peer.
fn sent_of(payload: &Js) -> Option<SentMessage> {
    if str_field(payload, "tool_name") != Some("SendMessage") || payload.field("agent_id").is_some()
    {
        return None;
    }
    let input = payload.field("tool_input")?;
    let to = str_field(input, "to").filter(|to| !to.is_empty())?;
    let text = str_field(input, "message")?;
    Some(SentMessage {
        to: to.to_owned(),
        text: text.to_owned(),
        summary: str_field(input, "summary")
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        accepted: payload
            .field("tool_response")
            .and_then(|r| r.field("success"))
            == Some(&Js::Bool(true)),
    })
}

/// The model and context use a status line's input gives, as far as it gives them.
fn usage_of(payload: &Js) -> Usage {
    let model = payload
        .field("model")
        .and_then(|m| m.field("display_name"))
        .and_then(Js::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| whole(name, 200).to_owned());
    let window = payload.field("context_window");
    let number = |name| window.and_then(|w| w.field(name)).and_then(Js::as_number);
    let limits = limits_of(payload.field("rate_limits"));
    Usage {
        model,
        // Whole percent: a finer change isn't worth an event.
        context_used_percent: number("used_percentage")
            .filter(|used| (0.0..=100.0).contains(used))
            .map(f64::round),
        context_window_tokens: number("context_window_size")
            .filter(|size| size.fract() == 0.0 && *size > 0.0)
            .and_then(|size| format!("{size:.0}").parse().ok()),
        limits: (!limits.is_empty()).then_some(limits),
    }
}

/// Each usage limit a status line's `rate_limits` gives with its share used, by Claude Code's
/// name for its window, such as `five_hour`: its reset is Unix seconds. A list there is a group
/// of limits, not one, and is left out. An array of them is read as JavaScript's
/// `Object.entries` reads one, by index.
fn limits_of(rate_limits: Option<&Js>) -> Vec<UsageLimit> {
    let entries: Vec<(String, &Js)> = match rate_limits {
        Some(Js::Object(entries)) => entries.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Some(Js::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    };
    let mut limits = Vec::new();
    for (window, limit) in entries {
        let used = limit.field("used_percentage").and_then(Js::as_number);
        let Some(used) = used.filter(|used| *used >= 0.0) else {
            continue;
        };
        if matches!(limit, Js::Array(_)) || utf16_len(&window) > 60 {
            continue;
        }
        let resets_at = limit
            .field("resets_at")
            .and_then(Js::as_number)
            .and_then(iso_of_unix_seconds);
        limits.push(UsageLimit {
            window,
            used_percent: used,
            resets_at,
        });
    }
    limits.truncate(20);
    limits
}
