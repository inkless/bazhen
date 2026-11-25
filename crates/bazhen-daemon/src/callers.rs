//! Who called on the socket (`auth/callers.ts`): the human, an agent, or refused, from what the
//! request presents and whose process made it; and the guard that holds each route to its callers.

use axum::extract::{OriginalUri, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::ids::AgentId;

use crate::paired::{ThroughForwarder, Viewer};
use crate::peer::{self, PeerRead, PeerSocket, Reading, Via};
use crate::routes::{Shared, fail, header, internal, retry_soon};
use crate::writer::Writer;

/// Who called, as the guard found it: an agent, or the human as none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Caller(pub(crate) Option<AgentId>);

/// Who a socket caller is: the human, an agent, or refused, `retry` when it wasn't read in time,
/// so the same call may yet be answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Identity {
    Human,
    Agent(AgentId),
    /// A TCP caller whose socket no readable process holds, each one that may hold it unseen the
    /// human's, presenting no agent's credential: the human only where its request carries a
    /// device paired the same way (`http_guard`).
    Unheld,
    Refused {
        reason: String,
        retry: bool,
    },
}

/// Why a caller whose process wasn't read in time is refused.
pub(crate) const LATE_REASON: &str = "the caller's process wasn't read in time; try again";

fn refused(reason: impl Into<String>) -> Identity {
    Identity::Refused {
        reason: reason.into(),
        retry: false,
    }
}

/// What the store says of an agent's credentials.
pub(crate) trait Credentials {
    fn agent_of(&mut self, token: &str) -> rusqlite::Result<Option<AgentId>>;
    fn untokened(&mut self, agent_id: &str) -> rusqlite::Result<bool>;
    fn codex_agent(&mut self, thread: &str) -> rusqlite::Result<Option<AgentId>>;
}

/// Credentials read through a reader connection of their own, opened only once one is asked.
struct Stored<'a> {
    store: &'a Writer,
    reader: Option<bazhen_store::Reader>,
}

impl Stored<'_> {
    fn reads(&mut self) -> rusqlite::Result<bazhen_store::Reads<'_>> {
        let reader = match self.reader.take() {
            Some(reader) => reader,
            None => self.store.reader()?,
        };
        Ok(self.reader.insert(reader).reads())
    }
}

impl Credentials for Stored<'_> {
    fn agent_of(&mut self, token: &str) -> rusqlite::Result<Option<AgentId>> {
        crate::tokens::agent_of(self.reads()?, token)
    }

    fn untokened(&mut self, agent_id: &str) -> rusqlite::Result<bool> {
        self.reads()?.agent_untokened(agent_id)
    }

    fn codex_agent(&mut self, thread: &str) -> rusqlite::Result<Option<AgentId>> {
        Ok(self
            .reads()?
            .codex_agent(thread)?
            .as_deref()
            .and_then(AgentId::parse))
    }
}

/// What a caller presents: an agent token, an agent id, and the Codex thread it runs in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Presented {
    pub(crate) token: Option<String>,
    pub(crate) said: Option<String>,
    pub(crate) thread: Option<String>,
}

/// What a request presents, by its headers. An empty agent id is none: a Codex thread sets
/// `BAZHEN_AGENT_ID` empty over the app-server's own environment, which has no way to unset it.
pub(crate) fn presented_by(headers: &HeaderMap) -> Presented {
    Presented {
        token: header(headers, "bazhen-agent-token"),
        said: header(headers, "bazhen-agent-id").filter(|said| !said.is_empty()),
        thread: header(headers, "bazhen-codex-thread"),
    }
}

/// Who a caller is (foundation-design §9.1), from what it presents and, with `reading`, whose
/// process made the call. A token names its agent, and an id beside it must be that agent's; an id
/// alone counts only for an agent from before agents had tokens; a caller presenting neither is
/// the human. A Codex tool call is the live agent bound to the thread it names, else refused.
///
/// # Errors
///
/// The store's, reading a credential.
pub(crate) fn identify(
    credentials: &mut impl Credentials,
    presented: &Presented,
    reading: Option<&Reading>,
) -> rusqlite::Result<Identity> {
    match reading {
        Some(Reading::Refused(reason)) => return Ok(refused(reason.clone())),
        Some(Reading::Late) => {
            return Ok(Identity::Refused {
                reason: LATE_REASON.to_owned(),
                retry: true,
            });
        }
        Some(Reading::Codex(via)) => return as_codex(credentials, presented, *via),
        Some(Reading::Agent(agent, _)) => return as_peer(credentials, presented, agent),
        Some(Reading::Withheld) if presented.thread.is_some() => {
            return as_codex(credentials, presented, Via::Environment);
        }
        Some(Reading::Unheld) => {
            let presents =
                presented.token.is_some() || presented.said.is_some() || presented.thread.is_some();
            return Ok(if presents {
                refused(
                    "a caller whose socket no readable process holds can't present an agent's \
                     credentials",
                )
            } else {
                Identity::Unheld
            });
        }
        Some(Reading::Withheld | Reading::Outside) | None => {}
    }
    if let Some(token) = &presented.token {
        let Some(agent) = credentials.agent_of(token)? else {
            return Ok(refused("the agent token is no live agent's"));
        };
        if let Some(said) = presented
            .said
            .as_ref()
            .filter(|said| *said != agent.as_str())
        {
            return Ok(refused(format!("the agent token is not agent {said}'s")));
        }
        return Ok(Identity::Agent(agent));
    }
    let Some(said) = &presented.said else {
        return Ok(Identity::Human);
    };
    let Some(agent) = AgentId::parse(said) else {
        return Ok(refused(format!("not an agent id: {said}")));
    };
    if !credentials.untokened(said)? {
        return Ok(refused(format!(
            "agent {said} must present its agent token"
        )));
    }
    Ok(Identity::Agent(agent))
}

/// A Codex thread id as the app-server makes them; anything else names no thread.
fn is_codex_thread(thread: &str) -> bool {
    (1..=64).contains(&thread.len())
        && thread
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A Codex tool call is the live agent bound to the thread it names. Under the server, what else
/// it presents is the server's environment, not the thread's agent's, so it isn't held against
/// the call; a caller marked by its own environment only must present nothing of another agent's.
fn as_codex(
    credentials: &mut impl Credentials,
    presented: &Presented,
    via: Via,
) -> rusqlite::Result<Identity> {
    let Some(thread) = &presented.thread else {
        return Ok(refused("a Codex tool call names no thread"));
    };
    if !is_codex_thread(thread) {
        return Ok(refused("a Codex tool call names no Codex thread"));
    }
    let Some(agent) = credentials.codex_agent(thread)? else {
        return Ok(refused(format!("Codex thread {thread} is no live agent's")));
    };
    match via {
        Via::Server => Ok(Identity::Agent(agent)),
        Via::Environment => as_peer(credentials, presented, &agent),
    }
}

/// A caller whose own process is `agent`'s is that agent, whatever it leaves out; a token or an id
/// it does present must be that agent's own.
fn as_peer(
    credentials: &mut impl Credentials,
    presented: &Presented,
    agent: &AgentId,
) -> rusqlite::Result<Identity> {
    if let Some(token) = &presented.token
        && credentials.agent_of(token)?.as_ref() != Some(agent)
    {
        return Ok(refused(format!(
            "the agent token is not agent {}'s, whose process calls",
            agent.as_str()
        )));
    }
    if let Some(said) = presented
        .said
        .as_ref()
        .filter(|said| *said != agent.as_str())
    {
        return Ok(refused(format!(
            "agent {}'s process names agent {said}",
            agent.as_str()
        )));
    }
    Ok(Identity::Agent(agent.clone()))
}

/// The socket routes an agent may use, each by its method. Every other route and method is the
/// human's, whether or not it is listed below: one nobody classified refuses agents.
pub(crate) const AGENT_OPEN: &[(&str, &str)] = &[
    ("GET", "/v1/health"),
    ("GET", "/v1/state"),
    ("GET", "/v1/caller"),
    ("GET", "/v1/roles"),
    ("GET", "/v1/daemon/doctor"),
    ("POST", "/v1/tasks"),
    ("POST", "/v1/tasks/delegate"),
    ("GET", "/v1/tasks/:id"),
    ("POST", "/v1/tasks/:id/assign"),
    ("POST", "/v1/tasks/:id/unassign"),
    ("POST", "/v1/tasks/:id/finish"),
    ("POST", "/v1/tasks/:id/notes"),
    ("POST", "/v1/tasks/:id/messages"),
    ("POST", "/v1/escalations"),
    ("POST", "/v1/agents/:id/messages"),
    ("POST", "/v1/agents/:id/rename"),
    ("POST", "/v1/messages/wait"),
    ("POST", "/v1/waits"),
    ("POST", "/v1/shells/:id/report"),
    ("POST", "/v1/shells/:id/prompt"),
    ("POST", "/v1/shells/:id/decline"),
];

/// The human's routes, on any method, each with what an agent is told it can't do.
pub(crate) const HUMANS_ONLY: &[(&str, &str)] = &[
    ("/v1/pairing/codes", "pair a device"),
    ("/v1/pairing", "pair a browser"),
    ("/v1/devices", "list paired devices"),
    ("/v1/devices/:id/revoke", "revoke a device"),
    ("/v1/daemon/stop", "stop the daemon"),
    ("/v1/daemon/env", "replace the agents' environment"),
    ("/v1/attention/:id/answer", "answer an attention item"),
    ("/v1/attention/:id/reply", "reply to an attention item"),
    ("/v1/attention/:id/dismiss", "dismiss an attention item"),
    ("/v1/attention/:id/resend", "resend an attention item"),
    ("/v1/notices/:id/dismiss", "dismiss a notice"),
    ("/v1/agents", "launch an agent but by delegating"),
    ("/v1/agents/:id/close", "close an agent"),
    ("/v1/agents/:id/respawn", "respawn an agent"),
    ("/v1/agents/:id/relaunch", "relaunch an agent"),
    ("/v1/agents/:id/signal", "signal an agent"),
    ("/v1/shells", "open a shell"),
    ("/v1/shells/:id/close", "close a shell"),
    ("/v1/shells/:id/restart", "restart a shell"),
    ("/v1/shells/:id/rename", "rename a shell"),
    ("/v1/shells/:id/unlink", "unlink a shell"),
    ("/v1/terminals/:id/screen", "read a terminal's screen"),
];

/// Routes the guard doesn't identify a caller for: the hooks identify their agent themselves.
pub(crate) const SELF_IDENTIFIED: &[&str] = &["/v1/hooks", "/v1/hooks/ack"];

/// Whether `path` is one `pattern` names, as Hono matches it: each `:name` one segment, not empty.
fn matches(pattern: &str, path: &str) -> bool {
    let mut path = path.split('/');
    let mut pattern = pattern.split('/');
    loop {
        match (pattern.next(), path.next()) {
            (None, None) => return true,
            (Some(p), Some(s)) if p.starts_with(':') && !s.is_empty() => {}
            (Some(p), Some(s)) if p == s => {}
            _ => return false,
        }
    }
}

/// Who called, and how its process is the agent it reads as, or why the store couldn't say.
async fn who(
    shared: &Shared,
    socket: Option<PeerSocket>,
    presented: Presented,
) -> Result<(Identity, Option<String>), String> {
    let read = match &socket {
        Some(socket) => Some(shared.peers.read(socket).await),
        None => None,
    };
    identified_how(shared, read, presented).await
}

/// Who called, by `read` of its socket's peer where there is one, or why the store couldn't say.
pub(crate) async fn identified(
    shared: &Shared,
    read: Option<PeerRead>,
    presented: Presented,
) -> Result<Identity, String> {
    Ok(identified_how(shared, read, presented).await?.0)
}

/// `identified`, with how the caller's process is the agent it reads as, where it is one's.
async fn identified_how(
    shared: &Shared,
    read: Option<PeerRead>,
    presented: Presented,
) -> Result<(Identity, Option<String>), String> {
    let store = shared.store.clone();
    tokio::task::spawn_blocking(move || {
        let mut credentials = Stored {
            store: &store,
            reader: None,
        };
        let reading = read
            .map(|read| {
                peer::reading(read, || {
                    Ok::<_, rusqlite::Error>(peer::terminal_pids(
                        &credentials.reads()?.live_terminals()?,
                    ))
                })
            })
            .transpose()
            .map_err(|err| err.to_string())?;
        let how = match &reading {
            Some(Reading::Agent(agent, how)) => Some(how.of(agent)),
            _ => None,
        };
        let identity = identify(&mut credentials, &presented, reading.as_ref())
            .map_err(|err| err.to_string())?;
        Ok((identity, how))
    })
    .await
    .map_err(|err| err.to_string())?
}

fn forbidden(message: &str) -> Response {
    fail(StatusCode::FORBIDDEN, ErrorCode::Forbidden, message)
}

/// Why a caller whose socket no readable process holds is refused without a device paired the
/// same way: only a forwarder, as `ssh -L` is, leaves its socket so, and a browser behind one
/// pairs through it once.
pub(crate) const UNHELD: &str = "no process holding the caller's socket can be read: pair this browser \
                      through the forwarder it uses (`bazhen devices pair`)";

/// `guard` for the loopback HTTP listener, whose every connection carries its two addresses
/// (`accept::Connected`): a request under `/v1`, or an upgrade, that carries none can't be
/// identified, so it is refused rather than taken for the human's.
pub(crate) async fn http_guard(
    State(shared): State<Shared>,
    request: Request,
    next: Next,
) -> Response {
    if request.extensions().get::<PeerSocket>().is_none() {
        return forbidden("the caller's connection can't be read");
    }
    guard(State(shared), request, next).await
}

/// Identifies every request under `/v1`, and every upgrade, before any route sees it
/// (foundation-design §9.1): a credential that doesn't hold refuses every route, an agent is
/// refused every route but those in `AGENT_OPEN`, and only the human may open a stream. Each route
/// reads who called from its `Caller`. A caller not read in time is told to try again.
pub(crate) async fn guard(
    State(shared): State<Shared>,
    mut request: Request,
    next: Next,
) -> Response {
    let upgrade = request.headers().contains_key("upgrade");
    // Under a nest, the URI is what the nest left of it; the original is the whole path.
    let path = request
        .extensions()
        .get::<OriginalUri>()
        .map_or_else(|| request.uri().path(), |original| original.path())
        .to_owned();
    let under_v1 = path == "/v1" || path.starts_with("/v1/");
    if !upgrade && (!under_v1 || SELF_IDENTIFIED.contains(&path.as_str())) {
        return next.run(request).await;
    }
    let socket = request.extensions().get::<PeerSocket>().cloned();
    let (who, how) = match who(&shared, socket, presented_by(request.headers())).await {
        Ok(who) => who,
        Err(_) if upgrade => return forbidden("the caller's process can't be read for sure"),
        Err(err) => return internal(&err),
    };
    let (caller, refusal) = match who {
        Identity::Refused {
            reason,
            retry: true,
        } => return retry_soon(&reason),
        Identity::Refused { reason, .. } => (None, Some(reason)),
        Identity::Human => (Some(None), None),
        Identity::Agent(agent) => (Some(Some(agent)), None),
        Identity::Unheld if request.method() == Method::POST && path == "/v1/pairing" => {
            request.extensions_mut().insert(ThroughForwarder);
            (Some(None), None)
        }
        Identity::Unheld
            if matches!(
                request.extensions().get::<Viewer>(),
                Some(Viewer::Device {
                    forwarded: true,
                    ..
                })
            ) =>
        {
            (Some(None), None)
        }
        Identity::Unheld => (None, Some(UNHELD.to_owned())),
    };
    // An agent's refusal says how its process is the agent's, where its reading says.
    let because = |why: Option<&String>| why.map_or_else(String::new, |why| format!(": {why}"));
    if upgrade {
        return match (caller, refusal) {
            (Some(None), _) => next.run(request).await,
            (_, Some(refusal)) => forbidden(&refusal),
            _ => forbidden(&format!(
                "an agent can't open a stream{}",
                because(how.as_ref())
            )),
        };
    }
    if caller != Some(None)
        && let Some((_, what)) = HUMANS_ONLY
            .iter()
            .find(|(pattern, _)| matches(pattern, &path))
    {
        let why = because(refusal.as_ref().or(how.as_ref()));
        return forbidden(&format!("an agent can't {what}{why}"));
    }
    if let Some(refusal) = refusal {
        return forbidden(&refusal);
    }
    let method = request.method().as_str().to_owned();
    let open = AGENT_OPEN
        .iter()
        .any(|(m, pattern)| *m == method && matches(pattern, &path));
    let caller = caller.unwrap_or(None);
    if caller.is_some() && !open {
        let why = because(how.as_ref());
        return forbidden(&format!("an agent can't use {method} {path}{why}"));
    }
    request.extensions_mut().insert(Caller(caller));
    next.run(request).await
}

/// The caller as the route reads it: the human where no guard named one.
pub(crate) fn caller_of(caller: Option<axum::Extension<Caller>>) -> Option<AgentId> {
    caller.and_then(|axum::Extension(Caller(caller))| caller)
}

/// `GET /v1/caller`: who the daemon takes the request for.
pub(crate) async fn caller(caller: Option<axum::Extension<Caller>>) -> Response {
    axum::Json(bazhen_protocol::agents::CallerResponse {
        agent_id: caller_of(caller),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const TOKEN: &str = "ttttttttttttttttttttttttttttttttttttttttttt";
    const STALE: &str = "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu";
    /// Codex thread `tokened` is bound to.
    const THREAD: &str = "01a1e0f0-593e-7ae1-9d31-769db26227fc";
    /// Codex thread `coder` is bound to.
    const CODER_THREAD: &str = "01a1e0f0-0000-7ae1-9d31-769db26227fc";

    fn agent(n: char) -> AgentId {
        AgentId::parse(&format!("agent_0190a1b2c3d47abc8def0123456789a{n}")).unwrap()
    }

    fn tokened() -> AgentId {
        agent('1')
    }

    fn other() -> AgentId {
        agent('2')
    }

    fn coder() -> AgentId {
        agent('3')
    }

    /// `tokened` was given TOKEN and is bound to THREAD; `other` runs from before agents had
    /// tokens; `coder` is bound to `CODER_THREAD`. Without threads, no thread names an agent.
    struct Fake {
        threads: HashMap<&'static str, AgentId>,
    }

    fn credentials() -> Fake {
        Fake {
            threads: HashMap::from([(THREAD, tokened()), (CODER_THREAD, coder())]),
        }
    }

    impl Credentials for Fake {
        fn agent_of(&mut self, token: &str) -> rusqlite::Result<Option<AgentId>> {
            Ok((token == TOKEN).then(tokened))
        }

        fn untokened(&mut self, agent_id: &str) -> rusqlite::Result<bool> {
            Ok(agent_id == other().as_str())
        }

        fn codex_agent(&mut self, thread: &str) -> rusqlite::Result<Option<AgentId>> {
            Ok(self.threads.get(thread).cloned())
        }
    }

    fn presents(token: Option<&str>, said: Option<&str>, thread: Option<&str>) -> Presented {
        Presented {
            token: token.map(str::to_owned),
            said: said.map(str::to_owned),
            thread: thread.map(str::to_owned),
        }
    }

    fn id(presented: &Presented, reading: Option<&Reading>) -> Identity {
        identify(&mut credentials(), presented, reading).unwrap()
    }

    fn who(token: Option<&str>, said: Option<&str>) -> Identity {
        id(&presents(token, said, None), None)
    }

    fn is_refused(identity: &Identity) -> bool {
        matches!(identity, Identity::Refused { retry: false, .. })
    }

    fn refusal(reason: &str) -> Identity {
        refused(reason)
    }

    const SERVER: Reading = Reading::Codex(Via::Server);
    const MARKED_ONLY: Reading = Reading::Codex(Via::Environment);

    fn under(agent: AgentId) -> Reading {
        let how = peer::How {
            pid: 150,
            by: peer::By::Ancestry,
        };
        Reading::Agent(agent, how)
    }

    #[test]
    fn takes_a_caller_with_an_agents_token_as_that_agent_naming_it_or_not() {
        assert_eq!(
            [
                who(Some(TOKEN), None),
                who(Some(TOKEN), Some(tokened().as_str()))
            ],
            [Identity::Agent(tokened()), Identity::Agent(tokened())]
        );
    }

    #[test]
    fn refuses_an_agents_token_beside_another_agents_id_or_one_no_live_agents() {
        let other = other();
        assert_eq!(
            [
                who(Some(TOKEN), Some(other.as_str())),
                who(Some(STALE), None),
                who(Some(STALE), Some(other.as_str())),
                who(Some(""), None),
            ],
            [
                refusal(&format!(
                    "the agent token is not agent {}'s",
                    other.as_str()
                )),
                refusal("the agent token is no live agent's"),
                refusal("the agent token is no live agent's"),
                refusal("the agent token is no live agent's"),
            ]
        );
    }

    #[test]
    fn takes_an_id_alone_only_for_an_agent_started_before_agents_had_tokens() {
        let (tokened, unknown) = (tokened(), agent('9'));
        assert_eq!(
            [
                who(None, Some(tokened.as_str())),
                who(None, Some(other().as_str())),
                who(None, Some(unknown.as_str())),
                who(None, Some("%3")),
                who(None, Some("BZ-127")),
                who(None, None),
            ],
            [
                refusal(&format!(
                    "agent {} must present its agent token",
                    tokened.as_str()
                )),
                Identity::Agent(other()),
                refusal(&format!(
                    "agent {} must present its agent token",
                    unknown.as_str()
                )),
                refusal("not an agent id: %3"),
                refusal("not an agent id: BZ-127"),
                Identity::Human,
            ]
        );
    }

    #[test]
    fn refuses_a_caller_whose_process_wasnt_read_in_time_whatever_it_presents_as_one_to_retry() {
        let late = Identity::Refused {
            reason: LATE_REASON.to_owned(),
            retry: true,
        };
        for presented in [
            presents(None, None, None),
            presents(Some(TOKEN), None, None),
            presents(None, Some(other().as_str()), None),
        ] {
            assert_eq!(id(&presented, Some(&Reading::Late)), late);
        }
    }

    #[test]
    fn takes_a_caller_under_an_agents_process_as_that_agent_with_its_own_token_or_id_or_nothing() {
        let peer = |token, said: Option<&str>, of: AgentId| {
            id(&presents(token, said, None), Some(&under(of)))
        };
        let (tokened, other) = (tokened(), other());
        assert_eq!(
            [
                peer(None, None, tokened.clone()),
                peer(Some(TOKEN), None, tokened.clone()),
                peer(None, Some(tokened.as_str()), tokened.clone()),
                peer(Some(TOKEN), None, other.clone()),
                peer(None, Some(tokened.as_str()), other.clone()),
            ],
            [
                Identity::Agent(tokened.clone()),
                Identity::Agent(tokened.clone()),
                Identity::Agent(tokened.clone()),
                refusal(&format!(
                    "the agent token is not agent {}'s, whose process calls",
                    other.as_str()
                )),
                refusal(&format!(
                    "agent {}'s process names agent {}",
                    other.as_str(),
                    tokened.as_str()
                )),
            ]
        );
    }

    #[test]
    fn refuses_a_codex_tool_call_whatever_it_presents_and_never_takes_it_for_the_human() {
        let unbound = "01a1e0f0-0000-7000-8000-0";
        let tokened = tokened();
        let cases = [
            presents(None, None, None),
            presents(Some(TOKEN), None, None),
            presents(Some(TOKEN), Some(tokened.as_str()), None),
            presents(None, Some(other().as_str()), None),
            presents(Some(TOKEN), None, Some(unbound)),
            presents(None, None, Some("not a thread")),
            presents(None, None, Some("")),
        ];
        let mut unthreaded = Fake {
            threads: HashMap::new(),
        };
        for reading in [SERVER, MARKED_ONLY] {
            for presented in &cases {
                let identity = id(presented, Some(&reading));
                assert!(is_refused(&identity), "{presented:?}: {identity:?}");
            }
            let bound = presents(None, None, Some(THREAD));
            let identity = identify(&mut unthreaded, &bound, Some(&reading)).unwrap();
            assert_eq!(
                identity,
                refusal(&format!("Codex thread {THREAD} is no live agent's"))
            );
        }
        assert_eq!(
            [
                id(&cases[0], Some(&SERVER)),
                id(&cases[5], Some(&SERVER)),
                id(&cases[6], Some(&SERVER)),
            ],
            [
                refusal("a Codex tool call names no thread"),
                refusal("a Codex tool call names no Codex thread"),
                refusal("a Codex tool call names no Codex thread"),
            ]
        );
    }

    #[test]
    fn takes_a_codex_tool_call_as_the_live_agent_bound_to_the_thread_it_names_and_only_it() {
        let named = presents(None, None, Some(THREAD));
        let tokened = tokened();
        assert_eq!(
            [
                id(&named, Some(&SERVER)),
                id(&named, Some(&MARKED_ONLY)),
                id(
                    &presents(Some(TOKEN), Some(tokened.as_str()), Some(THREAD)),
                    Some(&SERVER)
                ),
                id(&named, Some(&Reading::Outside)),
                id(&named, Some(&under(other()))),
            ],
            [
                Identity::Agent(tokened.clone()),
                Identity::Agent(tokened.clone()),
                Identity::Agent(tokened),
                Identity::Human,
                Identity::Agent(other()),
            ]
        );
    }

    #[test]
    fn takes_a_call_under_the_app_server_as_its_threads_agent_whatever_the_servers_environment_gave_it()
     {
        let tokened = tokened();
        for presented in [
            presents(Some(TOKEN), Some(tokened.as_str()), Some(CODER_THREAD)),
            presents(Some(TOKEN), None, Some(CODER_THREAD)),
            presents(None, Some(other().as_str()), Some(CODER_THREAD)),
            presents(Some(STALE), Some(tokened.as_str()), Some(CODER_THREAD)),
        ] {
            assert_eq!(id(&presented, Some(&SERVER)), Identity::Agent(coder()));
        }
    }

    #[test]
    fn says_who_presents_one_agents_token_on_another_agents_thread_by_where_it_runs() {
        let own = presents(Some(TOKEN), None, Some(CODER_THREAD));
        let id_only = presents(None, Some(tokened().as_str()), Some(CODER_THREAD));
        let stale = presents(Some(STALE), None, Some(CODER_THREAD));
        assert_eq!(id(&own, Some(&SERVER)), Identity::Agent(coder()));
        for presented in [&own, &id_only, &stale] {
            assert!(
                is_refused(&id(presented, Some(&MARKED_ONLY))),
                "{presented:?}"
            );
        }
        assert_eq!(
            id(&own, Some(&under(tokened()))),
            Identity::Agent(tokened())
        );
        assert!(is_refused(&id(&own, Some(&under(other())))));
        assert_eq!(
            id(&own, Some(&Reading::Outside)),
            Identity::Agent(tokened())
        );
        assert_eq!(id(&own, None), Identity::Agent(tokened()));
    }

    #[test]
    fn takes_a_caller_whose_environment_was_withheld_by_the_thread_it_presents_or_else_by_the_rest()
    {
        let withheld = Some(&Reading::Withheld);
        assert_eq!(
            id(&presents(None, None, Some(THREAD)), withheld),
            Identity::Agent(tokened())
        );
        for presented in [
            presents(None, None, Some("01a1e0f0-0000-7000-8000-0")),
            presents(None, None, Some("not a thread")),
            presents(Some(TOKEN), None, Some(CODER_THREAD)),
            presents(None, Some(tokened().as_str()), None),
        ] {
            assert!(is_refused(&id(&presented, withheld)), "{presented:?}");
        }
        assert_eq!(
            [
                id(&presents(None, None, None), withheld),
                id(&presents(Some(TOKEN), None, None), withheld),
                id(&presents(None, Some(other().as_str()), None), withheld),
            ],
            [
                Identity::Human,
                Identity::Agent(tokened()),
                Identity::Agent(other())
            ]
        );
    }

    #[test]
    fn refuses_a_caller_whose_process_the_reading_refused_whatever_it_presents() {
        assert_eq!(
            id(
                &presents(Some(TOKEN), None, None),
                Some(&Reading::Refused("no terminal".to_owned()))
            ),
            refusal("no terminal")
        );
    }

    #[test]
    fn reads_the_token_the_agent_id_and_the_codex_thread_from_their_headers_and_an_empty_id_as_none()
     {
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.append(*name, value.parse().unwrap());
            }
            headers
        };
        let tokened = tokened();
        assert_eq!(
            presented_by(&headers(&[
                ("bazhen-agent-token", TOKEN),
                ("bazhen-agent-id", tokened.as_str()),
                ("bazhen-codex-thread", THREAD),
            ])),
            presents(Some(TOKEN), Some(tokened.as_str()), Some(THREAD))
        );
        let empty = presented_by(&headers(&[("bazhen-agent-id", "")]));
        assert_eq!(
            [id(&empty, None), id(&empty, Some(&under(tokened.clone()))),],
            [Identity::Human, Identity::Agent(tokened)]
        );
        assert_eq!(empty, Presented::default());
    }

    #[test]
    fn matches_a_route_as_hono_does_each_parameter_one_segment_and_not_empty() {
        for (pattern, path, expected) in [
            ("/v1/devices/:id/revoke", "/v1/devices/d1/revoke", true),
            ("/v1/devices/:id/revoke", "/v1/devices//revoke", false),
            ("/v1/devices/:id/revoke", "/v1/devices/d1/d2/revoke", false),
            ("/v1/devices", "/v1/devices", true),
            ("/v1/devices", "/v1/devices/", false),
            ("/v1/devices", "/v1/devices/d1", false),
            ("/v1/agents", "/v1/agents/a1", false),
        ] {
            assert_eq!(matches(pattern, path), expected, "{pattern} {path}");
        }
    }

    mod guarded {
        use std::os::fd::AsFd as _;
        use std::os::unix::net::UnixStream;
        use std::time::Duration;

        use axum::Router;
        use axum::body::Body;
        use bazhen_peer::{Peer, Refused};
        use rustix::process::Pid;
        use serde_json::{Value, json};
        use tower::ServiceExt as _;

        use super::{HUMANS_ONLY, THREAD, TOKEN, agent};
        use crate::peer::{PeerSocket, Peers, READ};
        use crate::routes::{Shared, Stop, http_router, socket_router};
        use crate::testing::{TempDir, runtime};
        use crate::writer::{self, Thread, Writer};

        const CLOSING_TOKEN: &str = "ccccccccccccccccccccccccccccccccccccccccccc";

        /// A store where agent 1 runs on `TOKEN`, bound to `THREAD`, its pane pid 100 on a tmux
        /// server of pid 10, and agent 2 is closing on `CLOSING_TOKEN`.
        fn daemon() -> (TempDir, Writer, Thread) {
            let dir = TempDir::new("guarded");
            let path = dir.path().join("bazhen.db");
            drop(bazhen_store::Store::open(&path).unwrap());
            rusqlite::Connection::open(&path)
                .unwrap()
                .execute_batch(&format!(
                    "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                       SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                     INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);
                     INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                       token_hash, external_ref, created_event_id, updated_event_id) VALUES
                       ('{one}', 'env_local', 'codex', 'p', '/', 'running', '{token}',
                        '{{\"kind\":\"codex-thread\",\"id\":\"{THREAD}\"}}', 1, 1),
                       ('{two}', 'env_local', 'claude-code', 'p', '/', 'closing', '{closing}', NULL, 1, 1);
                     INSERT INTO terminals (id, host_id, state, generation, locator, kind,
                       agent_session_id, created_event_id, updated_event_id)
                       SELECT 'term_1', id, 'running', 0, '{{\"panePid\":\"100\",\"serverPid\":\"10\"}}',
                         'agent', '{one}', 1, 1 FROM host;",
                    one = agent('1').as_str(),
                    two = agent('2').as_str(),
                    token = crate::tokens::hash_of(TOKEN),
                    closing = crate::tokens::hash_of(CLOSING_TOKEN),
                ))
                .unwrap();
            let (store, thread) =
                writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
            (dir, store, thread)
        }

        fn pid(raw: i32) -> Pid {
            Pid::from_raw(raw).unwrap()
        }

        /// A peer at `at`, its session its own, under `ancestors`.
        fn peer(at: i32, ancestors: &[i32], codex_server: Option<i32>) -> Peer {
            Peer {
                pid: pid(at),
                session: Some(pid(at)),
                codex_server: codex_server.map(pid),
                environment_withheld: false,
                ancestors: ancestors.iter().copied().map(pid).collect(),
                names: vec![String::new(); ancestors.len()],
            }
        }

        fn reading(read: Result<Peer, &'static str>) -> Peers {
            Peers::with(READ, move |_, _| match &read {
                Ok(peer) => Ok(peer.clone()),
                Err(_) => Err(Refused::Endless),
            })
        }

        /// A reader that never reads its peer in time.
        fn late() -> Peers {
            Peers::with(Duration::ZERO, |_, _| {
                std::thread::sleep(Duration::from_millis(20));
                Err(Refused::Endless)
            })
        }

        fn router(store: &Writer, peers: Option<Peers>) -> Router {
            let mut shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store.clone());
            if let Some(peers) = peers {
                shared.peers = peers;
            }
            socket_router(shared)
        }

        /// What `router` answers; with `peered`, the request is on a socket whose peer is read.
        fn ask(
            router: Router,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<Value>,
            peered: bool,
        ) -> (u16, Value) {
            let (ours, _theirs) = UnixStream::pair().unwrap();
            let socket = peered.then(|| PeerSocket::accepted_now(ours.as_fd()));
            ask_on(router, method, path, headers, body, socket)
        }

        /// What `router` answers a request on `socket`, or on none.
        fn ask_on(
            router: Router,
            method: &str,
            path: &str,
            headers: &[(&str, &str)],
            body: Option<Value>,
            socket: Option<PeerSocket>,
        ) -> (u16, Value) {
            let mut builder = axum::http::Request::builder().method(method).uri(path);
            for (name, value) in headers {
                builder = builder.header(*name, *value);
            }
            let mut request = builder
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap();
            if let Some(socket) = socket {
                request.extensions_mut().insert(socket);
            }
            runtime().block_on(async {
                let response = router.oneshot(request).await.unwrap();
                let status = response.status().as_u16();
                let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                    .await
                    .unwrap();
                let body = serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
                (status, body)
            })
        }

        fn refused(error: &str, message: &str) -> (u16, Value) {
            let status = if error == "unavailable" { 503 } else { 403 };
            (status, json!({ "error": error, "message": message }))
        }

        const UPGRADE: (&str, &str) = ("upgrade", "websocket");

        #[test]
        fn refuses_a_token_that_is_no_live_agents_on_every_route_stop_and_streams_included() {
            let (_dir, store, thread) = daemon();
            let stale = [(
                "bazhen-agent-token",
                "uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu",
            )];
            let reason = "the agent token is no live agent's";
            for (method, path) in [
                ("GET", "/v1/health"),
                ("GET", "/v1/state"),
                ("GET", "/v1/caller"),
                ("POST", "/v1/tasks"),
                ("GET", "/v1/nowhere"),
                ("GET", "/v1"),
            ] {
                assert_eq!(
                    ask(router(&store, None), method, path, &stale, None, false),
                    refused("forbidden", reason),
                    "{method} {path}"
                );
            }
            assert_eq!(
                ask(
                    router(&store, None),
                    "POST",
                    "/v1/daemon/stop",
                    &stale,
                    None,
                    false
                ),
                refused(
                    "forbidden",
                    &format!("an agent can't stop the daemon: {reason}")
                )
            );
            assert_eq!(
                ask(
                    router(&store, None),
                    "GET",
                    "/v1/events",
                    &[stale[0], UPGRADE],
                    None,
                    false
                ),
                refused("forbidden", reason)
            );
            thread.finish();
        }

        #[test]
        fn lets_an_agent_with_its_token_use_only_the_agents_routes_each_by_its_method() {
            let (_dir, store, thread) = daemon();
            let one = agent('1');
            let asking = [("bazhen-agent-token", TOKEN)];
            let ask = |method, path, headers: &[(&str, &str)]| {
                ask(router(&store, None), method, path, headers, None, false)
            };
            assert_eq!(
                ask("GET", "/v1/caller", &asking),
                (200, json!({ "agentId": one.as_str() }))
            );
            assert_eq!(ask("GET", "/v1/health", &asking).0, 200);
            // Past the guard: this daemon can't describe the seeded environment yet.
            assert_ne!(ask("GET", "/v1/state", &asking).0, 403);
            assert_eq!(
                [
                    ask("POST", "/v1/daemon/stop", &asking),
                    ask("GET", "/v1/nowhere", &asking),
                    ask("POST", "/v1/health", &asking),
                    ask("HEAD", "/v1/health", &asking),
                    ask("GET", "/v1/events", &[asking[0], UPGRADE]),
                ],
                [
                    refused("forbidden", "an agent can't stop the daemon"),
                    refused("forbidden", "an agent can't use GET /v1/nowhere"),
                    refused("forbidden", "an agent can't use POST /v1/health"),
                    (403, json!("")),
                    refused("forbidden", "an agent can't open a stream"),
                ]
            );
            assert_eq!(
                ask("GET", "/v1/caller", &[]),
                (200, json!({ "agentId": null }))
            );
            thread.finish();
        }

        #[test]
        fn makes_an_agents_task_owned_by_it_and_refuses_its_subtask_or_one_from_an_agent_closing() {
            let (dir, store, thread) = daemon();
            let task = |key: &str| json!({ "idempotencyKey": key, "title": "T", "brief": "b" });
            let post = |token, body| {
                ask(
                    router(&store, None),
                    "POST",
                    "/v1/tasks",
                    &[
                        ("bazhen-agent-token", token),
                        ("content-type", "application/json"),
                    ],
                    Some(body),
                    false,
                )
            };
            let (status, made) = post(TOKEN, task("mine"));
            assert_eq!(status, 200, "{made}");
            let mut sub = task("sub");
            sub["parentTaskId"] = made["taskId"].clone();
            assert_eq!(
                post(TOKEN, sub),
                (
                    400,
                    json!({ "error": "unsupported", "message": "this daemon can't make an agent's subtask yet" })
                )
            );
            assert_eq!(
                post(CLOSING_TOKEN, task("closing")),
                (
                    404,
                    json!({
                        "error": "not_found",
                        "message": format!("no agent {} that is open", agent('2').as_str())
                    })
                )
            );
            let owner: String = rusqlite::Connection::open(dir.path().join("bazhen.db"))
                .unwrap()
                .query_row("SELECT owner_agent_id FROM tasks", (), |row| row.get(0))
                .unwrap();
            assert_eq!(owner, agent('1').as_str());
            thread.finish();
        }

        #[test]
        fn shows_a_task_in_full_to_an_agent_and_the_human_and_no_task_for_an_unknown_id() {
            let (_dir, store, thread) = daemon();
            let token = [("bazhen-agent-token", TOKEN)];
            let made = ask(
                router(&store, None),
                "POST",
                "/v1/tasks",
                &[token[0], ("content-type", "application/json")],
                Some(json!({ "idempotencyKey": "k", "title": "T", "brief": "b" })),
                false,
            );
            assert_eq!(made.0, 200, "{}", made.1);
            let id = made.1["taskId"].as_str().unwrap().to_owned();
            let show = |path: &str, headers: &[(&str, &str)]| {
                ask(router(&store, None), "GET", path, headers, None, false)
            };
            let shown = json!({
                "id": id,
                "title": "T",
                "state": "open",
                "ownerAgentId": agent('1').as_str(),
                "parentTaskId": null,
                "brief": "b",
                "note": null,
                "assignments": [],
                "subtasks": [],
                "notes": [],
            });
            let unknown = "task_0190a1b2c3d47abc8def0123456789ff";
            let none = |id: &str| {
                (
                    404,
                    json!({ "error": "not_found", "message": format!("no task {id}") }),
                )
            };
            assert_eq!(
                [
                    show(&format!("/v1/tasks/{id}"), &token),
                    show(&format!("/v1/tasks/{id}"), &[]),
                    show(&format!("/v1/tasks/{unknown}"), &token),
                    show("/v1/tasks/nonsense", &[]),
                ],
                [
                    (200, shown.clone()),
                    (200, shown),
                    none(unknown),
                    none("nonsense")
                ]
            );
            thread.finish();
        }

        #[test]
        fn notes_the_humans_task_for_the_human_and_refuses_an_agent_off_it() {
            let (_dir, store, thread) = daemon();
            let token = ("bazhen-agent-token", TOKEN);
            let json = ("content-type", "application/json");
            let made = ask(
                router(&store, None),
                "POST",
                "/v1/tasks",
                &[json],
                Some(json!({ "idempotencyKey": "k", "title": "T", "brief": "b" })),
                false,
            );
            assert_eq!(made.0, 200, "{}", made.1);
            let id = made.1["taskId"].as_str().unwrap().to_owned();
            let note = |headers: &[(&str, &str)], key: &str, text: &str, on: &str| {
                let (status, body) = ask(
                    router(&store, None),
                    "POST",
                    &format!("/v1/tasks/{on}/notes"),
                    headers,
                    Some(json!({ "idempotencyKey": key, "text": text })),
                    false,
                );
                (status, body["error"].as_str().map(str::to_owned))
            };
            let unknown = "task_0190a1b2c3d47abc8def0123456789ff";
            assert_eq!(
                [
                    note(&[token, json], "k1", "mine now", &id),
                    note(&[json], "k2", "tests pass", &id),
                    note(&[json], "k3", "  ", &id),
                    note(&[json], "k4", "x", unknown),
                ],
                [
                    (403, Some("forbidden".to_owned())),
                    (200, None),
                    (400, Some("invalid_request".to_owned())),
                    (404, Some("not_found".to_owned())),
                ]
            );
            let shown = ask(
                router(&store, None),
                "GET",
                &format!("/v1/tasks/{id}"),
                &[],
                None,
                false,
            );
            assert_eq!(shown.1["notes"][0]["text"], "tests pass");
            assert_eq!(shown.1["notes"][0]["agentId"], serde_json::Value::Null);
            thread.finish();
        }

        #[test]
        fn takes_a_caller_under_an_agents_pane_as_that_agent_though_it_presents_nothing() {
            let (_dir, store, thread) = daemon();
            let under = |peer| {
                ask(
                    router(&store, Some(reading(Ok(peer)))),
                    "GET",
                    "/v1/caller",
                    &[],
                    None,
                    true,
                )
            };
            assert_eq!(
                [
                    under(peer(150, &[100, 10, 1], None)),
                    under(peer(950, &[900, 1], Some(900))),
                ],
                [
                    (200, json!({ "agentId": agent('1').as_str() })),
                    refused("forbidden", "a Codex tool call names no thread"),
                ]
            );
            assert_eq!(
                ask(
                    router(&store, Some(reading(Ok(peer(950, &[900, 1], Some(900)))))),
                    "GET",
                    "/v1/caller",
                    &[("bazhen-codex-thread", THREAD)],
                    None,
                    true
                ),
                (200, json!({ "agentId": agent('1').as_str() }))
            );
            assert_eq!(
                ask(
                    router(&store, Some(reading(Ok(peer(150, &[100, 10, 1], None))))),
                    "GET",
                    "/v1/events",
                    &[UPGRADE],
                    None,
                    true
                ),
                refused(
                    "forbidden",
                    &format!(
                        "an agent can't open a stream: the caller, pid 150, was started from \
                         {}'s terminal",
                        agent('1').as_str()
                    )
                )
            );
            thread.finish();
        }

        #[test]
        fn refuses_a_caller_under_the_runtime_in_no_terminal_but_on_the_routes_that_identify_their_own()
         {
            let (_dir, store, thread) = daemon();
            let tmux = || Some(reading(Ok(peer(15, &[10, 1], None))));
            let reason = "the caller runs under Bazhen's runtime, in no terminal";
            assert_eq!(
                [
                    ask(router(&store, tmux()), "GET", "/v1/state", &[], None, true),
                    ask(
                        router(&store, tmux()),
                        "POST",
                        "/v1/daemon/stop",
                        &[],
                        None,
                        true
                    ),
                    // tmux's pane-title hook, which no Rust daemon serves, isn't let through.
                    ask(
                        router(&store, tmux()),
                        "POST",
                        "/v1/codex/pane-title",
                        &[],
                        None,
                        true
                    ),
                ],
                [
                    refused("forbidden", reason),
                    refused(
                        "forbidden",
                        &format!("an agent can't stop the daemon: {reason}")
                    ),
                    refused("forbidden", reason),
                ]
            );
            // Each refuses the caller itself, and answers so its hook goes on as it would.
            for path in ["/v1/hooks", "/v1/hooks/ack"] {
                assert_eq!(
                    ask(router(&store, tmux()), "POST", path, &[], None, true).0,
                    200,
                    "{path}"
                );
            }
            thread.finish();
        }

        #[test]
        fn refuses_a_caller_whose_process_cant_be_read_for_sure_and_tells_a_late_one_to_try_again()
        {
            let (_dir, store, thread) = daemon();
            let unread = "the caller's process can't be read for sure: \
                          the caller's ancestors go past 256 processes";
            let late_reason = "the caller's process wasn't read in time; try again";
            assert_eq!(
                [
                    ask(
                        router(&store, Some(reading(Err("endless")))),
                        "GET",
                        "/v1/health",
                        &[],
                        None,
                        true
                    ),
                    ask(
                        router(&store, Some(reading(Err("endless")))),
                        "GET",
                        "/v1/events",
                        &[UPGRADE],
                        None,
                        true
                    ),
                    ask(
                        router(&store, Some(late())),
                        "GET",
                        "/v1/state",
                        &[],
                        None,
                        true
                    ),
                    ask(
                        router(&store, Some(late())),
                        "POST",
                        "/v1/daemon/stop",
                        &[],
                        None,
                        true
                    ),
                    ask(
                        router(&store, Some(late())),
                        "GET",
                        "/v1/events",
                        &[UPGRADE],
                        None,
                        true
                    ),
                ],
                [
                    refused("forbidden", unread),
                    refused("forbidden", unread),
                    refused("unavailable", late_reason),
                    refused("unavailable", late_reason),
                    refused("unavailable", late_reason),
                ]
            );
            thread.finish();
        }

        const HOST: (&str, &str) = ("host", "127.0.0.1:7900");

        /// The loopback listener's routes over `store`, its callers read by `peers`.
        fn http(store: &Writer, peers: Peers, pairing_required: bool) -> Router {
            let mut shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store.clone());
            shared.peers = peers;
            let gate = crate::routes::Gate {
                allow: crate::guard::allowlists(7900, None, &[]),
                pairing_required,
            };
            http_router(shared, gate)
        }

        #[test]
        fn refuses_an_agent_over_http_what_the_socket_refuses_it_naming_how_it_is_the_agent() {
            let (_dir, store, thread) = daemon();
            let ask_as = |peer: Peer, method, path: &str, headers: &[(&str, &str)]| {
                let headers = [&[HOST], headers].concat();
                let router = http(&store, reading(Ok(peer)), false);
                ask(router, method, path, &headers, None, true)
            };
            let as_agent = |method, path: &str, headers: &[(&str, &str)]| {
                ask_as(peer(150, &[100, 10, 1], None), method, path, headers)
            };
            let one = agent('1');
            let started = format!(
                "the caller, pid 150, was started from {}'s terminal",
                one.as_str()
            );
            for (pattern, what) in HUMANS_ONLY {
                let path = pattern.replace(":id", "x");
                assert_eq!(
                    as_agent("POST", &path, &[]),
                    refused("forbidden", &format!("an agent can't {what}: {started}")),
                    "{path}"
                );
            }
            let orphaned = Peer {
                session: Some(pid(100)),
                ..peer(150, &[1], None)
            };
            assert_eq!(
                [
                    as_agent("GET", "/v1/events", &[UPGRADE]),
                    as_agent("GET", "/v1/terminals/x/stream", &[UPGRADE]),
                    as_agent("GET", "/v1/nowhere", &[]),
                    as_agent("GET", "/v1/", &[]),
                    ask_as(orphaned, "POST", "/v1/shells", &[]),
                    as_agent("GET", "/v1/caller", &[]),
                ],
                [
                    refused(
                        "forbidden",
                        &format!("an agent can't open a stream: {started}")
                    ),
                    refused(
                        "forbidden",
                        &format!("an agent can't open a stream: {started}")
                    ),
                    refused(
                        "forbidden",
                        &format!("an agent can't use GET /v1/nowhere: {started}")
                    ),
                    refused(
                        "forbidden",
                        &format!("an agent can't use GET /v1/: {started}")
                    ),
                    refused(
                        "forbidden",
                        &format!(
                            "an agent can't open a shell: the caller, pid 150, is in {}'s \
                             terminal's session",
                            one.as_str()
                        )
                    ),
                    (200, json!({ "agentId": one.as_str() })),
                ]
            );
            // A process under no terminal is the human, and an agent's token names its agent, as
            // on the socket.
            let outside = |headers: &[(&str, &str)]| {
                let peers = reading(Ok(peer(5000, &[1], None)));
                let headers = [&[HOST], headers].concat();
                ask(
                    http(&store, peers, false),
                    "GET",
                    "/v1/caller",
                    &headers,
                    None,
                    true,
                )
            };
            assert_eq!(
                [outside(&[]), outside(&[("bazhen-agent-token", TOKEN)])],
                [
                    (200, json!({ "agentId": null })),
                    (200, json!({ "agentId": agent('1').as_str() })),
                ]
            );
            thread.finish();
        }

        #[test]
        fn refuses_an_http_caller_it_cant_identify_and_tells_one_that_raced_to_try_again() {
            let (_dir, store, thread) = daemon();
            let unread = "the caller's process can't be read for sure: \
                          the caller's ancestors go past 256 processes";
            let late_reason = "the caller's process wasn't read in time; try again";
            let raced = || Peers::with(READ, |_, _| Err(Refused::HolderChanged));
            let at = |port| Ok(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
            let over_tcp = PeerSocket::tcp_accepted_now(at(40000), at(7900));
            let ask_on = |peers, path, headers: &[(&str, &str)], socket| {
                let headers = [&[HOST], headers].concat();
                ask_on(
                    http(&store, peers, false),
                    "GET",
                    path,
                    &headers,
                    None,
                    socket,
                )
            };
            let unix = || {
                let (ours, _theirs) = UnixStream::pair().unwrap();
                Some(PeerSocket::accepted_now(ours.as_fd()))
            };
            assert_eq!(
                [
                    ask_on(reading(Err("endless")), "/v1/health", &[], unix()),
                    ask_on(Peers::default(), "/v1/health", &[], None),
                    ask_on(Peers::default(), "/v1/events", &[UPGRADE], None),
                    ask_on(
                        Peers::default().with_tcp(None),
                        "/v1/caller",
                        &[],
                        Some(over_tcp)
                    ),
                    ask_on(raced(), "/v1/caller", &[], unix()),
                    ask_on(late(), "/v1/state", &[], unix()),
                ],
                [
                    refused("forbidden", unread),
                    refused("forbidden", "the caller's connection can't be read"),
                    refused("forbidden", "the caller's connection can't be read"),
                    refused(
                        "forbidden",
                        &format!(
                            "the caller's process can't be read for sure: {}",
                            crate::peer::UNIDENTIFIABLE
                        )
                    ),
                    refused("unavailable", late_reason),
                    refused("unavailable", late_reason),
                ]
            );
            thread.finish();
        }

        /// A wrong host, an origin the daemon doesn't admit and a browser yet to pair are each
        /// answered before the caller's process is looked for.
        #[test]
        fn answers_over_http_what_the_host_origin_and_pairing_refuse_before_reading_the_caller() {
            let (_dir, store, thread) = daemon();
            let reads = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = || {
                let reads = std::sync::Arc::clone(&reads);
                Peers::with(READ, move |_, _| {
                    reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(peer(5000, &[1], None))
                })
            };
            let ask = |pairing_required, method, headers: &[(&str, &str)]| {
                let router = http(&store, counted(), pairing_required);
                ask(router, method, "/v1/tasks", headers, None, true).0
            };
            let evil = [HOST, ("origin", "https://evil.example")];
            assert_eq!(
                [
                    ask(false, "GET", &[("host", "evil.example")]),
                    ask(false, "POST", &evil),
                    ask(true, "GET", &[HOST]),
                    ask(true, "GET", &[HOST, UPGRADE]),
                ],
                [421, 403, 401, 401]
            );
            assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert_eq!(ask(false, "GET", &[HOST, UPGRADE]), 404);
            assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
            thread.finish();
        }
    }
}
