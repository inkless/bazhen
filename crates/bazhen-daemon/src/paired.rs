//! Pairing, devices and their notices over the API (`http/app.ts`, `socket/routes.ts`,
//! `attention/notices.ts`): the cookie gate in front of the HTTP API, the exchange of a code for a
//! device, the owner's device routes on the socket, and dismissing a notice.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header::SET_COOKIE};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::{EdgeCheck, Refused, edge, object};
use bazhen_protocol::ids::DeviceId;
use bazhen_protocol::notices::{
    DevicesResponse, DismissNoticeRequest, PairRequest, PairResponse, PairingCodeResponse,
    RevokeDeviceResponse,
};
use bazhen_store::{DismissError, Dismissal, NewDevice, RevokeError, Revoked};
use tokio_util::sync::CancellationToken;

use crate::devices::{self, Holds, Standing, Stored};
use crate::guard;
use crate::pairing::{Attempt, Bucket, PairingCodes, random_bytes};
use crate::routes::{Gate, Shared, fail, header, internal, refuse_upgrade};

/// How often the streams of devices revoked or lapsed since they opened them are closed.
const CLOSE_EVERY: Duration = Duration::from_secs(60);

/// What pairing keeps between requests: the live code and the streams each device holds.
#[derive(Debug, Clone, Default)]
pub(crate) struct Pairing {
    pub(crate) codes: Arc<Mutex<PairingCodes>>,
    pub(crate) holds: Holds,
    /// The external origins a code may be entered at, which `bazhen devices pair` prints.
    pub(crate) origins: Arc<Vec<String>>,
}

/// Who a request is, as the routes that answer per viewer need it: a paired device, the owner
/// on loopback, or the owner on the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Viewer {
    /// A paired device, by the name it was paired with, which views of terminals carry; and
    /// whether it was paired through a forwarder (`ThroughForwarder`).
    Device {
        id: DeviceId,
        name: String,
        required: bool,
        forwarded: bool,
    },
    OwnerLoopback,
}

/// Marks a pairing request as one whose caller is a forwarder's: a loopback TCP caller whose
/// socket no readable process holds, each process that may hold it the human's. Only the caller
/// guard sets it, from how it read the caller, never from anything the request says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ThroughForwarder;

fn now_ms() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

/// Milliseconds since the daemon first asked, on a clock that only runs forward.
fn steady_ms() -> i64 {
    static START: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    i64::try_from(START.elapsed().as_millis()).unwrap_or(i64::MAX)
}

fn iso(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map_or_else(|_| String::new(), |at| format!("{at:.3}"))
}

/// The gate's state: the listener's allowlists and mode, and what every route shares.
#[derive(Debug, Clone)]
pub(crate) struct Gated {
    pub(crate) gate: Arc<Gate>,
    pub(crate) shared: Shared,
}

/// What the store says of the device a token names, read off the writer's thread.
async fn stored(
    shared: &Shared,
    token: &str,
) -> Result<Option<(DeviceId, String, Stored)>, Box<Response>> {
    let store = shared.store.clone();
    let hash = devices::hash_token(token);
    let read =
        tokio::task::spawn_blocking(move || store.reader()?.reads().device_by_token(&hash)).await;
    match read {
        Ok(Ok(found)) => Ok(found.map(|row| {
            (
                row.id,
                row.name,
                Stored {
                    revoked: row.revoked,
                    secure: row.secure,
                    last_seen_ms: row.last_seen_at_ms,
                    forwarded: row.forwarded,
                },
            )
        })),
        Ok(Err(err)) => Err(Box::new(internal(&err))),
        Err(err) => Err(Box::new(internal(&err))),
    }
}

fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

/// The pairing gate, on the API only: the page holds no secret. A request that must pair needs a
/// paired device's cookie. `POST /v1/pairing`, which pairs one, is the one request it lets by. A
/// device that stands is the request's [`Viewer`], whether or not it had to pair; where its use is
/// recorded, its cookie is set again to restart its lifetime.
pub(crate) async fn gate(State(gated): State<Gated>, mut request: Request, next: Next) -> Response {
    // The API is nested at `/v1`, so the path here is the rest of it.
    if request.method() == Method::POST && request.uri().path() == "/pairing" {
        return next.run(request).await;
    }
    let headers = request.headers();
    let (x_forwarded_for, forwarded_by) = (
        header(headers, "x-forwarded-for"),
        header(headers, "forwarded"),
    );
    let forwarded =
        guard::forwarded_from_elsewhere(x_forwarded_for.as_deref(), forwarded_by.as_deref());
    let required = guard::must_pair(
        gated.gate.pairing_required,
        x_forwarded_for.as_deref(),
        forwarded_by.as_deref(),
    );
    let origin = header(headers, "origin");
    let upgrade = headers.contains_key("upgrade");
    if let Some(origin) = &origin
        && !gated.gate.allow.origins.contains(origin)
    {
        if required {
            return refused_origin(upgrade, origin);
        }
        request.extensions_mut().insert(Viewer::OwnerLoopback);
        return next.run(request).await;
    }
    let remote = forwarded || origin.as_deref().is_some_and(|o| o.starts_with("https:"));
    // A browser sends `Sec-Fetch-Site` with each request; only one from the page itself can be
    // given the cookie again, and an upgrade can't be given one at all.
    let touch =
        !upgrade && header(headers, "sec-fetch-site").is_none_or(|site| site == "same-origin");
    let presented = devices::token_from(devices::cookie_header(headers).as_deref())
        .filter(|p| devices::well_formed(&p.token));
    let mut verified = None;
    if let Some(presented) = &presented {
        let found = match stored(&gated.shared, &presented.token).await {
            Ok(found) => found,
            Err(response) => return *response,
        };
        let now = now_ms();
        let standing = devices::standing(
            found.as_ref().map(|(_, _, s)| s),
            presented.secure,
            remote,
            touch,
            now,
        );
        if let (Some((id, name, stored)), Standing::Stands | Standing::Touch) = (found, standing) {
            verified = Some((id, name, standing == Standing::Touch, stored.forwarded));
        }
    }
    if required && verified.is_none() {
        if upgrade {
            return refuse_upgrade(StatusCode::UNAUTHORIZED);
        }
        return fail(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unpaired,
            "pair this browser: run `bazhen devices pair`",
        );
    }
    if required && origin.is_none() && (upgrade || !is_safe(request.method())) {
        return refused_origin(upgrade, "");
    }
    let refresh = match &verified {
        Some((id, _, true, _)) => {
            let id = id.clone();
            match gated
                .shared
                .store
                .run(move |store| store.touch_device(&id))
                .await
            {
                Ok(Ok(())) => presented.as_ref(),
                Ok(Err(err)) => return internal(&err),
                Err(err) => return internal(&err),
            }
        }
        _ => None,
    };
    let viewer = verified.map_or(Viewer::OwnerLoopback, |(id, name, _, forwarded)| {
        Viewer::Device {
            id,
            name,
            required,
            forwarded,
        }
    });
    request.extensions_mut().insert(viewer);
    let mut response = next.run(request).await;
    if let Some(presented) = refresh
        && let Ok(cookie) =
            HeaderValue::from_str(&devices::device_cookie(&presented.token, presented.secure))
    {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    response
}

fn refused_origin(upgrade: bool, origin: &str) -> Response {
    if upgrade {
        return refuse_upgrade(StatusCode::FORBIDDEN);
    }
    fail(StatusCode::FORBIDDEN, ErrorCode::OriginNotAllowed, origin)
}

/// A code to pair a browser with, replacing any earlier one.
pub(crate) async fn issue(State(shared): State<Shared>) -> Response {
    let issued = shared
        .pairing
        .codes
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .issue(steady_ms());
    match issued {
        Ok(code) => Json(PairingCodeResponse {
            code,
            expires_at: iso(now_ms() + crate::pairing::CODE_LIFETIME_MS),
            origins: shared.pairing.origins.to_vec(),
            lan: None,
        })
        .into_response(),
        Err(err) => internal(&err),
    }
}

/// A pairing code traded for a device and the cookie that carries its token.
pub(crate) async fn pair(State(shared): State<Shared>, request: Request) -> Response {
    let Some(origin) = header(request.headers(), "origin") else {
        return fail(StatusCode::FORBIDDEN, ErrorCode::OriginNotAllowed, "");
    };
    let forwarded = request.extensions().get::<ThroughForwarder>().is_some();
    let Ok(body) = axum::body::to_bytes(request.into_body(), 64 * 1024).await else {
        return fail(
            StatusCode::BAD_REQUEST,
            ErrorCode::InvalidRequest,
            "the body can't be read",
        );
    };
    let PairRequest { code, name } = match edge::<PairRequest>(&body) {
        Ok(asked) => asked,
        Err(Refused(rule)) => {
            return fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &rule);
        }
    };
    let attempt = shared
        .pairing
        .codes
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .attempt(&code, &origin, Bucket::Loopback, steady_ms());
    match attempt {
        Attempt::RateLimited {
            retry_after_seconds,
        } => {
            let mut response = fail(
                StatusCode::TOO_MANY_REQUESTS,
                ErrorCode::RateLimited,
                "too many attempts; wait a minute",
            );
            response
                .headers_mut()
                .insert("retry-after", HeaderValue::from(retry_after_seconds));
            response
        }
        Attempt::Failed => fail(
            StatusCode::UNAUTHORIZED,
            ErrorCode::PairingFailed,
            "that code is wrong or has expired",
        ),
        Attempt::Paired => paired(&shared, name.as_deref(), &origin, forwarded).await,
    }
}

/// Records a device for a code that matched, and hands its token to the browser, once: one paired
/// through a forwarder, when `forwarded`.
async fn paired(
    shared: &Shared,
    requested: Option<&str>,
    origin: &str,
    forwarded: bool,
) -> Response {
    let token = match random_bytes::<32>() {
        Ok(random) => devices::token_of(random),
        Err(err) => return internal(&err),
    };
    let secure = origin.starts_with("https:");
    let device = NewDevice {
        name: devices::device_name(requested),
        token_hash: devices::hash_token(&token),
        secure,
        origin: origin.to_owned(),
        // Only a LAN listener knows the peer's address, and this daemon serves none.
        address: None,
        forwarded,
    };
    let made = match shared
        .store
        .run(move |store| store.pair_device(&device))
        .await
    {
        Ok(Ok(made)) => made,
        Ok(Err(err)) => return internal(&err),
        Err(err) => return internal(&err),
    };
    tracing::info!(
        "bazhen: paired a device, {} ({})",
        serde_json::Value::from(made.name.as_str()),
        made.device_id
    );
    let mut response = Json(PairResponse {
        device_id: made.device_id,
        name: made.name,
    })
    .into_response();
    if let Ok(cookie) = HeaderValue::from_str(&devices::device_cookie(&token, secure)) {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    response
}

/// The devices still paired, each with when it lapses unless used.
pub(crate) async fn list(State(shared): State<Shared>) -> Response {
    let store = shared.store.clone();
    let read = tokio::task::spawn_blocking(move || store.reader()?.reads().devices()).await;
    match read {
        Ok(Ok(devices)) => Json(DevicesResponse { devices }).into_response(),
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

/// Revokes a device and closes every stream it holds, so it can't keep watching.
pub(crate) async fn revoke(State(shared): State<Shared>, Path(id): Path<String>) -> Response {
    let revoking = id.clone();
    match shared
        .store
        .run(move |store| store.revoke_device(&revoking))
        .await
    {
        Ok(Ok(Revoked::Now | Revoked::Already)) => {
            shared.pairing.holds.revoke(&id);
            tracing::info!("bazhen: revoked device {id}");
            Json(RevokeDeviceResponse {}).into_response()
        }
        Ok(Err(err @ RevokeError::Unknown(_))) => {
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &err.to_string())
        }
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

/// Closes a notice for its viewer. Over the socket the owner may name the paired device it acts
/// from, in `Bazhen-Device-Id`.
pub(crate) async fn dismiss(
    State(shared): State<Shared>,
    Path(notice): Path<String>,
    viewer: Option<Extension<Viewer>>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(asked) = object::<DismissNoticeRequest>(&body) else {
        return fail(
            StatusCode::BAD_REQUEST,
            ErrorCode::InvalidRequest,
            "the body must carry an idempotencyKey",
        );
    };
    let asked = match asked.checked() {
        Ok(asked) => asked,
        Err(Refused(rule)) => {
            return fail(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, &rule);
        }
    };
    let (by, named) = match viewer.map(|Extension(v)| v) {
        Some(Viewer::Device { id, .. }) => (bazhen_store::Viewer::Device(id), None),
        Some(Viewer::OwnerLoopback) => (bazhen_store::Viewer::OwnerLoopback, None),
        // No gate ran, so this came over the socket.
        None => (
            bazhen_store::Viewer::OwnerSocket,
            header(&headers, "bazhen-device-id"),
        ),
    };
    let key = asked.idempotency_key;
    let answer = shared
        .store
        .run(move |store| {
            store.dismiss_notice(&Dismissal {
                notice,
                key,
                by,
                // The store records it only if that device was ever paired.
                from_device: named.as_deref().and_then(DeviceId::parse),
            })
        })
        .await;
    match answer {
        Ok(Ok(dismissed)) => Json(dismissed).into_response(),
        Ok(Err(err @ (DismissError::NotOpen(_) | DismissError::ByDevice(_)))) => {
            fail(StatusCode::CONFLICT, ErrorCode::Conflict, &err.to_string())
        }
        Ok(Err(DismissError::Once(bazhen_store::OnceError::Conflict(key)))) => fail(
            StatusCode::CONFLICT,
            ErrorCode::Conflict,
            &format!("idempotency key {key} was first used for a different request"),
        ),
        Ok(Err(err)) => internal(&err),
        Err(err) => internal(&err),
    }
}

/// Every minute until `stop`, closes the streams of each device revoked since it opened them, and
/// of each lapsed one the streams it had to pair to open.
pub(crate) async fn close_lapsed_every_minute(shared: Shared, stop: CancellationToken) {
    let mut ticks = tokio::time::interval(CLOSE_EVERY);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticks.tick().await;
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            _ = ticks.tick() => close_lapsed(&shared).await,
        }
    }
}

async fn close_lapsed(shared: &Shared) {
    let holding = shared.pairing.holds.devices();
    if holding.is_empty() {
        return;
    }
    let store = shared.store.clone();
    let read = tokio::task::spawn_blocking(move || store.reader()?.reads().devices()).await;
    let Ok(Ok(live)) = read else {
        tracing::warn!("bazhen: can't read the paired devices to close their lapsed streams");
        return;
    };
    let now = now_ms();
    for id in holding {
        match live.iter().find(|d| d.id.as_str() == id) {
            None => shared.pairing.holds.revoke(&id),
            Some(device) => {
                let lapses = device.expires_at.parse::<jiff::Timestamp>().ok();
                if lapses.is_some_and(|at| now >= at.as_millisecond()) {
                    shared.pairing.holds.end_required(&id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::Router;
    use axum::body::Body;
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use crate::routes::{Stop, http_router, socket_router};

    const HOST: &str = "127.0.0.1:7900";
    const OWN: &str = "http://127.0.0.1:7900";

    /// The socket's router and an HTTP one that requires pairing, over one store of their own.
    struct Daemon {
        socket: Router,
        http: Router,
        /// The HTTP router as a caller through a forwarder, such as `ssh -L`, reaches it.
        forwarder: Router,
        shared: Shared,
        path: std::path::PathBuf,
        thread: Option<crate::writer::Thread>,
        _dir: crate::testing::TempDir,
    }

    impl Drop for Daemon {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.finish();
            }
        }
    }

    fn over_a_store(pairing_required: bool) -> Daemon {
        admitting(pairing_required, &[])
    }

    /// The same, admitting `external` origins too.
    fn admitting(pairing_required: bool, external: &[String]) -> Daemon {
        let dir = crate::testing::TempDir::new("paired");
        let path = dir.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let shared = Shared::new("f".repeat(64).as_str(), Stop::default(), store);
        let gate = Gate {
            allow: guard::allowlists(7900, None, external),
            pairing_required,
        };
        let forwarded = Shared {
            peers: crate::peer::through_a_forwarder(),
            ..shared.clone()
        };
        Daemon {
            socket: socket_router(shared.clone()),
            forwarder: crate::testing::from_port_1000(http_router(forwarded, gate.clone())),
            http: crate::testing::connected(http_router(shared.clone(), gate)),
            shared,
            path,
            thread: Some(thread),
            _dir: dir,
        }
    }

    /// What a request was answered: its status, its `Set-Cookie`, `Retry-After` and `Connection`,
    /// and its body.
    #[derive(Debug, PartialEq)]
    struct Answer {
        status: u16,
        cookie: Option<String>,
        retry_after: Option<String>,
        connection: Option<String>,
        body: Value,
    }

    fn send(
        router: &Router,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Answer {
        let mut request = axum::http::Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let body = body.map_or_else(Body::empty, |b| Body::from(serde_json::to_vec(&b).unwrap()));
        let request = request.body(body).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let response = router.clone().oneshot(request).await.unwrap();
            let text = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .map(|v| v.to_str().unwrap().to_owned())
            };
            let (cookie, retry_after, connection) =
                (text("set-cookie"), text("retry-after"), text("connection"));
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            let body = serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
            Answer {
                status,
                cookie,
                retry_after,
                connection,
                body,
            }
        })
    }

    impl Daemon {
        fn code(&self) -> String {
            let issued = send(&self.socket, "POST", "/v1/pairing/codes", &[], None);
            issued.body["code"].as_str().unwrap().to_owned()
        }

        fn pair(&self, code: &str, origin: &str) -> Answer {
            send(
                &self.http,
                "POST",
                "/v1/pairing",
                &[("host", HOST), ("origin", origin)],
                Some(json!({"code": code, "name": "Phone"})),
            )
        }

        /// The cookie a fresh pairing sets, as a browser sends it back, and the device's id.
        fn paired(&self) -> (String, String) {
            let paired = self.pair(&self.code(), OWN);
            let cookie = paired.cookie.unwrap();
            let sent = cookie.split(';').next().unwrap().to_owned();
            (sent, paired.body["deviceId"].as_str().unwrap().to_owned())
        }

        fn get(&self, path: &str, headers: &[(&str, &str)]) -> Answer {
            let mut all = vec![("host", HOST)];
            all.extend_from_slice(headers);
            send(&self.http, "GET", path, &all, None)
        }
    }

    fn unpaired() -> Value {
        json!({"error": "unpaired", "message": "pair this browser: run `bazhen devices pair`"})
    }

    #[test]
    fn trades_a_code_once_for_a_device_whose_cookie_the_gate_then_lets_by() {
        let daemon = over_a_store(true);
        let code = daemon.code();
        let first = daemon.pair(&code, OWN);
        let again = daemon.pair(&code, OWN);
        let cookie = first.cookie.clone().unwrap();
        let sent = cookie.split(';').next().unwrap();
        assert_eq!(
            (
                first.status,
                &first.body["name"],
                first.body["deviceId"]
                    .as_str()
                    .map(|id| id.starts_with("dev_")),
                cookie
                    .strip_prefix("bazhen_device=")
                    .and_then(|rest| rest.split(';').next())
                    .map(devices::well_formed),
                cookie.ends_with("; Path=/v1; Max-Age=86400; HttpOnly; SameSite=Strict"),
                (again.status, again.body),
                daemon.get("/v1/state", &[("cookie", sent)]).status,
                daemon.get("/v1/state", &[]).body,
            ),
            (
                200,
                &json!("Phone"),
                Some(true),
                Some(true),
                true,
                (
                    401,
                    json!({"error": "pairing_failed", "message": "that code is wrong or has expired"})
                ),
                200,
                unpaired(),
            )
        );
    }

    /// A caller whose socket no readable process holds, each that may hold it the human's, as a
    /// browser's through `ssh -L` is, is the human only with the cookie of a device paired the
    /// same way: not with none, not with one paired on the host, and not with one whose pairing
    /// only said, in its headers, that it came through a proxy.
    #[test]
    fn lets_a_caller_through_a_forwarder_by_only_with_a_device_paired_through_one() {
        let daemon = over_a_store(false);
        let pair = |router: &Router, headers: &[(&str, &str)]| {
            let mut all = vec![("host", HOST), ("origin", OWN)];
            all.extend_from_slice(headers);
            let paired = send(
                router,
                "POST",
                "/v1/pairing",
                &all,
                Some(json!({"code": daemon.code(), "name": "Phone"})),
            );
            let cookie = paired.cookie.unwrap();
            cookie.split(';').next().unwrap().to_owned()
        };
        let through = pair(&daemon.forwarder, &[]);
        let on_the_host = pair(&daemon.http, &[]);
        let said = pair(
            &daemon.http,
            &[
                ("x-forwarded-for", "127.0.0.1"),
                ("forwarded", "for=127.0.0.1"),
            ],
        );
        let state = |cookie: Option<&str>| {
            let mut headers = vec![("host", HOST)];
            headers.extend(cookie.map(|c| ("cookie", c)));
            let answer = send(&daemon.forwarder, "GET", "/v1/state", &headers, None);
            (answer.status, answer.body["message"].clone())
        };
        let refused = (403, json!(crate::callers::UNHELD));
        assert_eq!(
            [
                state(Some(&through)),
                state(None),
                state(Some(&on_the_host)),
                state(Some(&said)),
            ],
            [
                (200, Value::Null),
                refused.clone(),
                refused.clone(),
                refused
            ]
        );
    }

    #[test]
    fn refuses_a_pairing_naming_the_rule_it_breaks_and_counts_each_bound_in_code_points() {
        let daemon = over_a_store(true);
        let ask = |body: Value| {
            let answer = send(
                &daemon.http,
                "POST",
                "/v1/pairing",
                &[("host", HOST), ("origin", OWN)],
                Some(body),
            );
            (answer.status, answer.body)
        };
        let invalid =
            |message: &str| (400, json!({"error": "invalid_request", "message": message}));
        let emoji = |n: usize| "\u{1f600}".repeat(n);
        assert_eq!(
            [
                ask(json!({"code": emoji(32), "name": emoji(64)})),
                ask(json!({"code": emoji(33)})),
                ask(json!({"code": "c", "name": emoji(65)})),
                ask(json!({"code": "c", "name": null})),
                ask(json!({"name": "n"})),
                ask(json!({"code": 5})),
                ask(json!(["c"])),
            ],
            [
                (
                    401,
                    json!({"error": "pairing_failed", "message": "that code is wrong or has expired"})
                ),
                invalid("code is at most 32 characters"),
                invalid("name is at most 64 characters"),
                invalid("invalid type: null, expected a string at line 1 column 23"),
                invalid("missing field `code` at line 1 column 12"),
                invalid("invalid type: integer `5`, expected a string at line 1 column 9"),
                invalid("the body is not a JSON object"),
            ]
        );
    }

    #[test]
    fn refuses_a_dismissal_whose_key_is_past_its_bound_or_that_is_no_object() {
        let daemon = over_a_store(true);
        let dismiss = |body: Value| {
            let answer = send(
                &daemon.socket,
                "POST",
                "/v1/notices/notice_1/dismiss",
                &[],
                Some(body),
            );
            (answer.status, answer.body)
        };
        let invalid =
            |message: &str| (400, json!({"error": "invalid_request", "message": message}));
        // No notice is open, so a key the edge takes reaches the store, which answers a conflict.
        assert_eq!(
            [
                dismiss(json!({"idempotencyKey": "\u{1f600}".repeat(200)})).1["error"].clone(),
                dismiss(json!({"idempotencyKey": "\u{1f600}".repeat(201)})).1["error"].clone(),
            ],
            [json!("conflict"), json!("invalid_request")]
        );
        assert_eq!(
            [
                dismiss(json!({"idempotencyKey": "k".repeat(201)})),
                dismiss(json!({"idempotencyKey": ""})),
                dismiss(json!(["k"])),
            ],
            [
                invalid("idempotencyKey is 1 to 200 characters"),
                invalid("idempotencyKey is 1 to 200 characters"),
                invalid("the body must carry an idempotencyKey"),
            ]
        );
    }

    #[test]
    fn pairs_over_https_with_the_host_cookie_and_needs_an_origin() {
        let daemon = admitting(true, &["https://bazhen.example.com".to_owned()]);
        let https = daemon.pair(&daemon.code(), "https://bazhen.example.com");
        let no_origin = send(
            &daemon.http,
            "POST",
            "/v1/pairing",
            &[("host", HOST)],
            Some(json!({"code": daemon.code()})),
        );
        assert_eq!(
            (
                https
                    .cookie
                    .as_deref()
                    .map(|c| c.starts_with("__Host-bazhen_device=")
                        && c.ends_with(
                            "; Secure; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict"
                        )),
                (no_origin.status, no_origin.body),
            ),
            (
                Some(true),
                (403, json!({"error": "origin_not_allowed", "message": ""}))
            )
        );
    }

    #[test]
    fn opens_a_notice_of_the_pairing_that_only_the_owner_may_dismiss() {
        let daemon = over_a_store(true);
        let (cookie, device) = daemon.paired();
        let owner = send(&daemon.socket, "GET", "/v1/state", &[], None);
        let seen = daemon.get("/v1/state", &[("cookie", &cookie)]);
        let notice = owner.body["notices"][0]["id"].as_str().unwrap().to_owned();
        let path = format!("/v1/notices/{notice}/dismiss");
        let by_device = send(
            &daemon.http,
            "POST",
            &path,
            &[("host", HOST), ("origin", OWN), ("cookie", &cookie)],
            Some(json!({"idempotencyKey": "k1"})),
        );
        let dismissed = send(
            &daemon.socket,
            "POST",
            &path,
            &[],
            Some(json!({"idempotencyKey": "k2"})),
        );
        let replayed = send(
            &daemon.socket,
            "POST",
            &path,
            &[],
            Some(json!({"idempotencyKey": "k2"})),
        );
        let after = send(&daemon.socket, "GET", "/v1/state", &[], None);
        assert_eq!(
            (
                &owner.body["notices"][0]["device"]["id"],
                &owner.body["notices"][0]["actions"],
                &seen.body["notices"][0]["actions"],
                (by_device.status, by_device.body),
                dismissed.status,
                replayed.body == dismissed.body,
                &after.body["notices"][0]["state"],
            ),
            (
                &json!(device),
                &json!(["dismiss"]),
                &json!([]),
                (
                    409,
                    json!({
                        "error": "conflict",
                        "message": format!("notice {notice} can't be answered with dismiss by this device")
                    })
                ),
                200,
                true,
                &json!("closed"),
            )
        );
    }

    #[test]
    fn revokes_a_device_so_its_cookie_no_longer_passes_and_lists_it_no_more() {
        let daemon = over_a_store(true);
        let (cookie, device) = daemon.paired();
        let listed = send(&daemon.socket, "GET", "/v1/devices", &[], None);
        let revoked = send(
            &daemon.socket,
            "POST",
            &format!("/v1/devices/{device}/revoke"),
            &[],
            None,
        );
        let unknown = send(
            &daemon.socket,
            "POST",
            "/v1/devices/dev_nobody/revoke",
            &[],
            None,
        );
        assert_eq!(
            (
                listed.body["devices"].as_array().map(Vec::len),
                (revoked.status, revoked.body),
                daemon.get("/v1/state", &[("cookie", &cookie)]).body,
                send(&daemon.socket, "GET", "/v1/devices", &[], None).body,
                (unknown.status, unknown.body),
            ),
            (
                Some(1),
                (200, json!({})),
                unpaired(),
                json!({"devices": []}),
                (
                    404,
                    json!({"error": "not_found", "message": "no device dev_nobody"})
                ),
            )
        );
    }

    #[test]
    fn tells_a_client_past_its_attempts_when_to_try_again() {
        let daemon = over_a_store(true);
        let code = daemon.code();
        for _ in 0..5 {
            daemon.pair("WRONGONE", OWN);
        }
        let limited = daemon.pair(&code, OWN);
        assert_eq!(
            (limited.status, limited.retry_after.is_some(), limited.body),
            (
                429,
                true,
                json!({"error": "rate_limited", "message": "too many attempts; wait a minute"})
            )
        );
    }

    #[test]
    fn refuses_a_paired_write_that_names_no_origin_where_pairing_is_required() {
        let daemon = over_a_store(true);
        let (cookie, _) = daemon.paired();
        let task = json!({"idempotencyKey": "t1", "title": "A task", "brief": "b"});
        let write = |origin: Option<&str>| {
            let mut headers = vec![("host", HOST), ("cookie", cookie.as_str())];
            headers.extend(origin.map(|o| ("origin", o)));
            send(
                &daemon.http,
                "POST",
                "/v1/tasks",
                &headers,
                Some(task.clone()),
            )
            .status
        };
        assert_eq!(
            (
                write(None),
                write(Some(OWN)),
                over_a_store(false).get("/v1/health", &[]).status
            ),
            (403, 200, 200)
        );
    }

    /// A paired device's upgrade that names no origin is told 403 alone, as the TypeScript daemon
    /// refuses it; the same request that doesn't upgrade reads as it did, and a write that names
    /// no origin is still told why.
    #[test]
    fn refuses_a_paired_upgrade_that_names_no_origin_with_403_alone() {
        let daemon = over_a_store(true);
        let (cookie, _) = daemon.paired();
        let seen = |answer: Answer| (answer.status, answer.connection, answer.body);
        let paired = [("cookie", cookie.as_str())];
        assert_eq!(
            [
                seen(daemon.get("/v1/events", &[paired[0], ("upgrade", "websocket")])),
                seen(daemon.get("/v1/events", &paired)),
                seen(send(
                    &daemon.http,
                    "POST",
                    "/v1/tasks",
                    &[("host", HOST), paired[0]],
                    Some(json!({"idempotencyKey": "t1", "title": "A task", "brief": "b"})),
                )),
            ],
            [
                (403, Some("close".to_owned()), json!("")),
                (404, None, json!("404 Not Found")),
                (
                    403,
                    None,
                    json!({"error": "origin_not_allowed", "message": ""})
                ),
            ]
        );
    }

    #[test]
    fn sets_the_cookie_again_an_hour_on_only_for_the_page_itself() {
        let daemon = over_a_store(true);
        let (cookie, device) = daemon.paired();
        let fresh = daemon.get("/v1/state", &[("cookie", &cookie)]);
        rusqlite::Connection::open(&daemon.path)
            .unwrap()
            .execute(
                "UPDATE devices SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
                [&device],
            )
            .unwrap();
        // Long idle on loopback has lapsed it; an hour and a bit hasn't.
        let lapsed = daemon.get("/v1/state", &[("cookie", &cookie)]);
        let hour_ago = format!(
            "{:.3}",
            jiff::Timestamp::now() - jiff::SignedDuration::from_mins(61)
        );
        rusqlite::Connection::open(&daemon.path)
            .unwrap()
            .execute(
                "UPDATE devices SET last_seen_at = ? WHERE id = ?",
                [&hour_ago, &device],
            )
            .unwrap();
        let cross = daemon.get(
            "/v1/state",
            &[("cookie", &cookie), ("sec-fetch-site", "cross-site")],
        );
        let own = daemon.get(
            "/v1/state",
            &[("cookie", &cookie), ("sec-fetch-site", "same-origin")],
        );
        let then = daemon.get("/v1/state", &[("cookie", &cookie)]);
        assert_eq!(
            (
                fresh.cookie,
                lapsed.status,
                (cross.status, cross.cookie),
                own.cookie.map(|c| c.starts_with(&format!("{cookie};"))),
                then.cookie,
            ),
            (None, 401, (200, None), Some(true), None)
        );
    }

    /// Lets `device` lapse: last seen long ago, over loopback.
    fn lapse(daemon: &Daemon, device: &str) {
        rusqlite::Connection::open(&daemon.path)
            .unwrap()
            .execute(
                "UPDATE devices SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
                [device],
            )
            .unwrap();
    }

    type Client = tungstenite::WebSocket<std::net::TcpStream>;

    /// The daemon's HTTP API served on a port of its own, until dropped.
    struct Listening {
        address: std::net::SocketAddr,
        stop: CancellationToken,
        runtime: tokio::runtime::Runtime,
    }

    impl Drop for Listening {
        fn drop(&mut self) {
            self.stop.cancel();
        }
    }

    fn listen(daemon: &Daemon, pairing_required: bool) -> Listening {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let address = listener.local_addr().unwrap();
        let gate = Gate {
            allow: guard::allowlists(address.port(), None, &[]),
            pairing_required,
        };
        let stop = CancellationToken::new();
        runtime.spawn(crate::accept::serve_on(
            listener,
            crate::testing::connected(http_router(daemon.shared.clone(), gate)),
            crate::accept::HTTP,
            stop.clone(),
            tokio_util::task::TaskTracker::new(),
            || {},
        ));
        Listening {
            address,
            stop,
            runtime,
        }
    }

    impl Listening {
        /// The event stream a page holding `cookie` opens.
        fn watch(&self, daemon: &Daemon, cookie: &str) -> Client {
            use tungstenite::client::IntoClientRequest as _;
            let epoch = daemon
                .shared
                .store
                .reader()
                .unwrap()
                .reads()
                .epoch()
                .unwrap();
            let url = format!("ws://{}/v1/events?epoch={epoch}&after=0", self.address);
            let mut request = url.into_client_request().unwrap();
            let origin = format!("http://{}", self.address);
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            request
                .headers_mut()
                .insert("cookie", cookie.parse().unwrap());
            let tcp = std::net::TcpStream::connect(self.address).unwrap();
            tungstenite::client(request, tcp).unwrap().0
        }
    }

    /// The code of the close frame `ws` is sent within `wait`, skipping every other frame;
    /// `None` if it stays open.
    fn closed_with(ws: &mut Client, wait: Duration) -> Option<u16> {
        ws.get_ref().set_read_timeout(Some(wait)).unwrap();
        loop {
            match ws.read() {
                Ok(tungstenite::Message::Close(frame)) => {
                    return Some(frame.map_or(1005, |f| u16::from(f.code)));
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
    }

    const HEARD: Duration = Duration::from_secs(5);
    const QUIET: Duration = Duration::from_millis(300);

    #[test]
    fn ends_a_revoked_devices_streams_as_a_policy_close() {
        let daemon = over_a_store(true);
        let (cookie, device) = daemon.paired();
        let (other, _) = daemon.paired();
        let listening = listen(&daemon, true);
        let mut revoked = listening.watch(&daemon, &cookie);
        let mut kept = listening.watch(&daemon, &other);
        let open = closed_with(&mut revoked, QUIET);
        send(
            &daemon.socket,
            "POST",
            &format!("/v1/devices/{device}/revoke"),
            &[],
            None,
        );
        assert_eq!(
            (
                open,
                closed_with(&mut revoked, HEARD),
                closed_with(&mut kept, QUIET),
            ),
            (None, Some(1008), None)
        );
    }

    #[test]
    fn ends_a_lapsed_devices_streams_that_had_to_pair_and_keeps_those_that_needn_t() {
        let daemon = over_a_store(true);
        let (cookie, device) = daemon.paired();
        let (required, free) = (listen(&daemon, true), listen(&daemon, false));
        let mut needed = required.watch(&daemon, &cookie);
        let mut kept = free.watch(&daemon, &cookie);
        required.runtime.block_on(close_lapsed(&daemon.shared));
        let fresh = closed_with(&mut needed, QUIET);
        lapse(&daemon, &device);
        required.runtime.block_on(close_lapsed(&daemon.shared));
        assert_eq!(
            (
                fresh,
                closed_with(&mut needed, HEARD),
                closed_with(&mut kept, QUIET)
            ),
            (None, Some(1008), None)
        );
    }

    #[test]
    fn looks_for_lapsed_devices_a_minute_on_and_stops_when_told() {
        let daemon = over_a_store(true);
        let (_, device) = daemon.paired();
        lapse(&daemon, &device);
        let streams = CancellationToken::new();
        let hold = daemon.shared.pairing.holds.hold(&device, &streams, true);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap();
        // A blocking task holds paused time still, so each wait here lets the loop catch up.
        let settle =
            || tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(20)));
        let stop = CancellationToken::new();
        let tasks = tokio_util::task::TaskTracker::new();
        let seen = runtime.block_on(async {
            let looking = tasks.spawn(close_lapsed_every_minute(
                daemon.shared.clone(),
                stop.clone(),
            ));
            tokio::time::sleep(CLOSE_EVERY.saturating_sub(Duration::from_secs(1))).await;
            settle().await.unwrap();
            let early = hold.token().is_cancelled();
            tokio::time::sleep(Duration::from_secs(2)).await;
            for _ in 0..100 {
                if hold.token().is_cancelled() {
                    break;
                }
                settle().await.unwrap();
            }
            stop.cancel();
            let stopped = tokio::time::timeout(Duration::from_secs(1), looking)
                .await
                .is_ok();
            (early, hold.token().is_cancelled(), stopped)
        });
        assert_eq!(seen, (false, true, true));
    }
}
