//! The API's routes and the layers in front of them: one router for the Unix socket, whose 0600
//! mode makes its caller the owner, and one for loopback HTTP, behind the Host/Origin guard and
//! the pairing gate (`http/app.ts`, `socket/routes.ts`). Each identifies its caller with one
//! guard: the socket's peer, or the processes holding a TCP caller's socket.

use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::rejection::QueryRejection;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Router};
use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::daemon::{
    ErrorCode, ErrorResponse, HealthResponse, HealthStatus, StopResponse,
};
use bazhen_protocol::events::EVENT_FRAME_MAX_BYTES;
use bazhen_protocol::ids::TaskId;
use bazhen_store::{
    CreateTaskError, NewTask, OnceError, SnapshotError, SnapshotView, TaskReadError,
};
use tokio_util::sync::CancellationToken;

use crate::accept::Held;
use crate::agent_routes;
use crate::callers::{self, Caller};
use crate::events::{self, Streaming};
use crate::guard::{self, Allowlists, Arrival, Refusal};
use crate::heartbeat::{HEARTBEAT, Heartbeat};
use crate::paired::{self, Gated, Pairing, Viewer};
use crate::peer::Peers;
use crate::roles::Roles;
use crate::shell_routes;
use crate::shells::Shells;
use crate::tasks::{self, Refused};
use crate::terminal_routes;
use crate::writer::Writer;

/// Why the daemon stopped, as its last line says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    Sigterm,
    Sigint,
    Requested,
}

impl Reason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Sigterm => "SIGTERM",
            Self::Sigint => "SIGINT",
            Self::Requested => "requested",
        }
    }
}

/// A stop, from whichever asks first: a signal or `POST /v1/daemon/stop`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Stop {
    token: CancellationToken,
    reason: Arc<OnceLock<Reason>>,
}

impl Stop {
    pub(crate) fn now(&self, reason: Reason) {
        // A later stop keeps the first one's reason.
        let _ = self.reason.set(reason);
        self.token.cancel();
    }

    pub(crate) fn token(&self) -> &CancellationToken {
        &self.token
    }

    pub(crate) fn reason(&self) -> Option<Reason> {
        self.reason.get().copied()
    }
}

/// What every route shares.
#[derive(Debug, Clone)]
pub(crate) struct Shared {
    pub(crate) health: Arc<HealthResponse>,
    pub(crate) stop: Stop,
    pub(crate) store: Writer,
    pub(crate) heartbeat: Heartbeat,
    /// Who is at the other end of a socket connection.
    pub(crate) peers: Peers,
    /// The live pairing code, and the streams paired devices hold.
    pub(crate) pairing: Pairing,
    /// The shells, where this daemon runs terminals.
    pub(crate) shells: Option<Arc<Shells>>,
    /// The agents, where this daemon runs terminals.
    pub(crate) agents: Option<Arc<crate::agents::Agents>>,
    /// What doctor says that was settled at start.
    pub(crate) doctor: Option<Arc<crate::doctor::Settled>>,
    /// This machine's name, as the state names its environment's host.
    pub(crate) host: Arc<str>,
    /// Where the web client's build is, which loopback HTTP serves off the API.
    pub(crate) web: Option<Arc<crate::web::Bundle>>,
    /// The terminals' live views, where this daemon runs terminals.
    pub(crate) streams: Option<crate::stream::route::Streams>,
    /// The roles in force: the built-ins, and the user's files once a config directory is given.
    pub(crate) roles: Arc<Roles>,
    /// What the agents' hooks keep between requests.
    pub(crate) hooks: Arc<crate::hooks::Hooks>,
    /// What a harness that takes mail by push is handed it through; with none, its mail stays
    /// queued. No harness this daemon serves takes mail by push yet.
    pub(crate) push: Option<crate::mail::PushTo>,
}

impl Shared {
    pub(crate) fn new(protocol_id: &str, stop: Stop, store: Writer) -> Self {
        Self {
            health: Arc::new(HealthResponse {
                status: HealthStatus::Ok,
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                protocol_id: protocol_id.to_owned(),
                // Each runtime reports here once this daemon runs one.
                runtimes: Vec::new(),
            }),
            stop,
            store,
            heartbeat: HEARTBEAT,
            peers: Peers::default(),
            pairing: Pairing::default(),
            shells: None,
            agents: None,
            doctor: None,
            host: Arc::from(hostname()),
            web: None,
            streams: None,
            roles: Arc::new(Roles::new(None)),
            hooks: Arc::new(crate::hooks::Hooks::default()),
            push: None,
        }
    }

    /// The same, reading the user's role files from `dir`.
    pub(crate) fn with_roles(mut self, dir: std::path::PathBuf) -> Self {
        self.roles = Arc::new(Roles::new(Some(dir)));
        self
    }

    /// The same, running terminals as `shells` does, with what doctor says of them.
    pub(crate) fn with_shells(
        mut self,
        shells: Arc<Shells>,
        doctor: crate::doctor::Settled,
    ) -> Self {
        self.shells = Some(shells);
        self.doctor = Some(Arc::new(doctor));
        self
    }

    /// The same, launching agents as `agents` does. They answer a closed agent's waiter in
    /// the hooks they were built on, which are to be these.
    pub(crate) fn with_agents(mut self, agents: Arc<crate::agents::Agents>) -> Self {
        self.agents = Some(agents);
        self
    }

    /// The same, serving the hooks from `hooks`, as agents built before these were built on.
    #[cfg(test)]
    pub(crate) fn with_hooks(mut self, hooks: Arc<crate::hooks::Hooks>) -> Self {
        self.hooks = hooks;
        self
    }

    /// The same, serving the web client `bundle` holds off the API.
    pub(crate) fn with_web(mut self, bundle: crate::web::Bundle) -> Self {
        self.web = Some(Arc::new(bundle));
        self
    }

    /// The same, where a pairing code may also be entered at `origins`.
    pub(crate) fn with_external_origins(mut self, origins: Vec<String>) -> Self {
        self.pairing.origins = Arc::new(origins);
        self
    }
}

/// The HTTP listener's gate: whom it admits, and whether every request must be paired.
#[derive(Debug, Clone)]
pub(crate) struct Gate {
    pub(crate) allow: Allowlists,
    pub(crate) pairing_required: bool,
}

/// The protocol's error shape, made in this one place.
pub(crate) fn fail(status: StatusCode, error: ErrorCode, message: &str) -> Response {
    let body = ErrorResponse {
        error,
        message: message.to_owned(),
        busy: None,
    };
    (status, axum::Json(body)).into_response()
}

/// This machine's name, as `os.hostname()` gives it.
fn hostname() -> String {
    rustix::system::uname()
        .nodename()
        .to_string_lossy()
        .into_owned()
}

/// The daemon's health, with its runtime's read as it is asked.
async fn health(State(shared): State<Shared>) -> axum::Json<HealthResponse> {
    let mut health = HealthResponse::clone(&shared.health);
    if let Some(shells) = &shared.shells {
        health.runtimes = crate::holder::routed(shells.terminals().health().await);
    }
    axum::Json(health)
}

/// The roles in force, each user file read again if it changed since the last answer.
async fn roles(State(shared): State<Shared>) -> Response {
    let roles = Arc::clone(&shared.roles);
    match tokio::task::spawn_blocking(move || roles.current()).await {
        Ok(now) => axum::Json(now.response()).into_response(),
        Err(err) => internal(&err),
    }
}

/// Stops the daemon once this answer is written: the listeners stop taking connections and finish
/// the ones they have, this one included.
async fn stop(State(shared): State<Shared>) -> axum::Json<StopResponse> {
    shared.stop.now(Reason::Requested);
    axum::Json(StopResponse {})
}

/// What a failure no route expects answers: the error is logged, and the client told nothing of
/// it, as Hono answers one.
pub(crate) fn internal(err: &dyn std::fmt::Display) -> Response {
    tracing::error!("bazhen: {err}");
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

/// Every read model a client draws, with the cursor its event stream resumes from.
pub(crate) async fn state(
    State(shared): State<Shared>,
    viewer: Option<Extension<Viewer>>,
) -> Response {
    let store = shared.store.clone();
    let view = SnapshotView {
        host: shared.host.to_string(),
        restart_holders: shared
            .shells
            .as_ref()
            .map_or_else(Default::default, |shells| shells.restarts().holders()),
        shells_report: shared
            .shells
            .as_ref()
            .is_some_and(|shells| shells.reports()),
    };
    let agents = shared.agents.as_ref().map(crate::agents::Agents::view);
    let inbox = crate::attention::Inbox(Arc::clone(&shared.hooks.approvals));
    let read = tokio::task::spawn_blocking(move || -> Result<StateSnapshot, SnapshotError> {
        let reader = store.reader()?;
        let reads = reader.reads();
        match &agents {
            Some(agents) => reads.snapshot_with_agents(&view, agents, Some(&inbox)),
            None => reads.snapshot(&view),
        }
    })
    .await;
    match read {
        Ok(Ok(mut snapshot)) => {
            // A device can only look: what to do about a notice is the owner's.
            if let Some(Extension(Viewer::Device { .. })) = viewer {
                for notice in &mut snapshot.notices {
                    notice.actions.clear();
                }
            }
            axum::Json(snapshot).into_response()
        }
        Ok(Err(needs @ SnapshotError::NeedsView(_))) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            &needs.to_string(),
        ),
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

/// The event stream, from the cursor its query names. A request that isn't an upgrade reaches no
/// route, as on the TypeScript daemon, where only an upgrade is routed here.
async fn stream(
    State(shared): State<Shared>,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    held: Option<Extension<Held>>,
    viewer: Option<Extension<Viewer>>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return not_found();
    };
    let Some(cursor) = query.ok().and_then(|Query(query)| events::cursor(&query)) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // A device's stream is held, to close when the device is revoked or lapses.
    let device = match viewer {
        Some(Extension(Viewer::Device { id, required, .. })) => Some(shared.pairing.holds.hold(
            id.as_str(),
            shared.stop.token(),
            required,
        )),
        _ => None,
    };
    let how = Streaming {
        stop: shared.stop.token().clone(),
        device: device.as_ref().map(|hold| hold.token().clone()),
        store: shared.store,
        heartbeat: shared.heartbeat,
    };
    upgrade
        .max_message_size(EVENT_FRAME_MAX_BYTES)
        .max_frame_size(EVENT_FRAME_MAX_BYTES)
        .on_upgrade(move |socket| async move {
            let _device = device;
            events::stream(socket, cursor, how, held.map(|Extension(held)| held)).await;
        })
}

/// A task for its caller, made once per idempotency key. An agent's subtask is a delegation, which
/// needs the assignments this daemon doesn't keep yet.
async fn create_task(
    State(shared): State<Shared>,
    caller: Option<Extension<Caller>>,
    body: Bytes,
) -> Response {
    let task = match tasks::asked(&body) {
        Ok(task) => task,
        Err(Refused::Invalid(message)) => {
            return fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &message);
        }
        Err(Refused::Assigns) => {
            return fail(
                StatusCode::BAD_REQUEST,
                ErrorCode::Unsupported,
                "this daemon can't assign a task yet",
            );
        }
    };
    let caller = callers::caller_of(caller);
    if caller.is_some() && task.parent.is_some() {
        return fail(
            StatusCode::BAD_REQUEST,
            ErrorCode::Unsupported,
            "this daemon can't make an agent's subtask yet",
        );
    }
    let task = NewTask { caller, ..task };
    match shared
        .store
        .run(move |store| store.create_task(&task))
        .await
    {
        Ok(Ok(made)) => axum::Json(made).into_response(),
        Ok(Err(err @ (CreateTaskError::NoParent(_) | CreateTaskError::NoCaller(_)))) => {
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &err.to_string())
        }
        Ok(Err(err @ CreateTaskError::ParentClosed(_))) => {
            fail(StatusCode::CONFLICT, ErrorCode::Conflict, &err.to_string())
        }
        Ok(Err(CreateTaskError::Once(OnceError::Conflict(key)))) => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("idempotency key {key} was first used for a different request"),
        ),
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

/// Task `id` in full, to any caller: its brief and note, every assignment it has had, its
/// subtasks and its notes.
async fn show_task(State(shared): State<Shared>, Path(id): Path<String>) -> Response {
    let unknown = |id: &str| {
        fail(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            &format!("no task {id}"),
        )
    };
    let Some(task) = TaskId::parse(&id) else {
        return unknown(&id);
    };
    let store = shared.store.clone();
    let read = tokio::task::spawn_blocking(move || -> Result<_, TaskReadError> {
        store.reader()?.reads().task_detail(&task)
    })
    .await;
    match read {
        Ok(Ok(Some(detail))) => axum::Json(detail).into_response(),
        Ok(Ok(None)) => unknown(&id),
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

pub(crate) fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

/// What a path no route serves answers. An upgrade there is refused bare, as the TypeScript
/// daemon refuses an upgrade it routes nowhere.
async fn unrouted(headers: HeaderMap) -> Response {
    if headers.contains_key("upgrade") {
        return refuse_upgrade(StatusCode::NOT_FOUND);
    }
    not_found()
}

/// A refused upgrade: the status with an empty body, as `http/upgrades.ts`'s `refuseUpgrade`
/// sends, and the connection closed once it is written. The headers differ: TypeScript writes the
/// status line alone and ends the socket, where hyper adds `content-length: 0` and closes the
/// connection on `Connection: close`.
pub(crate) fn refuse_upgrade(status: StatusCode) -> Response {
    (status, [(axum::http::header::CONNECTION, "close")]).into_response()
}

/// The socket's routes. Stop is here only: over HTTP, anything able to send a request could end
/// the daemon.
pub(crate) fn socket_router(shared: Shared) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/caller", get(callers::caller))
        .route("/v1/state", get(state))
        .route("/v1/roles", get(roles))
        .route("/v1/events", get(stream))
        .route(
            "/v1/terminals/{id}/stream",
            get(crate::stream::route::stream),
        )
        .route("/v1/tasks", post(create_task))
        .route("/v1/tasks/{id}", get(show_task))
        .route("/v1/pairing/codes", post(paired::issue))
        .route("/v1/devices", get(paired::list))
        .route("/v1/devices/{id}/revoke", post(paired::revoke))
        .route("/v1/notices/{id}/dismiss", post(paired::dismiss))
        .route("/v1/agents", post(agent_routes::launch))
        .route("/v1/agents/{id}/rename", post(agent_routes::rename))
        .route("/v1/agents/{id}/close", post(agent_routes::close))
        .route("/v1/agents/{id}/signal", post(agent_routes::signal))
        .route("/v1/agents/{id}/respawn", post(agent_routes::respawn))
        .route("/v1/agents/{id}/relaunch", post(agent_routes::relaunch))
        .route("/v1/agents/{id}/messages", post(crate::mail::send))
        .route("/v1/attention/{id}/answer", post(crate::attention::answer))
        .route("/v1/attention/{id}/reply", post(crate::attention::reply))
        .route(
            "/v1/attention/{id}/dismiss",
            post(crate::attention::dismiss),
        )
        .route("/v1/attention/{id}/resend", post(crate::attention::resend))
        // A hook carries what its harness sent, such as a whole file an edit wrote, and the
        // TypeScript daemon bounds neither body.
        .route(
            "/v1/hooks",
            post(crate::hooks::hook).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/v1/hooks/ack",
            post(crate::hooks::ack).layer(DefaultBodyLimit::disable()),
        )
        .route("/v1/shells", post(shell_routes::open))
        .route("/v1/shells/{id}/close", post(shell_routes::close))
        .route("/v1/shells/{id}/restart", post(shell_routes::restart))
        .route("/v1/shells/{id}/rename", post(shell_routes::rename))
        .route("/v1/shells/{id}/unlink", post(shell_routes::unlink))
        // A shell's integration reports over the socket only, never HTTP.
        .route(
            "/v1/shells/{id}/report",
            post(shell_routes::report).layer(DefaultBodyLimit::max(shell_routes::REPORT_MAX_BYTES)),
        )
        .route(
            "/v1/shells/{id}/prompt",
            post(shell_routes::prompt).layer(DefaultBodyLimit::max(shell_routes::PROMPT_MAX_BYTES)),
        )
        .route(
            "/v1/shells/{id}/decline",
            post(shell_routes::decline)
                .layer(DefaultBodyLimit::max(shell_routes::PROMPT_MAX_BYTES)),
        )
        .route("/v1/terminals/{id}/screen", get(terminal_routes::screen))
        .route("/v1/daemon/doctor", get(crate::doctor::doctor))
        .route("/v1/daemon/stop", post(stop))
        .fallback(unrouted)
        .method_not_allowed_fallback(unrouted)
        .with_state(shared.clone())
        .layer(middleware::from_fn_with_state(shared, callers::guard))
}

/// The loopback HTTP listener's routes, behind the guard. The API is a router nested at `/v1`,
/// and the pairing gate is on it, then the caller guard, so whatever axum routes there, its
/// fallback included, is gated and its caller identified: no test of the path's text can miss
/// one. Every other path is the web client's, served to a
/// browser yet to pair so it can.
pub(crate) fn http_router(shared: Shared, gate: Gate) -> Router {
    let web = shared.web.clone();
    let gate = Arc::new(gate);
    let gated = Gated {
        gate: Arc::clone(&gate),
        shared: shared.clone(),
    };
    let api = Router::new()
        .route("/health", get(health))
        .route("/caller", get(callers::caller))
        .route("/state", get(state))
        .route("/roles", get(roles))
        .route("/events", get(stream))
        .route("/terminals/{id}/stream", get(crate::stream::route::stream))
        .route("/tasks", post(create_task))
        .route("/tasks/{id}", get(show_task))
        .route("/pairing", post(paired::pair))
        .route("/notices/{id}/dismiss", post(paired::dismiss))
        .route("/agents", post(agent_routes::launch))
        .route("/agents/{id}/rename", post(agent_routes::rename))
        .route("/agents/{id}/close", post(agent_routes::close))
        .route("/agents/{id}/signal", post(agent_routes::signal))
        .route("/agents/{id}/respawn", post(agent_routes::respawn))
        .route("/agents/{id}/relaunch", post(agent_routes::relaunch))
        .route("/agents/{id}/messages", post(crate::mail::send))
        .route("/attention/{id}/answer", post(crate::attention::answer))
        .route("/attention/{id}/reply", post(crate::attention::reply))
        .route("/attention/{id}/dismiss", post(crate::attention::dismiss))
        .route("/attention/{id}/resend", post(crate::attention::resend))
        .route("/shells", post(shell_routes::open))
        .route("/shells/{id}/close", post(shell_routes::close))
        .route("/shells/{id}/restart", post(shell_routes::restart))
        .route("/shells/{id}/rename", post(shell_routes::rename))
        .route("/shells/{id}/unlink", post(shell_routes::unlink))
        .route("/terminals/{id}/screen", get(terminal_routes::screen))
        .fallback(unrouted)
        .method_not_allowed_fallback(unrouted)
        .with_state(shared.clone())
        // Past the pairing gate, the caller's process: an agent is refused as on the socket.
        .layer(middleware::from_fn_with_state(
            shared.clone(),
            callers::http_guard,
        ))
        .layer(middleware::from_fn_with_state(gated.clone(), paired::gate));
    // The nest takes `/v1` and `/v1/<rest>` but not `/v1/` itself, which Hono's `/v1/*` gates.
    let bare = any(unrouted)
        .layer(middleware::from_fn_with_state(shared, callers::http_guard))
        .layer(middleware::from_fn_with_state(gated, paired::gate));
    let router = Router::new().nest("/v1", api).route("/v1/", bare);
    let router = match web {
        Some(bundle) => {
            router.fallback(move |request: Request| crate::web::page(Arc::clone(&bundle), request))
        }
        None => router.fallback(unrouted),
    };
    router.layer(middleware::from_fn_with_state(gate, guarded))
}

/// A header as Node gives it to the TypeScript daemon: every line of it joined with ", ", each
/// byte read as latin1. A value that isn't ASCII is still there, and a line ahead of a proxy's
/// doesn't hide it.
pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut lines = headers.get_all(name).iter().peekable();
    lines.peek()?;
    let latin1 = lines.map(|line| {
        line.as_bytes()
            .iter()
            .map(|&b| char::from(b))
            .collect::<String>()
    });
    Some(latin1.collect::<Vec<_>>().join(", "))
}

fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// The Host and Origin allowlists: 421 for a Host the daemon isn't, 403 for an action from an
/// origin it doesn't admit. A refused upgrade is told the status alone.
async fn guarded(State(gate): State<Arc<Gate>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = header(headers, "host");
    let origin = header(headers, "origin");
    let upgrade = headers.contains_key("upgrade");
    let acting = !is_safe(request.method()) || upgrade;
    let Some(refusal) = guard::refusal(
        &gate.allow,
        Arrival {
            host: host.as_deref(),
            origin: origin.as_deref(),
            acting,
        },
    ) else {
        return next.run(request).await;
    };
    let (status, error, named) = match refusal {
        Refusal::HostNotAllowed => (
            StatusCode::MISDIRECTED_REQUEST,
            ErrorCode::HostNotAllowed,
            host,
        ),
        Refusal::OriginNotAllowed => (StatusCode::FORBIDDEN, ErrorCode::OriginNotAllowed, origin),
    };
    if upgrade {
        return refuse_upgrade(status);
    }
    fail(status, error, named.as_deref().unwrap_or_default())
}

#[cfg(test)]
mod edge;

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use bazhen_protocol::roles::RolesResponse;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    const HOST: &str = "127.0.0.1:7900";

    fn shared() -> Shared {
        Shared::new("f".repeat(64).as_str(), Stop::default(), Writer::closed())
    }

    /// The state a router answers, from a store of its own after `seed` writes to it.
    fn state_after(
        seed: &str,
        router: impl FnOnce(Shared) -> Router,
        headers: &[(&str, &str)],
    ) -> (u16, Value) {
        let dir = crate::testing::TempDir::new("routes-state");
        let path = dir.path().join("bazhen.db");
        drop(bazhen_store::Store::open(&path).unwrap());
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(seed)
            .unwrap();
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store);
        let answer = send(router(shared), request("GET", "/v1/state", headers));
        thread.finish();
        answer
    }

    #[test]
    fn answers_the_state_with_its_cursor_on_the_socket() {
        let (status, body) = state_after("", socket_router, &[]);
        assert_eq!(
            (status, &body["eventId"], &body["tasks"], &body["agents"]),
            (200, &json!(0), &json!([]), &json!([]))
        );
        assert_eq!(body["epoch"].as_str().map(str::len), Some(32), "{body}");
    }

    #[test]
    fn answers_the_state_over_http_only_past_the_gate() {
        let gated = |pairing_required| {
            move |shared| {
                let allow = guard::allowlists(7900, None, &[]);
                crate::testing::connected(http_router(
                    shared,
                    Gate {
                        allow,
                        pairing_required,
                    },
                ))
            }
        };
        let (open, body) = state_after("", gated(false), &[("host", HOST)]);
        assert_eq!((open, &body["eventId"]), (200, &json!(0)));
        let (paired, body) = state_after("", gated(true), &[("host", HOST)]);
        assert_eq!((paired, &body["error"]), (401, &json!("unpaired")));
    }

    #[test]
    fn answers_unavailable_rather_than_a_state_that_leaves_out_what_it_cant_describe() {
        let (status, body) = state_after(
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
               VALUES ((SELECT id FROM host), '2026-11-01T00:00:00.000Z', 'environment.created',
                 'environment', 'env_1', 'system', '{}');
             INSERT INTO environments (id, kind, created_event_id) VALUES ('env_1', 'local', 1);
             INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
               created_event_id, updated_event_id)
               VALUES ('agent_1', 'env_1', 'codex', 'p', '/', 'running', 1, 1);",
            socket_router,
            &[],
        );
        assert_eq!(
            (status, body),
            (
                503,
                refused("unavailable", "this daemon can't describe agents yet")
            )
        );
    }

    #[test]
    fn describes_the_agents_it_runs_in_the_state_as_their_harness_says() {
        use crate::testing::stub_harness::{StubHarness, pull};
        let f = crate::agents::tests::stubbed(&StubHarness::new(pull()));
        let launched = crate::testing::runtime()
            .block_on(f.launch(crate::agents::tests::request("k-1")))
            .unwrap();
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let (status, body) = send(socket_router(shared), request("GET", "/v1/state", &[]));
        assert_eq!(
            (
                status,
                &body["agents"][0]["id"],
                &body["agents"][0]["themes"],
                &body["agents"][0]["resumable"],
            ),
            (
                200,
                &json!(launched.agent_id.as_str()),
                &json!(["dark"]),
                &json!(false)
            ),
            "{body}"
        );
    }

    #[test]
    fn signals_an_agent_named_by_its_id_or_live_name_reading_its_body_before_the_agent() {
        use crate::testing::stub_harness::{StubHarness, pull};
        let f = crate::agents::tests::stubbed(&StubHarness::new(pull()));
        let launched = crate::testing::runtime()
            .block_on(f.launch(bazhen_protocol::agents::LaunchAgentRequest {
                name: Some(bazhen_protocol::names::AgentName::parse("lead").unwrap()),
                ..crate::agents::tests::request("k-1")
            }))
            .unwrap();
        let agent = launched.agent_id.as_str();
        let generation = f
            .store
            .reader()
            .unwrap()
            .reads()
            .agent_terminal(agent)
            .unwrap()
            .and_then(|found| found.generation)
            .unwrap();
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let signal = |reference: &str, key: &str| {
            let body =
                json!({ "idempotencyKey": key, "generation": generation, "signal": "SIGINT" });
            send(
                socket_router(shared.clone()),
                post(&format!("/v1/agents/{reference}/signal"), &[], &body),
            )
        };
        let unknown = "agent_0190a1b2c3d47abc8def0123456789a1";
        assert_eq!(
            [
                signal("LEAD", "s-1"),
                signal(agent, "s-1"),
                signal("nobody", "s-2"),
                signal(unknown, "s-2"),
                signal("nobody", ""),
            ],
            [
                (
                    200,
                    json!({ "agentId": agent, "eventIds": [f.types().len()] })
                ),
                (
                    200,
                    json!({ "agentId": agent, "eventIds": [f.types().len()] })
                ),
                (404, refused("not_found", "no agent nobody by that name")),
                (404, refused("not_found", &format!("no agent {unknown}"))),
                (
                    400,
                    refused("invalid_request", "idempotencyKey is 1 to 200 characters")
                ),
            ]
        );
    }

    #[test]
    fn closes_an_agent_with_its_linked_shells_keeping_those_it_names_standalone() {
        use crate::shells::tests::beside;
        use crate::testing::stub_harness::{StubHarness, pull};
        use bazhen_protocol::shells::TerminalState;
        let f = crate::agents::tests::stubbed(&StubHarness::new(pull()));
        let shells = f.shells();
        let (agent, generation, taken, kept) = crate::testing::runtime().block_on(async {
            let agent = f
                .launch(crate::agents::tests::request("k-1"))
                .await
                .unwrap()
                .agent_id;
            let generation = f
                .store
                .reader()
                .unwrap()
                .reads()
                .agent_terminal(agent.as_str())
                .unwrap()
                .and_then(|found| found.generation)
                .unwrap();
            let [taken, kept] = [
                shells.open(&beside("s-1", &agent), None).await,
                shells.open(&beside("s-2", &agent), None).await,
            ]
            .map(|opened| opened.unwrap().terminal_id);
            (agent, generation, taken, kept)
        });
        let mut shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        shared.shells = Some(shells);
        let body = json!({
            "idempotencyKey": "c-1",
            "generation": generation,
            "keepShells": [kept.as_str()],
        });
        let (status, _) = send(
            socket_router(shared),
            post(&format!("/v1/agents/{agent}/close"), &[], &body),
        );
        let reader = f.store.reader().unwrap();
        let reads = reader.reads();
        let linked: Vec<String> = reads
            .linked_shells(agent.as_str())
            .unwrap()
            .into_iter()
            .map(|row| row.id.as_str().to_owned())
            .collect();
        assert_eq!(
            (
                status,
                reads.agent_state(agent.as_str()).unwrap(),
                reads.terminal_state(taken.as_str()).unwrap(),
                reads.terminal_state(kept.as_str()).unwrap(),
                linked,
            ),
            (
                200,
                Some("closed".to_owned()),
                Some(TerminalState::Closed),
                Some(TerminalState::Running),
                Vec::new(),
            )
        );
    }

    /// What a waiter `agent` held was answered with, after a close `ahead` of its generation over the
    /// socket: its status, and the answer, where one came within `within`.
    fn closed_holding(
        ahead: u64,
        within: std::time::Duration,
    ) -> (
        u16,
        Result<bazhen_protocol::mail::HookReply, tokio::time::error::Elapsed>,
    ) {
        use crate::testing::stub_harness::{StubHarness, pull};
        let f = crate::agents::tests::stubbed(&StubHarness::new(pull()));
        let (agent, generation) = crate::testing::runtime().block_on(async {
            let agent = f
                .launch(crate::agents::tests::request("k-1"))
                .await
                .unwrap()
                .agent_id;
            let generation = f
                .store
                .reader()
                .unwrap()
                .reads()
                .agent_terminal(agent.as_str())
                .unwrap()
                .and_then(|found| found.generation)
                .unwrap();
            (agent, generation)
        });
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let mut waiting = shared.hooks.waiter(&agent);
        let body = json!({ "idempotencyKey": "c-1", "generation": generation + ahead });
        let (status, _) = send(
            socket_router(shared),
            post(&format!("/v1/agents/{agent}/close"), &[], &body),
        );
        let answered = crate::testing::runtime()
            .block_on(async { tokio::time::timeout(within, waiting.answered()).await });
        (status, answered)
    }

    #[test]
    fn answers_the_waiter_a_closed_agent_held_quiet() {
        assert_eq!(
            closed_holding(0, std::time::Duration::from_secs(5)),
            (
                200,
                Ok(bazhen_protocol::mail::HookReply {
                    exit_code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    offered: Vec::new(),
                })
            )
        );
    }

    #[test]
    fn keeps_the_waiter_of_an_agent_its_close_left_open() {
        let (status, answered) = closed_holding(1, std::time::Duration::from_millis(200));
        assert_eq!((status, answered.ok()), (409, None));
    }

    /// Respawns `agent` over the socket with `key` at `generation`.
    fn respawn(shared: &Shared, agent: &str, key: &str, generation: u64) -> (u16, Value) {
        let body = json!({ "idempotencyKey": key, "generation": generation });
        send(
            socket_router(shared.clone()),
            post(&format!("/v1/agents/{agent}/respawn"), &[], &body),
        )
    }

    #[test]
    fn starts_an_exited_agent_again_answering_a_repeat_as_the_first_and_refusing_it_while_it_starts()
     {
        use crate::testing::stub_harness::{StubHarness, pull};
        let (f, agent, generation) =
            crate::agents::restart::tests::exited(&StubHarness::new(pull()).resuming());
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let before = f.types().len() as u64;
        let id = agent.as_str();
        let answered = json!({ "agentId": id, "eventIds": [before + 1, before + 2] });
        assert_eq!(
            [
                respawn(&shared, id, "r-1", generation),
                respawn(&shared, id, "r-1", generation),
                respawn(&shared, id, "r-2", generation),
            ],
            [
                (200, answered.clone()),
                (200, answered),
                (409, refused("conflict", &format!("agent {id} is starting"))),
            ]
        );
    }

    /// Relaunches `agent` over the socket with `key` at `generation`, on a fresh session.
    fn relaunch_fresh(shared: &Shared, agent: &str, key: &str, generation: u64) -> (u16, Value) {
        let body = json!({ "idempotencyKey": key, "generation": generation, "fresh": true });
        send(
            socket_router(shared.clone()),
            post(&format!("/v1/agents/{agent}/relaunch"), &[], &body),
        )
    }

    #[test]
    fn relaunches_a_lost_agent_fresh_answering_a_repeat_as_the_first_and_refusing_it_while_it_starts()
     {
        use crate::testing::stub_harness::{StubHarness, pull};
        let (f, agent, generation) = crate::agents::restart::tests::lost(&StubHarness::new(pull()));
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let before = f.types().len() as u64;
        let id = agent.as_str();
        let answered = json!({ "agentId": id, "eventIds": [before + 1, before + 2] });
        assert_eq!(
            [
                relaunch_fresh(&shared, id, "r-1", generation),
                relaunch_fresh(&shared, id, "r-1", generation),
                relaunch_fresh(&shared, id, "r-2", generation),
            ],
            [
                (200, answered.clone()),
                (200, answered),
                (409, refused("conflict", &format!("agent {id} is starting"))),
            ]
        );
    }

    #[test]
    fn refuses_to_start_again_an_agent_whose_session_cant_resume() {
        use crate::testing::stub_harness::{StubHarness, pull};
        let (f, agent, generation) =
            crate::agents::restart::tests::exited(&StubHarness::new(pull()));
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let id = agent.as_str();
        assert_eq!(
            respawn(&shared, id, "r-1", generation),
            (
                409,
                refused(
                    "not_resumable",
                    &format!("agent {id}'s harness can't resume its session")
                )
            )
        );
    }

    /// An exited agent and another bound to the same session on a harness that resumes, as
    /// `alone` says its sessions are held; with the exited one's generation.
    fn sharing_a_session(
        alone: bool,
    ) -> (
        crate::agents::tests::Fixture,
        bazhen_protocol::ids::AgentId,
        bazhen_protocol::ids::AgentId,
        u64,
    ) {
        use crate::testing::stub_harness::{StubHarness, pull};
        let stub = StubHarness::new(pull()).resuming();
        let stub = if alone { stub.held_alone() } else { stub };
        let (f, agent, generation) = crate::agents::restart::tests::exited(&stub);
        let other = crate::testing::runtime()
            .block_on(f.launch(crate::agents::tests::request("k-2")))
            .unwrap()
            .agent_id;
        let bound = [agent.as_str().to_owned(), other.as_str().to_owned()];
        crate::testing::runtime()
            .block_on(f.store.run(move |store| {
                store.write(|w| {
                    for id in &bound {
                        w.connection().execute(
                            "UPDATE agent_sessions SET external_ref =
                               json_set(external_ref, '$.id', 't-1')
                             WHERE id = ?",
                            [id],
                        )?;
                    }
                    Ok::<_, rusqlite::Error>(())
                })
            }))
            .unwrap()
            .unwrap();
        (f, agent, other, generation)
    }

    #[test]
    fn refuses_to_start_again_an_agent_on_a_session_another_agent_holds_alone() {
        let (f, agent, other, generation) = sharing_a_session(true);
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        let before = f.types().len();
        let id = agent.as_str();
        assert_eq!(
            (respawn(&shared, id, "r-1", generation), f.types().len()),
            (
                (
                    409,
                    refused(
                        "not_resumable",
                        &format!("agent {id} can't resume session t-1: {other} is on it too")
                    )
                ),
                before
            )
        );
    }

    #[test]
    fn starts_an_agent_again_on_a_session_another_holds_where_its_harness_shares_sessions() {
        let (f, agent, _other, generation) = sharing_a_session(false);
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), f.store.clone())
            .with_hooks(Arc::clone(f.agents.hooks()))
            .with_agents(Arc::clone(&f.agents));
        assert_eq!(respawn(&shared, agent.as_str(), "r-1", generation).0, 200);
    }

    fn http(pairing_required: bool) -> Router {
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required,
        };
        crate::testing::on_an_empty_store(|writer| {
            let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), writer);
            crate::testing::connected(http_router(shared, gate))
        })
    }

    fn request(method: &str, path: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::empty()).unwrap()
    }

    /// The status and body a router answers `request` with; a body that isn't JSON is its text.
    fn send(router: Router, request: Request) -> (u16, Value) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
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

    fn refused(error: &str, message: &str) -> Value {
        json!({ "error": error, "message": message })
    }

    #[test]
    fn the_socket_answers_health_with_the_protocol_it_speaks() {
        assert_eq!(
            send(socket_router(shared()), request("GET", "/v1/health", &[])),
            (
                200,
                json!({
                    "status": "ok",
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "protocolId": "f".repeat(64),
                    "runtimes": [],
                })
            )
        );
    }

    #[test]
    fn answers_the_roles_in_force_on_the_socket_and_on_loopback() {
        let keys = |(status, body): (u16, Value)| {
            let roles = body["roles"].as_array().cloned().unwrap_or_default();
            let keys: Vec<Value> = roles.iter().map(|r| r["key"].clone()).collect();
            (status, keys, body["problems"].clone())
        };
        let want = (
            200,
            vec![
                json!("coordinator"),
                json!("lead"),
                json!("worker"),
                json!("reviewer"),
            ],
            json!([]),
        );
        let socket = send(socket_router(shared()), request("GET", "/v1/roles", &[]));
        assert!(
            serde_json::from_value::<RolesResponse>(socket.1.clone()).is_ok(),
            "{socket:?}"
        );
        assert_eq!(keys(socket), want);
        let loopback = send(http(false), request("GET", "/v1/roles", &[("host", HOST)]));
        assert_eq!(keys(loopback), want);
    }

    /// Health says the version both daemons are: the TypeScript one's `APP_VERSION` and this crate's
    /// own, held equal here, so a bump to one alone fails.
    #[test]
    fn health_says_the_version_the_typescript_daemon_says() {
        let main = include_str!("../../../apps/daemon/src/main.ts");
        let theirs = main
            .lines()
            .find_map(|line| line.strip_prefix("const APP_VERSION = \""))
            .and_then(|rest| rest.strip_suffix("\";"));
        assert_eq!(theirs, Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn a_stop_over_the_socket_answers_then_stops_and_the_first_reason_stands() {
        let shared = shared();
        let stop = shared.stop.clone();
        let answer = send(
            socket_router(shared),
            request("POST", "/v1/daemon/stop", &[]),
        );
        stop.now(Reason::Sigterm);
        assert_eq!(
            (answer, stop.token().is_cancelled(), stop.reason()),
            ((200, json!({})), true, Some(Reason::Requested))
        );
    }

    #[test]
    fn http_has_no_stop_and_answers_health_to_its_own_host_on_get_only() {
        let stop = Stop::default();
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let router = crate::testing::on_an_empty_store(|writer| {
            let shared = Shared::new("f".repeat(64).as_str(), stop.clone(), writer);
            crate::testing::connected(http_router(shared, gate))
        });
        assert_eq!(
            [
                send(
                    router.clone(),
                    request("POST", "/v1/daemon/stop", &[("host", HOST)])
                )
                .0,
                send(
                    router.clone(),
                    request("DELETE", "/v1/health", &[("host", HOST)])
                )
                .0,
                send(router, request("GET", "/v1/health", &[("host", HOST)])).0,
            ],
            [404, 404, 200]
        );
        assert!(!stop.token().is_cancelled());
    }

    const UPGRADE: (&str, &str) = ("upgrade", "websocket");

    /// What a router answers `request` with as the wire carries it: the status, the `Connection`
    /// header, and the body's text.
    fn answer(router: Router, request: Request) -> (u16, Option<String>, String) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let response = router.oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let connection = response
                .headers()
                .get("connection")
                .map(|v| v.to_str().unwrap().to_owned());
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            (
                status,
                connection,
                String::from_utf8_lossy(&bytes).into_owned(),
            )
        })
    }

    /// The status alone, on a connection then closed, as the TypeScript daemon refuses an upgrade.
    fn bare(status: u16) -> (u16, Option<String>, String) {
        (status, Some("close".to_owned()), String::new())
    }

    #[test]
    fn refuses_another_host_with_421_and_an_action_from_another_origin_with_403() {
        let evil = [("host", HOST), ("origin", "https://evil.example")];
        let elsewhere = [("host", "evil.example")];
        assert_eq!(
            [
                send(http(false), request("GET", "/v1/health", &elsewhere)),
                send(http(false), request("GET", "/v1/health", &[])),
                send(http(false), request("POST", "/v1/health", &evil)),
            ],
            [
                (421, refused("host_not_allowed", "evil.example")),
                (421, refused("host_not_allowed", "")),
                (403, refused("origin_not_allowed", "https://evil.example")),
            ]
        );
        assert_eq!(
            [
                answer(http(false), request("GET", "/v1/health", &elsewhere)).1,
                answer(http(false), request("POST", "/v1/health", &evil)).1,
            ],
            [None, None]
        );
        assert_eq!(
            [
                answer(
                    http(false),
                    request("GET", "/v1/events", &[elsewhere[0], UPGRADE])
                ),
                answer(http(false), request("GET", "/v1/events", &[UPGRADE])),
                answer(
                    http(false),
                    request("GET", "/v1/events", &[evil[0], evil[1], UPGRADE])
                ),
            ],
            [bare(421), bare(421), bare(403)]
        );
    }

    /// Where pairing is required, an upgrade with no device's cookie is told 401 alone, and the
    /// same request that doesn't upgrade is still told to pair.
    #[test]
    fn refuses_an_unpaired_upgrade_with_401_alone_and_tells_a_request_to_pair() {
        assert_eq!(
            answer(
                http(true),
                request("GET", "/v1/events", &[("host", HOST), UPGRADE])
            ),
            bare(401)
        );
        assert_eq!(
            answer(http(true), request("GET", "/v1/events", &[("host", HOST)])),
            (
                401,
                None,
                refused("unpaired", "pair this browser: run `bazhen devices pair`").to_string()
            )
        );
    }

    /// An upgrade to a path no route serves is told 404 alone on either listener, and a request
    /// that doesn't upgrade is told it in words, as Hono tells it.
    #[test]
    fn refuses_an_upgrade_no_route_serves_with_404_alone_on_either_listener() {
        let not_found = (404, None, "404 Not Found".to_owned());
        assert_eq!(
            [
                answer(
                    http(false),
                    request("GET", "/v1/nowhere", &[("host", HOST), UPGRADE])
                ),
                answer(
                    http(false),
                    request("GET", "/v1/", &[("host", HOST), UPGRADE])
                ),
                answer(
                    http(false),
                    request("GET", "/v1/tasks", &[("host", HOST), UPGRADE])
                ),
                answer(
                    socket_router(shared()),
                    request("GET", "/v1/nowhere", &[UPGRADE])
                ),
            ],
            [bare(404), bare(404), bare(404), bare(404)]
        );
        assert_eq!(
            [
                answer(
                    http(false),
                    request("GET", "/v1/nowhere", &[("host", HOST)])
                ),
                answer(http(false), request("GET", "/v1/", &[("host", HOST)])),
                answer(http(false), request("GET", "/v1/tasks", &[("host", HOST)])),
                answer(socket_router(shared()), request("GET", "/v1/nowhere", &[])),
            ],
            [
                not_found.clone(),
                not_found.clone(),
                not_found.clone(),
                not_found
            ]
        );
    }

    #[test]
    fn a_page_elsewhere_reads_on_loopback_only_where_pairing_isnt_required() {
        let evil = [("host", HOST), ("origin", "https://evil.example")];
        assert_eq!(
            [
                send(http(false), request("GET", "/v1/health", &evil)).0,
                send(http(true), request("GET", "/v1/health", &evil)).0,
            ],
            [200, 403]
        );
    }

    /// Wherever pairing is required, an API request with no device's cookie is refused, but the
    /// one that pairs a device, which the gate lets by to be read.
    #[test]
    fn where_pairing_is_required_refuses_every_api_request_but_pairing_as_unpaired() {
        let unpaired = (
            401,
            refused("unpaired", "pair this browser: run `bazhen devices pair`"),
        );
        let own = [("host", HOST), ("origin", "http://127.0.0.1:7900")];
        let forwarded = [("host", HOST), ("x-forwarded-for", "192.168.1.30")];
        let proxied = [("host", HOST), ("forwarded", "for=10.0.0.1")];
        assert_eq!(
            [
                send(http(true), request("GET", "/v1/health", &[("host", HOST)])),
                send(http(true), request("GET", "/v1/health", &own)),
                send(http(true), request("GET", "/v1/pairing", &own)),
                send(http(false), request("GET", "/v1/health", &forwarded)),
                send(http(false), request("GET", "/v1/health", &proxied)),
                send(http(true), request("POST", "/v1/pairing", &own)),
            ],
            [
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired,
                (
                    400,
                    refused("invalid_request", "the body is not a JSON object")
                ),
            ]
        );
    }

    /// A request with `headers` sent as raw bytes, each pair its own line, as a proxy that adds a
    /// line of its own sends them.
    fn raw_request(method: &str, headers: &[(&str, &[u8])]) -> Request {
        let mut builder = Request::builder().method(method).uri("/v1/health");
        for (name, value) in headers {
            builder = builder.header(*name, axum::http::HeaderValue::from_bytes(value).unwrap());
        }
        builder.body(Body::empty()).unwrap()
    }

    /// Node joins a header sent on several lines with ", ", and reads bytes past ASCII as latin1,
    /// so neither a line a client sends ahead of a proxy's nor a byte the client picks hides the
    /// proxy's hop, nor an Origin.
    #[test]
    fn reads_every_line_of_a_header_and_every_byte_of_it_as_node_does() {
        let unpaired = (
            401,
            refused("unpaired", "pair this browser: run `bazhen devices pair`"),
        );
        let host: (&str, &[u8]) = ("host", HOST.as_bytes());
        assert_eq!(
            [
                send(
                    http(false),
                    raw_request(
                        "GET",
                        &[
                            host,
                            ("x-forwarded-for", b"127.0.0.1"),
                            ("x-forwarded-for", b"192.168.1.30"),
                        ]
                    )
                ),
                send(
                    http(false),
                    raw_request(
                        "GET",
                        &[
                            host,
                            ("forwarded", b"for=127.0.0.1"),
                            ("forwarded", b"for=10.0.0.1")
                        ]
                    )
                ),
                send(
                    http(false),
                    raw_request("GET", &[host, ("x-forwarded-for", b"\xff,192.168.1.30")])
                ),
                send(
                    http(false),
                    raw_request("GET", &[host, ("x-forwarded-for", b"\x85")])
                ),
                send(
                    http(false),
                    raw_request("GET", &[host, ("x-forwarded-for", b"127.0.0.1\x85")])
                ),
                send(
                    http(false),
                    raw_request("GET", &[host, ("forwarded", b"for=\x85")])
                ),
                send(
                    http(false),
                    raw_request("POST", &[host, ("origin", b"http://evil\xe9")])
                ),
                send(
                    http(false),
                    raw_request("GET", &[host, ("host", b"evil.example")])
                ),
            ],
            [
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired,
                (403, refused("origin_not_allowed", "http://evil\u{e9}")),
                (
                    421,
                    refused("host_not_allowed", "127.0.0.1:7900, evil.example")
                ),
            ]
        );
    }

    /// The gate is on the router the API is nested in, not a test of the path's text, so a path
    /// that only looks like the API reaches no route, and every one the API matches is gated.
    #[test]
    fn a_path_that_only_looks_like_the_api_reaches_no_route_and_the_api_is_gated_whole() {
        let unpaired = (
            401,
            refused("unpaired", "pair this browser: run `bazhen devices pair`"),
        );
        let get = |path: &str| send(http(true), request("GET", path, &[("host", HOST)]));
        assert_eq!(
            [
                get("//v1/health").0,
                get("/V1/health").0,
                get("/%761/health").0,
                get("/v1health").0,
            ],
            [404; 4]
        );
        assert_eq!(
            [
                get("/v1"),
                get("/v1/"),
                get("/v1/health"),
                get("/v1/nothing/here")
            ],
            [
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired
            ]
        );
    }

    #[test]
    fn the_gate_stands_in_front_of_the_api_only() {
        assert_eq!(
            send(http(true), request("GET", "/", &[("host", HOST)])).0,
            404
        );
    }

    /// A socket router and an HTTP one over one store of their own, with what to finish them by.
    fn over_a_store() -> (Router, Router, std::path::PathBuf, Finish) {
        let dir = crate::testing::TempDir::new("routes-tasks");
        let path = dir.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store);
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let http = crate::testing::connected(http_router(shared.clone(), gate));
        (
            socket_router(shared),
            http,
            path,
            Finish {
                thread: Some(thread),
                _dir: dir,
            },
        )
    }

    /// Finishes the writer, then removes its directory.
    struct Finish {
        thread: Option<crate::writer::Thread>,
        _dir: crate::testing::TempDir,
    }

    impl Drop for Finish {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.finish();
            }
        }
    }

    fn post(path: &str, headers: &[(&str, &str)], body: &Value) -> Request {
        let mut request = request("POST", path, headers);
        *request.body_mut() = Body::from(serde_json::to_vec(body).unwrap());
        request
    }

    const LOCAL: [(&str, &str); 2] = [("host", HOST), ("origin", "http://127.0.0.1:7900")];

    const LEAD: &str = "agent_01900000000070008000000000000001";
    const PEER: &str = "agent_01900000000070008000000000000002";

    /// Both listeners over a store holding two live agents, `lead` and `peer`.
    fn over_two_agents() -> (Router, Router, std::path::PathBuf, Finish) {
        let (socket, http, path, finish) = over_a_store();
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(&format!(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state, name,
                   created_event_id, updated_event_id) VALUES
                   ('{LEAD}', 'env_local', 'claude-code', 'p', '/', 'running', 'lead', 1, 1),
                   ('{PEER}', 'env_local', 'claude-code', 'p', '/', 'running', 'peer', 1, 1);"
            ))
            .unwrap();
        (socket, http, path, finish)
    }

    /// Each `agent.renamed`, as its actor and payload.
    fn renamed(path: &std::path::Path) -> Vec<(String, Value)> {
        let store = bazhen_store::Store::open(path).unwrap();
        store
            .reads()
            .events(0, 100)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == "agent.renamed")
            .map(|e| (e.actor, serde_json::from_str(&e.payload).unwrap()))
            .collect()
    }

    #[test]
    fn renames_an_agent_for_the_human_on_either_listener_by_its_id_or_its_name() {
        let (socket, http, path, _finish) = over_two_agents();
        let by_id = send(
            socket,
            post(
                &format!("/v1/agents/{LEAD}/rename"),
                &[],
                &json!({ "idempotencyKey": "a", "name": "reviewer" }),
            ),
        );
        let by_name = send(
            http,
            post(
                "/v1/agents/REVIEWER/rename",
                &[LOCAL[0], LOCAL[1]],
                &json!({ "idempotencyKey": "b", "name": "lead" }),
            ),
        );
        assert_eq!(
            [by_id.0, by_name.0],
            [200, 200],
            "{} {}",
            by_id.1,
            by_name.1
        );
        assert_eq!(by_id.1["agentId"], LEAD);
        assert_eq!(
            renamed(&path),
            [
                (
                    "user".to_owned(),
                    json!({ "name": "reviewer", "previous": "lead" })
                ),
                (
                    "user".to_owned(),
                    json!({ "name": "lead", "previous": "reviewer" })
                ),
            ]
        );
    }

    #[test]
    fn answers_a_rename_with_the_protocols_error_for_each_way_it_fails() {
        let (socket, _http, path, _finish) = over_two_agents();
        let rename = |agent: &str, key: &str, name: &str| {
            let (status, body) = send(
                socket.clone(),
                post(
                    &format!("/v1/agents/{agent}/rename"),
                    &[],
                    &json!({ "idempotencyKey": key, "name": name }),
                ),
            );
            (status, body["error"].clone(), body["message"].clone())
        };
        let gone = "agent_01900000000070008000000000000009";
        let first = rename(LEAD, "k", "first");
        let answered = [
            rename(LEAD, "t", "PEER"),
            rename(LEAD, "x", "-x"),
            rename(gone, "u", "x"),
            rename("nobody", "v", "x"),
            rename(LEAD, "k", "other"),
        ];
        assert_eq!(first.0, 200);
        assert_eq!(
            answered,
            [
                (
                    409,
                    json!("conflict"),
                    json!("another agent is named PEER; close it or pick another name")
                ),
                (400, json!("invalid_request"), answered[1].2.clone()),
                (404, json!("not_found"), json!(format!("no agent {gone}"))),
                (
                    404,
                    json!("not_found"),
                    json!("no agent nobody by that name")
                ),
                (
                    409,
                    json!("conflict"),
                    json!("idempotency key k was first used for a different request")
                ),
            ]
        );
        assert!(
            answered[1]
                .2
                .as_str()
                .is_some_and(|m| m.starts_with("the body is not a rename")),
            "{:?}",
            answered[1]
        );
        assert_eq!(renamed(&path).len(), 1);
    }

    #[test]
    fn makes_a_task_for_the_human_once_per_key_on_either_listener() {
        let (socket, http, _, _finish) = over_a_store();
        let ask = json!({ "idempotencyKey": "a", "title": " Ship ", "brief": "b" });
        let (status, made) = send(socket.clone(), post("/v1/tasks", &[], &ask));
        assert_eq!(status, 200, "{made}");
        let task = made["taskId"].as_str().unwrap().to_owned();
        assert!(
            bazhen_protocol::ids::TaskId::parse(&task).is_some(),
            "{task}"
        );
        assert_eq!(
            made,
            json!({ "taskId": task, "assignmentId": null, "eventIds": [1] })
        );
        assert_eq!(
            send(socket.clone(), post("/v1/tasks", &[], &ask)),
            (200, made)
        );
        let child =
            json!({ "idempotencyKey": "b", "title": "C", "brief": "b", "parentTaskId": task });
        let (status, under) = send(http, post("/v1/tasks", &LOCAL, &child));
        assert_eq!((status, &under["eventIds"]), (200, &json!([2])), "{under}");
        let other = json!({ "idempotencyKey": "a", "title": "Ship", "brief": "else" });
        assert_eq!(
            send(socket, post("/v1/tasks", &[], &other)),
            (
                409,
                refused(
                    "conflict",
                    "idempotency key a was first used for a different request"
                )
            )
        );
    }

    #[test]
    fn makes_a_task_whose_title_and_brief_are_astral_text_at_their_bounds() {
        let (socket, _, _, _finish) = over_a_store();
        let emoji = |n: usize| "\u{1f600}".repeat(n);
        let ask = |key: &str, title: String, brief: String| {
            let body = json!({ "idempotencyKey": key, "title": title, "brief": brief });
            let (status, answer) = send(socket.clone(), post("/v1/tasks", &[], &body));
            (status, answer["error"].clone())
        };
        assert_eq!(
            [
                ask("t", emoji(200), "b".to_owned()),
                ask("b", "T".to_owned(), emoji(20_000)),
                ask("t2", emoji(201), "b".to_owned()),
                ask("b2", "T".to_owned(), emoji(20_001)),
            ],
            [
                (200, Value::Null),
                (200, Value::Null),
                (400, json!("invalid_request")),
                (400, json!("invalid_request")),
            ]
        );
    }

    #[test]
    fn refuses_a_task_it_cant_make_as_the_typescript_daemon_does() {
        let (socket, _, path, _finish) = over_a_store();
        let missing = "task_01900000000070008000000000000009";
        let ask = |key: &str, more: Value| {
            let mut body = json!({ "idempotencyKey": key, "title": "T", "brief": "b" });
            body.as_object_mut()
                .unwrap()
                .extend(more.as_object().unwrap().clone());
            post("/v1/tasks", &[], &body)
        };
        assert_eq!(
            send(socket.clone(), ask("a", json!({ "parentTaskId": missing }))),
            (404, refused("not_found", &format!("no task {missing}")))
        );
        let (_, made) = send(socket.clone(), ask("b", json!({})));
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute("UPDATE tasks SET state = 'cancelled'", ())
            .unwrap();
        let under = json!({ "parentTaskId": made["taskId"] });
        assert_eq!(
            send(socket.clone(), ask("c", under)),
            (409, refused("conflict", "the parent task is cancelled"))
        );
        let grant = json!({ "assign": { "agentId": "reviewer-1", "role": "worker" } });
        assert_eq!(
            send(socket.clone(), ask("d", grant)),
            (
                400,
                refused("unsupported", "this daemon can't assign a task yet")
            )
        );
        let (status, invalid) = send(socket, ask("e", json!({ "brief": "" })));
        assert_eq!(
            (status, &invalid["error"]),
            (400, &json!("invalid_request"))
        );
    }

    #[test]
    fn refuses_on_the_socket_whoever_presents_an_agents_credentials_and_takes_the_rest_as_human() {
        let dir = crate::testing::TempDir::new("routes-callers");
        let path = dir.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let router = || {
            socket_router(Shared::new(
                "f".repeat(64).as_str(),
                Stop::default(),
                store.clone(),
            ))
        };
        let agent = "agent_01900000000070008000000000000002";
        let cases = [
            (
                "bazhen-agent-token",
                "t".to_owned(),
                "the agent token is no live agent's".to_owned(),
            ),
            (
                "bazhen-agent-token",
                String::new(),
                "the agent token is no live agent's".to_owned(),
            ),
            (
                "bazhen-agent-id",
                agent.to_owned(),
                format!("agent {agent} must present its agent token"),
            ),
            (
                "bazhen-agent-id",
                "me".to_owned(),
                "not an agent id: me".to_owned(),
            ),
        ];
        for (name, value, reason) in cases {
            let presenting = [(name, value.as_str())];
            for (method, path) in [
                ("GET", "/v1/health"),
                ("GET", "/v1/state"),
                ("GET", "/v1/nowhere"),
            ] {
                assert_eq!(
                    send(router(), request(method, path, &presenting)),
                    (403, refused("forbidden", &reason)),
                    "{name}: {value} on {path}"
                );
            }
            let upgrade = [(name, value.as_str()), ("upgrade", "websocket")];
            assert_eq!(
                send(router(), request("GET", "/v1/events", &upgrade)),
                (403, refused("forbidden", &reason))
            );
            assert_eq!(
                send(router(), request("POST", "/v1/daemon/stop", &presenting)),
                (
                    403,
                    refused(
                        "forbidden",
                        &format!("an agent can't stop the daemon: {reason}")
                    )
                )
            );
            assert_eq!(
                send(router(), request("GET", "/elsewhere", &presenting)).0,
                404
            );
        }
        for human in [
            vec![],
            vec![("bazhen-agent-id", "")],
            vec![("bazhen-codex-thread", "0199-thread")],
        ] {
            assert_eq!(send(router(), request("GET", "/v1/health", &human)).0, 200);
        }
        thread.finish();
    }
}
