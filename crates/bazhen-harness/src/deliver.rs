//! Mail out to a harness, and the answers to what it holds open.

use crate::ToolKey;
use crate::launch::SessionRef;
use bazhen_protocol::mail_events::ApprovalDecision;

/// A message the daemon hands a harness that takes mail by push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outgoing<'a> {
    pub message_id: &'a str,
    pub body: &'a str,
    /// The agent's session, which the message goes into.
    pub session: Option<&'a SessionRef>,
}

/// What one push did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pushed {
    /// The harness took it; `offline` when it was stored for its server to pick up later.
    Accepted { offline: bool },
    /// It failed this time, and may be tried again.
    Failed { detail: String },
    /// Not now: it stays queued, to be pushed when the harness can take it.
    NotNow,
}

/// Why a harness refuses mail for an agent at send time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailRefusal {
    pub reason: String,
}

/// What the agent the daemon would send to holds, for whether its harness takes mail now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRef<'a> {
    pub session: Option<&'a SessionRef>,
}

/// What the daemon held open and now answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pending<'a> {
    Waiter,
    Fold,
    Approval,
    /// A request from the harness's server, by its method and the key its approval was asked
    /// under, from which the adapter reads which request to answer.
    ServerRequest {
        method: &'a str,
        key: &'a ToolKey,
    },
}

/// How the daemon resolved what it held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution<'a> {
    /// The agent's queued mail, oldest first, which the answer hands over as much of as fits.
    Mail(&'a [Mail<'a>]),
    /// The human's answer to an approval.
    Decision(ApprovalDecision),
    /// The human's answer to a question.
    Text(&'a str),
    /// Nothing came: the harness decides, as it would have alone.
    Nothing,
}

/// One message handed over, and when it was first offered if it was before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mail<'a> {
    pub id: &'a str,
    pub body: &'a str,
    pub first_offered: Option<&'a str>,
}

/// The answer to what the daemon held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// What a hook prints and exits with.
    Hook(HookOutput),
    /// A server request's JSON result.
    Rpc(String),
    /// It can't be answered now: the request's server has gone.
    Unavailable,
}

/// What a hook client prints and exits with, verbatim; it knows no harness format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookOutput {
    pub exit_code: u8,
    pub stdout: String,
    pub stderr: String,
    /// The messages it hands the harness, by id, which the daemon records as offered.
    pub carried: Vec<String>,
}

impl HookOutput {
    /// Nothing printed, exit 0: the harness goes on as it would.
    pub fn quiet() -> Self {
        Self {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            carried: Vec::new(),
        }
    }
}
