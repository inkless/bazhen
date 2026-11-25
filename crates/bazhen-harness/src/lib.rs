//! The harnesses Bazhen runs agents in, each behind one trait (foundation-design §11.1). A harness
//! is reached by its hooks, by its own server over a channel the daemon provides, or both. An
//! adapter never opens a socket or a process and never touches the store: it is handed ports,
//! reads the reports it is given, and says what they mean and how to answer them. So the daemon
//! names no harness: it reaches the adapters it serves only through [`production`], and
//! [`compiled`], which also builds those it doesn't serve yet, is for tests and fuzz targets.

mod claude_code;
mod codex;
mod deliver;
mod js;
mod launch;
mod report;
mod text;

/// The protocol's ids this API takes, so a caller needs no other crate to drive it.
pub use bazhen_protocol::agents::HarnessId;
pub use bazhen_protocol::ids::AgentId;
pub use deliver::{
    AgentRef, Answer, HookOutput, Mail, MailRefusal, Outgoing, Pending, Pushed, Resolution,
};
pub use launch::{Evidence, LaunchError, LaunchRequest, LaunchSpec, SessionRef};
pub use report::{
    Gate, HarnessActivity, Held, IngestContext, Ingested, Key, Keyed, LimitStop, Observed, Origin,
    Reply, Report, SentMessage, SessionKey, Settled, ToolKey,
};

use bazhen_protocol::agents::{ActivityValue, ExternalRef};
use bazhen_protocol::daemon::ToolCalls;
use bazhen_protocol::shells::TuiTheme;
use serde_json::Value;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// A future an adapter's async method returns, boxed so a `dyn Harness` can be held.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One harness, as the daemon drives it.
pub trait Harness: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    /// The themes it can start its TUI in; asked for another, it starts in one of these.
    fn themes(&self) -> &'static [TuiTheme];
    /// How to start the TUI on a new session. A harness with a server may make the session over
    /// `channel` first; one with none is given none.
    fn launch<'a>(
        &'a self,
        request: &'a LaunchRequest,
        channel: Option<&'a dyn ChannelPort>,
    ) -> BoxFuture<'a, Result<LaunchSpec, LaunchError>>;
    /// How to start the TUI again on the agent's session, or none for a harness that can't: a
    /// fresh session would rebind the agent (foundation-design §3.1).
    fn resume<'a>(
        &'a self,
        request: &'a LaunchRequest,
        session: &'a ExternalRef,
        channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, LaunchError>>>;
    /// Whether [`Harness::resume`] would find the session, by what its reports said of it.
    fn can_resume(&self, evidence: &Evidence<'_>) -> bool;
    /// One report in, the facts it gives and how to answer it out.
    fn ingest(&self, report: Report<'_>, context: &IngestContext<'_>) -> Ingested;
    /// Whether mail sent to a running agent now reaches it with nothing else happening.
    fn listening(&self, agent: &Listen) -> bool;
    /// What to tell the user when an agent's TUI never says it is up, for a harness whose sign
    /// of it can fail to come.
    fn not_ready_hint(&self) -> Option<&'static str>;
    /// Whether the agent can be sent mail now, asked before the mail is queued.
    ///
    /// # Errors
    ///
    /// The harness's reason, when it takes no mail for the agent.
    fn accepts_mail(&self, agent: &AgentRef<'_>) -> Result<(), MailRefusal>;
    /// Hands one message to a harness that takes mail by push.
    fn push<'a>(&'a self, mail: &'a Outgoing<'a>, port: &'a dyn PushPort) -> BoxFuture<'a, Pushed>;
    /// The answer to a report the daemon held, once it is resolved.
    fn answer(&self, to: &Pending<'_>, with: Resolution<'_>) -> Answer;
    /// The harness's own server, for one that has one (foundation-design §11.1 `connect`).
    fn session(&self) -> Option<Box<dyn Session>>;
    /// The harness's block of `bazhen doctor`, for one that has one.
    fn doctor<'a>(
        &'a self,
        channel: Option<&'a dyn ChannelPort>,
        run: &'a dyn RunPort,
    ) -> BoxFuture<'a, Option<HarnessDoctor>>;
}

/// What a harness can do, which decides what the daemon does for its agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub delivery: Delivery,
    /// Whether its permission requests can be answered from the inbox.
    pub approvals: bool,
    pub activity: ActivitySource,
}

/// How mail reaches an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// It doesn't: a send to the agent is refused.
    None,
    /// The agent's hooks take it: offered, folded into a turn, or woken for.
    Pull,
    /// The daemon hands each message over with [`Harness::push`].
    Push,
}

/// Where an agent's activity comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivitySource {
    /// Nowhere: none is shown.
    None,
    /// Its hooks, which say nothing again after a restart until the next one runs.
    Hooks,
    /// The harness's server, which says it again on each connect.
    Channel,
}

/// What the daemon holds of a running agent, for whether mail reaches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listen {
    pub activity: Option<ActivityValue>,
    /// What of the agent's would take mail now, as its hooks last said.
    pub hooks: Waiting,
    /// Whether the agent is bound to a session its mail can go to.
    pub bound: bool,
    /// Whether its mail is held, as while its TUI moves between sessions.
    pub held: bool,
}

/// What of an agent's would take mail now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    /// Its waiter, which wakes the session.
    Waiter,
    /// A running turn, whose tool calls can fold mail in.
    Turn,
    Nothing,
}

/// A harness's own server, reached over a connection the daemon owns. The adapter exchanges
/// JSON-RPC messages; it never sees the socket.
pub trait ChannelPort: Send + Sync {
    /// One request's result.
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, ChannelError>>;
    /// One notification, which the server answers with nothing: an error is the channel's.
    fn notify<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<(), ChannelError>>;
}

/// A request over a channel that failed: the server's JSON-RPC error, or the channel's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelError {
    pub kind: ChannelErrorKind,
    pub message: String,
}

/// Whether the server refused a request, or it failed some other way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelErrorKind {
    /// The server can't take the request as sent: JSON-RPC's invalid request, method not found or
    /// invalid params (-32600 to -32602). Sending it again won't help.
    Refused,
    /// Anything else: any other error the server answered, a timeout, or the connection ending.
    Failed,
}

impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ChannelError {}

/// The daemon's bounded run of a command, such as a harness's CLI, in the user's environment as
/// the daemon captured it for agents, so the command finds the harness the agents run.
pub trait RunPort: Send + Sync {
    fn run<'a>(
        &'a self,
        argv: &'a [String],
        timeout: Duration,
    ) -> BoxFuture<'a, Result<Output, RunError>>;
}

/// What a command printed, as UTF-8 with any other byte replaced, and how it ended: none when a
/// signal ended it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// A command that couldn't be run, or ran past its timeout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunError {
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RunError {}

/// What a push may use: a command, and the harness's channel while it is connected.
pub trait PushPort: RunPort {
    fn channel(&self) -> Option<&dyn ChannelPort>;
}

/// A harness's server as the daemon keeps one connection to it.
pub trait Session: Send {
    /// Where its server listens, and how to start it.
    fn endpoint(&self) -> Endpoint;
    /// The session a report over the channel is from. The daemon calls it before
    /// [`Harness::ingest`], and hands `ingest` the agent bound to that session and the session.
    fn route(&self, report: &Report<'_>) -> Option<SessionKey>;
    /// What the daemon says first on each connection, before anything else is sent: the server's
    /// version, none when the server names none, or why the server can't be used.
    ///
    /// # Errors
    ///
    /// The request's, or the server's refusal to serve Bazhen, as one set up for another home.
    fn handshake<'a>(
        &'a mut self,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Result<Option<String>, ChannelError>>;
    /// The connection is up, after [`Session::handshake`]: picks up each bound session again, so
    /// its facts come back, and says [`Observed::Resumed`] of each it picked up.
    fn connected<'a>(
        &'a mut self,
        channel: &'a dyn ChannelPort,
        bound: &'a [Bound],
    ) -> BoxFuture<'a, Vec<Keyed>>;
    /// Picks up one session the server unloaded ([`Observed::Unloaded`]), alone: what holds of
    /// the rest of the connection stands. The daemon asks again, from 1 s doubling to 60 s apart,
    /// until it is loaded, the agent leaves the session, or the connection drops: on the next,
    /// [`Session::connected`] picks up every bound session again.
    fn reload<'a>(
        &'a mut self,
        agent: &'a Bound,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Reloaded>;
    /// The connection went down.
    fn disconnected(&mut self) -> Vec<Keyed>;
    /// One try at moving an agent to the session its terminal's title names.
    fn follow<'a>(
        &'a mut self,
        agent: &'a Bound,
        candidate: &'a str,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Followed>;
    /// Whether a follow of `candidate` that is pending, or gave up, may find the session the
    /// server just announced ([`Observed::SessionAnnounced`]). On a match the daemon reads the
    /// terminal's title again and sends it as a fresh [`Report::TerminalTitle`], rather than
    /// trying the old candidate. A follow with no candidate, its title unread, is never asked
    /// about.
    fn may_follow_to(&self, candidate: &str, announced: &SessionKey) -> bool;
}

/// Where a harness's server listens, and the command that starts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub address: String,
    pub start: Vec<String>,
}

/// A running agent, the session it is bound to, and the launch it was last started with, which
/// picking the session up again keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bound {
    pub agent: AgentId,
    pub session: ExternalRef,
    pub launch: LaunchRequest,
}

/// What one try at picking up an unloaded session did.
#[derive(Debug, Clone, PartialEq)]
pub enum Reloaded {
    /// It is loaded again, with what holds of it now.
    Loaded(Vec<Keyed>),
    /// It isn't yet: try again later.
    NotYet,
}

/// What one try at following a title did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Followed {
    /// The agent is on that session now.
    Bound(ExternalRef),
    /// The session can't be found yet: try again.
    Pending,
    /// It won't be: the agent stays where it was.
    Untracked { detail: String },
}

/// Looks up one text by name, such as a variable in an environment or a file's text by its path.
pub type Lookup = dyn Fn(&str) -> Option<String> + Send + Sync;

/// Reads the transcript at a path, its first complete line first, until `line` says it is the one
/// looked for: whether one was. A path that can't be read holds none.
pub type ScanTranscript = dyn Fn(&str, &mut dyn FnMut(&str) -> bool) -> bool + Send + Sync;

/// What the adapters [`production`] builds take from the world.
pub struct HarnessDeps {
    /// A new session id, for a harness whose sessions Bazhen names.
    pub new_session_id: Box<dyn Fn() -> String + Send + Sync>,
    /// The hook client as a shell command; the adapter appends the event.
    pub hook_command: String,
    /// The daemon's own environment, by name, for the settings Bazhen takes for a harness.
    pub daemon_env: Box<Lookup>,
    /// The user's environment as the daemon captured it, by name, where a harness's own
    /// configuration is found.
    pub user_env: Box<Lookup>,
    /// The user's home directory.
    pub home: String,
    /// A file's text, any byte that isn't UTF-8 replaced, or none for one that can't be read: an
    /// adapter reads its harness's settings with it, knowing their format where the daemon doesn't.
    pub read_file: Box<Lookup>,
    /// Reads a session's transcript for a line it can be resumed from.
    pub scan_transcript: Box<ScanTranscript>,
    /// The time in ms, for how long a transcript's answer stands.
    pub now_ms: Box<dyn Fn() -> i64 + Send + Sync>,
    /// The daemon's socket, for a harness's server to reach the daemon back on.
    pub daemon_socket: String,
    /// A path with every link in it resolved, as `realpath` gives it, or none for one that
    /// doesn't exist: a harness's server may name the same directory by another path.
    pub real_path: Arc<Lookup>,
}

impl fmt::Debug for HarnessDeps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HarnessDeps")
            .field("hook_command", &self.hook_command)
            .field("home", &self.home)
            .field("daemon_socket", &self.daemon_socket)
            .finish_non_exhaustive()
    }
}

/// A harness's block of `bazhen doctor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessDoctor {
    /// The version of the harness's server that answered, if one did.
    pub server: Option<String>,
    /// The version of the harness's CLI, if it ran.
    pub cli: Option<String>,
    /// Whether the peer reader knows the harness's server, for one whose agents' commands it
    /// tells apart from the user's; none when that wasn't read.
    pub tool_calls: Option<ToolCalls>,
}

/// The harnesses the daemon runs agents in, by id.
pub struct Harnesses {
    served: Vec<(HarnessId, Box<dyn Harness>)>,
}

impl fmt::Debug for Harnesses {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list()
            .entries(self.served.iter().map(|(id, _)| id))
            .finish()
    }
}

impl Harnesses {
    /// These harnesses, as a test drives the daemon with its own.
    pub fn new(served: Vec<(HarnessId, Box<dyn Harness>)>) -> Self {
        Self { served }
    }

    /// The harness by its id, or none for one this daemon doesn't serve.
    pub fn get(&self, id: HarnessId) -> Option<&dyn Harness> {
        self.served
            .iter()
            .find(|(served, _)| *served == id)
            .map(|(_, harness)| harness.as_ref())
    }
}

/// The harnesses this build serves.
pub fn production(deps: HarnessDeps) -> Harnesses {
    Harnesses::new(vec![(
        HarnessId::ClaudeCode,
        Box::new(claude_code::ClaudeCode::new(deps)),
    )])
}

/// Every adapter this build has, served or not, as a test or a fuzz target drives one the daemon
/// doesn't serve yet. The daemon's own code builds from [`production`].
pub fn compiled(deps: HarnessDeps) -> Harnesses {
    let codex = codex::Codex::new(&deps);
    Harnesses::new(vec![
        (
            HarnessId::ClaudeCode,
            Box::new(claude_code::ClaudeCode::new(deps)),
        ),
        (HarnessId::Codex, Box::new(codex)),
    ])
}
