//! The app-server's requests for the human: an approval to run a command or change files, a
//! question, an MCP server's elicitation or a grant of more permissions, and the results that
//! answer them.

use super::wire::{field, nullish_string, object, optional_bool, optional_string, string, truthy};
use crate::js::Js;
use crate::text::whole;
use bazhen_protocol::mail_events::ApprovalDecision;
use serde_json::{Value, json};

/// A request for the human's approval, as the daemon acts on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Approval {
    pub(super) thread_id: String,
    /// The tool call it is for.
    pub(super) item_id: String,
    pub(super) summary: String,
}

/// Whether a request is answered with a decision, allow or deny: an approval to run a command or
/// change files. Any other is answered otherwise, or not by Bazhen.
pub(super) fn takes_decision(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    )
}

/// An approval to run a command or change files, as one for the inbox (foundation-design §5.8);
/// none for any other request, which is not Bazhen's to answer.
pub(super) fn read_approval(method: &str, params: &Js) -> Option<Approval> {
    if !takes_decision(method) {
        return None;
    }
    let command = method == "item/commandExecution/requestApproval";
    let thread_id = string(params, "threadId")?;
    let item_id = string(params, "itemId")?;
    let asked = nullish_string(params, "command").ok()?;
    let reason = nullish_string(params, "reason").ok()?;
    let what = if command {
        format!("Run {}", asked.unwrap_or("a command"))
    } else {
        "Change files".to_owned()
    };
    Some(Approval {
        thread_id: thread_id.to_owned(),
        item_id: item_id.to_owned(),
        summary: match truthy(reason) {
            Some(reason) => format!("{what} ({reason})"),
            None => what,
        },
    })
}

/// The result that answers an approval request with the inbox's decision.
pub(super) fn approval_result(decision: ApprovalDecision) -> Value {
    let decision = match decision {
        ApprovalDecision::Allow => "accept",
        ApprovalDecision::Deny => "decline",
    };
    json!({ "decision": decision })
}

/// A request that asks the human something other than allow or deny. Only a single free-text
/// question can be answered from the inbox; the TUI takes the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Question {
    pub(super) thread_id: String,
    /// The tool call it is for; none for an elicitation, which names none.
    pub(super) item_id: Option<String>,
    /// What tells it apart on its thread, the same when a resumed thread sends it again: its tool
    /// call, or for an elicitation its server and message, since it names no call.
    pub(super) key: String,
    pub(super) summary: String,
    /// The question a text reply answers, or none when only the TUI can answer it.
    pub(super) answers: Option<String>,
}

/// One of a `requestUserInput`'s questions.
struct Asked<'a> {
    id: &'a str,
    question: &'a str,
    /// Whether the human may answer in their own words, beside the options.
    other: bool,
    secret: bool,
    /// Whether it offers options to choose from.
    options: bool,
}

fn asked(value: &Js) -> Option<Asked<'_>> {
    let id = string(value, "id")?;
    let question = string(value, "question")?;
    let other = optional_bool(value, "isOther").ok()?;
    let secret = optional_bool(value, "isSecret").ok()?;
    let options = match value.field("options") {
        None | Some(Js::Null) => false,
        Some(Js::Array(options)) => !options.is_empty(),
        Some(_) => return None,
    };
    Some(Asked {
        id,
        question,
        other: other == Some(true),
        secret: secret == Some(true),
        options,
    })
}

fn user_input(params: &Js) -> Option<Question> {
    let thread_id = string(params, "threadId")?;
    let item_id = string(params, "itemId")?;
    let Some(Js::Array(questions)) = field(params, "questions") else {
        return None;
    };
    let questions = questions.iter().map(asked).collect::<Option<Vec<_>>>()?;
    // A secret is typed where it is asked, never through the inbox; a choice is made in the TUI.
    let answers = match questions.as_slice() {
        [only] if !only.secret && (!only.options || only.other) => Some(only.id.to_owned()),
        _ => None,
    };
    let summary = questions
        .iter()
        .map(|q| q.question)
        .collect::<Vec<_>>()
        .join(" / ");
    Some(Question {
        thread_id: thread_id.to_owned(),
        item_id: Some(item_id.to_owned()),
        key: item_id.to_owned(),
        summary: if summary.is_empty() {
            "The agent asks you a question".to_owned()
        } else {
            whole(&summary, 300).to_owned()
        },
        answers,
    })
}

fn elicitation(params: &Js) -> Option<Question> {
    let thread_id = string(params, "threadId")?;
    let server = string(params, "serverName")?;
    let message = optional_string(params, "message").ok()?;
    let summary = format!(
        "{server} asks: {}",
        message.unwrap_or("input in the terminal")
    );
    let key = Js::Array(vec![
        Js::String("elicitation".to_owned()),
        Js::String(server.to_owned()),
        message.map_or(Js::Null, |m| Js::String(m.to_owned())),
    ]);
    Some(Question {
        thread_id: thread_id.to_owned(),
        item_id: None,
        key: key.stringify(),
        summary: whole(&summary, 300).to_owned(),
        answers: None,
    })
}

fn permissions(params: &Js) -> Option<Question> {
    let thread_id = string(params, "threadId")?;
    let item_id = string(params, "itemId")?;
    let reason = nullish_string(params, "reason").ok()?;
    Some(Question {
        thread_id: thread_id.to_owned(),
        item_id: Some(item_id.to_owned()),
        key: item_id.to_owned(),
        summary: match truthy(reason) {
            Some(reason) => format!("Grant more permissions ({reason})"),
            None => "Grant more permissions".to_owned(),
        },
        answers: None,
    })
}

/// A request as a question for the inbox, or none for any other request.
pub(super) fn read_question(method: &str, params: &Js) -> Option<Question> {
    match method {
        "item/tool/requestUserInput" => user_input(params),
        "mcpServer/elicitation/request" => elicitation(params),
        "item/permissions/requestApproval" => permissions(params),
        _ => None,
    }
}

/// The result that answers a single question with the human's text.
pub(super) fn question_result(question_id: &str, text: &str) -> Value {
    let mut answers = serde_json::Map::new();
    answers.insert(question_id.to_owned(), json!({ "answers": [text] }));
    json!({ "answers": answers })
}

/// The id of one of the app-server's own requests, unique on its connection.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum RequestId {
    Number(f64),
    Text(String),
}

/// The request a `serverRequest/resolved` notification says was answered, by another client or
/// the TUI; none for any other notification.
pub(super) fn read_resolved(method: &str, params: &Js) -> Option<RequestId> {
    if method != "serverRequest/resolved" {
        return None;
    }
    match object(params)?.field("requestId")? {
        Js::Number(n) => Some(RequestId::Number(*n)),
        Js::String(s) => Some(RequestId::Text(s.clone())),
        _ => None,
    }
}
