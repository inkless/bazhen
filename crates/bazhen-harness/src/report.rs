//! What a harness reports, and the facts and reply an adapter reads from it.

use crate::launch::SessionRef;
use bazhen_protocol::agent_events::{CompactedSign, ReadySign};
use bazhen_protocol::agents::{ActivityValue, Usage, UsageLimit};
use bazhen_protocol::ids::AgentId;

/// One report from a harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Report<'a> {
    /// A hook the launch installed, by its event, with the harness's own input as JSON.
    Hook { event: &'a str, payload: &'a [u8] },
    /// A notification over the harness's own server, with its params as JSON.
    Notification { method: &'a str, params: &'a [u8] },
    /// A request from the harness's own server, which the daemon answers with [`Answer::Rpc`].
    ///
    /// [`Answer::Rpc`]: crate::Answer::Rpc
    ServerRequest {
        method: &'a str,
        params: &'a [u8],
        /// The request's id as JSON text, such as `7` or `"a"`, as a notification that it was
        /// resolved names it.
        id: &'a str,
    },
    /// The title the agent's terminal shows, as the terminal's runtime reports it.
    TerminalTitle { title: &'a str },
}

/// What the daemon holds for the reporting agent that an adapter reads a report against.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IngestContext<'a> {
    /// The agent the report is for: the one a hook names, once the daemon has identified it, or
    /// the one bound to the session [`crate::Harness::route`] found for a channel's report.
    pub agent: Option<&'a AgentId>,
    /// The agent's messages a prompt may carry as a wake handed them over: written or offered
    /// before, and not yet seen, by id.
    pub offered: &'a [String],
    /// The session the agent is bound to, against which a harness tells a terminal title naming
    /// it from one naming another.
    pub session: Option<&'a SessionRef>,
}

/// What an adapter read from one report.
#[derive(Debug, Clone, PartialEq)]
pub struct Ingested {
    pub observed: Vec<Keyed>,
    /// Which of the harness's sessions made the report, when it says.
    pub origin: Option<Origin>,
    pub reply: Reply,
    /// What the daemon must find of the report's session to hold the reply; when it doesn't, it
    /// answers quiet.
    pub reply_gate: Gate,
}

impl Ingested {
    /// A report that says nothing and wants no answer.
    pub fn nothing() -> Self {
        Self {
            observed: Vec::new(),
            origin: None,
            reply: Reply::Quiet,
            reply_gate: Gate::None,
        }
    }
}

/// What the report's sender is answered with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// Nothing: the harness goes on as it would.
    Quiet,
    /// This output, now.
    Now(crate::HookOutput),
    /// Held open until the daemon resolves it, then answered by [`crate::Harness::answer`].
    Hold(Held),
}

/// A report the daemon holds open, and what it waits for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Held {
    /// The waiter, answered with mail when some comes, which wakes an idle session.
    Waiter,
    /// A tool call's end in the turn `prompt_id`, answered at once with any queued mail folded
    /// into the turn.
    Fold { prompt_id: String },
    /// A permission request, answered from the inbox within `wait_ms`, or left to the TUI. None
    /// for one with no deadline: the TUI asks the same request, and whichever answers first wins.
    Approval { key: ToolKey, wait_ms: Option<u64> },
}

/// A fact, who it is about, and what the daemon must find of the report's session to apply it.
#[derive(Debug, Clone, PartialEq)]
pub struct Keyed {
    pub key: Key,
    pub gate: Gate,
    pub fact: Observed,
}

/// What the daemon must find of the session a report came from before it applies a fact or
/// holds a reply. It asks once per report, and skips what doesn't pass, keeping the order of the
/// rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Nothing: whichever of the agent's sessions or subagents made the report.
    None,
    /// That it came from the agent's session, or a subagent of it: a subagent says what the
    /// agent is doing too, another session never does.
    InSession,
    /// That it came from the agent's own session and no subagent: one that takes or confirms
    /// mail. A report with a [`Observed::SessionStarted`] may first move the agent's binding to
    /// its session, which then passes.
    Owner,
}

impl Keyed {
    pub(crate) fn agent(agent: &AgentId, gate: Gate, fact: Observed) -> Self {
        Self {
            key: Key::Agent(agent.clone()),
            gate,
            fact,
        }
    }
}

/// Who a fact is about. A report over a harness's server may belong to no agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// An agent, as a hook names the one it ran for.
    Agent(AgentId),
    /// A session of the harness's, such as a thread: the daemon finds the agents on it by their
    /// stored external refs, and never parses one itself.
    Session(SessionKey),
    /// The harness as a whole: its account, whose limits cover every agent on it, and what its
    /// server announces to all of them.
    Account,
}

/// A harness session as its reports name it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionKey(pub String);

/// Which of the harness's sessions made a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub session: Option<SessionRef>,
    /// Where that session's conversation is kept, as an absolute path.
    pub transcript: Option<String>,
    /// One of the session's subagents, by its id, when one made the report.
    pub subagent: Option<String>,
}

/// One fact a report gives, which the daemon turns into events. A report's facts come in the
/// order the daemon applies them, each under its [`Gate`]: a turn's end settles the mail it took
/// before its activity is recorded.
#[derive(Debug, Clone, PartialEq)]
pub enum Observed {
    /// The report came from the agent's session: when it passes [`Gate::Owner`] and came from the
    /// TUI the daemon started, the TUI is up.
    Ready {
        sign: ReadySign,
    },
    /// The session started or started over, which may move the agent's binding; `compacted` when
    /// it only compacted the session the agent is in.
    SessionStarted {
        compacted: bool,
    },
    Compacted {
        sign: CompactedSign,
    },
    Activity(HarnessActivity),
    Usage(Usage),
    /// The account's usage limits, under [`Key::Account`].
    AccountLimits(Vec<UsageLimit>),
    /// The server unloaded the session, so its facts stop until [`crate::Session::reload`] picks
    /// it up again.
    Unloaded,
    /// The new connection picked the session up again ([`crate::Session::connected`]), and never
    /// one it failed to: the requests the server sends for it come again, so one asked on an
    /// earlier connection that doesn't was lost with the server that held it.
    Resumed,
    /// The server started a session, under [`Key::Account`]: each follow that is pending, or gave
    /// up, and [`crate::Session::may_follow_to`] it, is tried again.
    SessionAnnounced {
        session: SessionKey,
    },
    /// A tool call started, keyed as the permission request about it will be.
    ToolStarted {
        key: ToolKey,
        use_id: String,
    },
    /// A tool call ended.
    ToolSettled {
        use_id: String,
    },
    /// A permission request the inbox can answer.
    ApprovalAsked {
        key: ToolKey,
        summary: String,
        /// Whether it asks a question the inbox answers with the human's text, rather than allow
        /// or deny.
        question: bool,
    },
    /// A question only the TUI can take an answer to.
    QuestionAsked {
        key: ToolKey,
        summary: String,
    },
    /// A request the inbox could answer was settled elsewhere.
    ApprovalSettled {
        key: ToolKey,
        how: Settled,
    },
    /// A prompt started a turn, carrying these of [`IngestContext::offered`] as a wake handed
    /// them over.
    PromptStarted {
        prompt_id: Option<String>,
        carries: Vec<String>,
    },
    TurnStarted,
    /// A turn ended, whoever's session it ran in: the questions it asked are over.
    TurnOver,
    TurnEnded {
        prompt_id: Option<String>,
    },
    TurnFailed {
        prompt_id: Option<String>,
        /// The harness's name for the error, such as `server_error`.
        error: Option<String>,
    },
    /// A message the agent sent with the harness's own messaging, in the tool call `use_id`.
    MessageObserved {
        use_id: String,
        sent: SentMessage,
    },
    /// A message the harness took into a turn, under the session it was taken on.
    MailTaken {
        message_id: String,
    },
    SubagentStarted {
        id: String,
    },
    SubagentStopped {
        id: String,
    },
    /// A subagent stopped, whoever's session it ran in: the requests it made are over.
    SubagentOver {
        id: String,
    },
    /// Hold the agent's mail: its TUI is moving between sessions.
    Hold,
    Release,
    /// The terminal's title isn't the agent's session: it names another, or perhaps none at all.
    /// [`Session::follow`](crate::Session::follow) reads the candidate, and leaves the agent
    /// untracked when it names no session.
    TitleNames {
        candidate: String,
    },
}

/// Which tool call a permission request is about, as far as the harness says: who made it, in
/// which prompt, and the call itself. A request carries no call id, so it is matched to the
/// started call with the same key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ToolKey {
    /// The text that keys the call, equal for the same call however it is reported.
    pub key: String,
    /// The subagent that made it, by its id; none for the agent's own.
    pub caller: Option<String>,
    pub prompt_id: Option<String>,
}

impl ToolKey {
    /// Whether the agent itself made the call, as opposed to one of its subagents.
    pub fn main_agent(&self) -> bool {
        self.caller.is_none()
    }
}

/// How a request the inbox could answer was settled elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    AnsweredInTui,
    Superseded,
    AgentClosed,
    Stale,
}

/// What a report says the agent is doing, before the daemon stamps and records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessActivity {
    pub value: ActivityValue,
    pub detail: Option<String>,
    pub limit: Option<LimitStop>,
}

impl HarnessActivity {
    pub(crate) fn of(value: ActivityValue) -> Self {
        Self {
            value,
            detail: None,
            limit: None,
        }
    }
}

/// A turn's end the account's limit may have caused: `Quota` when the harness names the usage
/// limit, `Rate` for a rate limit it can't tell from one that passes in moments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitStop {
    Quota,
    Rate,
}

/// A message the agent sent with the harness's own messaging, as its report gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMessage {
    /// The session's name as the agent wrote it.
    pub to: String,
    pub text: String,
    pub summary: Option<String>,
    /// Whether the harness said it was sent.
    pub accepted: bool,
}
