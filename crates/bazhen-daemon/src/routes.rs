//! The API's routes and the layers in front of them: one router for the Unix socket, whose 0600
//! mode makes its caller the owner, and one for loopback HTTP, behind the Host/Origin guard and
//! the pairing gate (`http/app.ts`, `socket/routes.ts`).

use std::sync::{Arc, OnceLock};

use axum::extract::rejection::QueryRejection;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Query, Request, State};
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
use bazhen_store::SnapshotError;
use tokio_util::sync::CancellationToken;

use crate::accept::Held;
use crate::events::{self, Streaming};
use crate::guard::{self, Allowlists, Arrival, Refusal};
use crate::heartbeat::{HEARTBEAT, Heartbeat};
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
        }
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

async fn health(State(shared): State<Shared>) -> axum::Json<HealthResponse> {
    axum::Json(HealthResponse::clone(&shared.health))
}

/// Stops the daemon once this answer is written: the listeners stop taking connections and finish
/// the ones they have, this one included.
async fn stop(State(shared): State<Shared>) -> axum::Json<StopResponse> {
    shared.stop.now(Reason::Requested);
    axum::Json(StopResponse {})
}

/// What a failure no route expects answers: the error is logged, and the client told nothing of
/// it, as Hono answers one.
fn internal(err: &dyn std::fmt::Display) -> Response {
    tracing::error!("bazhen: {err}");
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

/// Every read model a client draws, with the cursor its event stream resumes from.
async fn state(State(shared): State<Shared>) -> Response {
    let store = shared.store.clone();
    let read = tokio::task::spawn_blocking(move || -> Result<StateSnapshot, SnapshotError> {
        store.reader()?.reads().snapshot()
    })
    .await;
    match read {
        Ok(Ok(snapshot)) => axum::Json(snapshot).into_response(),
        Ok(Err(unported @ SnapshotError::Unported(_))) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            &unported.to_string(),
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
) -> Response {
    let Ok(upgrade) = upgrade else {
        return not_found().await;
    };
    let Some(cursor) = query.ok().and_then(|Query(query)| events::cursor(&query)) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let how = Streaming {
        store: shared.store,
        stop: shared.stop.token().clone(),
        heartbeat: shared.heartbeat,
    };
    upgrade
        .max_message_size(EVENT_FRAME_MAX_BYTES)
        .max_frame_size(EVENT_FRAME_MAX_BYTES)
        .on_upgrade(move |socket| {
            events::stream(socket, cursor, how, held.map(|Extension(held)| held))
        })
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

/// The socket's routes. Stop is here only: over HTTP, anything able to send a request could end
/// the daemon.
pub(crate) fn socket_router(shared: Shared) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/state", get(state))
        .route("/v1/events", get(stream))
        .route("/v1/daemon/stop", post(stop))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(shared)
}

/// The loopback HTTP listener's routes, behind the guard. The API is a router nested at `/v1`,
/// and the pairing gate is on it, so whatever axum routes there, its fallback included, is gated:
/// no test of the path's text can miss one.
pub(crate) fn http_router(shared: Shared, gate: Gate) -> Router {
    let gate = Arc::new(gate);
    let api = Router::new()
        .route("/health", get(health))
        .route("/state", get(state))
        .route("/events", get(stream))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .with_state(shared)
        .layer(middleware::from_fn_with_state(Arc::clone(&gate), pairing));
    // The nest takes `/v1` and `/v1/<rest>` but not `/v1/` itself, which Hono's `/v1/*` gates.
    let bare = any(not_found).layer(middleware::from_fn_with_state(Arc::clone(&gate), pairing));
    Router::new()
        .nest("/v1", api)
        .route("/v1/", bare)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(gate, guarded))
}

/// A header as Node gives it to the TypeScript daemon: every line of it joined with ", ", each
/// byte read as latin1. A value that isn't ASCII is still there, and a line ahead of a proxy's
/// doesn't hide it.
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
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
/// origin it doesn't admit.
async fn guarded(State(gate): State<Arc<Gate>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = header(headers, "host");
    let origin = header(headers, "origin");
    let acting = !is_safe(request.method()) || headers.contains_key("upgrade");
    match guard::refusal(
        &gate.allow,
        Arrival {
            host: host.as_deref(),
            origin: origin.as_deref(),
            acting,
        },
    ) {
        Some(Refusal::HostNotAllowed) => fail(
            StatusCode::MISDIRECTED_REQUEST,
            ErrorCode::HostNotAllowed,
            host.as_deref().unwrap_or_default(),
        ),
        Some(Refusal::OriginNotAllowed) => fail(
            StatusCode::FORBIDDEN,
            ErrorCode::OriginNotAllowed,
            origin.as_deref().unwrap_or_default(),
        ),
        None => next.run(request).await,
    }
}

/// The pairing gate, on the API only: the page holds no secret. A request that must pair needs a
/// paired device, and this daemon pairs none yet, so it refuses every one, pairing itself included:
/// it fails closed rather than let one through. A page elsewhere can't even read.
async fn pairing(State(gate): State<Arc<Gate>>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let required = guard::must_pair(
        gate.pairing_required,
        header(headers, "x-forwarded-for").as_deref(),
        header(headers, "forwarded").as_deref(),
    );
    if let Some(origin) = header(headers, "origin")
        && !gate.allow.origins.contains(&origin)
    {
        if required {
            return fail(StatusCode::FORBIDDEN, ErrorCode::OriginNotAllowed, &origin);
        }
        return next.run(request).await;
    }
    if required {
        return fail(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unpaired,
            "pair this browser: run `bazhen devices pair`",
        );
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
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
                http_router(
                    shared,
                    Gate {
                        allow,
                        pairing_required,
                    },
                )
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
             INSERT INTO environments (id, kind, created_event_id) VALUES ('env_1', 'local', 1);",
            socket_router,
            &[],
        );
        assert_eq!(
            (status, body),
            (
                503,
                refused("unavailable", "this daemon can't describe environments yet")
            )
        );
    }

    fn http(pairing_required: bool) -> Router {
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required,
        };
        http_router(shared(), gate)
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
        let shared = shared();
        let stop = shared.stop.clone();
        let gate = Gate {
            allow: guard::allowlists(7900, None, &[]),
            pairing_required: false,
        };
        let router = http_router(shared, gate);
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

    #[test]
    fn refuses_another_host_with_421_and_an_action_from_another_origin_with_403() {
        let evil = [("host", HOST), ("origin", "https://evil.example")];
        assert_eq!(
            [
                send(
                    http(false),
                    request("GET", "/v1/health", &[("host", "evil.example")])
                ),
                send(http(false), request("GET", "/v1/health", &[])),
                send(http(false), request("POST", "/v1/health", &evil)),
                send(
                    http(false),
                    request(
                        "GET",
                        "/v1/health",
                        &[evil[0], evil[1], ("upgrade", "websocket")]
                    )
                ),
            ],
            [
                (421, refused("host_not_allowed", "evil.example")),
                (421, refused("host_not_allowed", "")),
                (403, refused("origin_not_allowed", "https://evil.example")),
                (403, refused("origin_not_allowed", "https://evil.example")),
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

    /// No device can pair with this daemon yet, so wherever pairing is required every API request
    /// is refused, the pairing endpoint's path included: the gate fails closed.
    #[test]
    fn where_pairing_is_required_refuses_every_api_request_as_unpaired() {
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
                send(http(true), request("POST", "/v1/pairing", &own)),
                send(http(false), request("GET", "/v1/health", &forwarded)),
                send(http(false), request("GET", "/v1/health", &proxied)),
            ],
            [
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired.clone(),
                unpaired
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
}
