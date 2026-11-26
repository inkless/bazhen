use std::sync::atomic::{AtomicUsize, Ordering};

use bazhen_protocol::mail_events::{MailUndeliverable, UndeliverableReason};
use bazhen_store::{AppendError, MailChange};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::*;
use crate::accept::Limits;
use crate::guard;
use crate::routes::{Gate, Stop};
use crate::testing::TempDir;
use crate::writer::Thread;

const AGENT: &str = "agent_01900000000070008000000000000001";
const ENV: &str = "env_01900000000070008000000000000009";
const DEVICE: &str = "dev_01900000000070008000000000000003";

fn agent() -> AgentId {
    AgentId::parse(AGENT).unwrap()
}

fn device() -> Waiter {
    Waiter::Device(serde_json::from_value(json!(DEVICE)).unwrap())
}

/// How many waits are held: on the socket, on HTTP, and by how many callers.
fn held(waits: &Waits) -> (usize, usize, usize) {
    let count = waits.0.held.lock().unwrap();
    (count.socket, count.http, count.callers.len())
}

#[test]
fn holds_waits_on_half_each_listeners_connections_and_a_refused_one_takes_no_place() {
    let waits = Waits::new(64, 16);
    let callers: Vec<Waiter> = (0..8)
        .map(|n| {
            let id = format!("agent_0190000000007000800000000000001{n}");
            Waiter::Agent(AgentId::parse(&id).unwrap())
        })
        .collect();
    let mut slots: Vec<Slot> = callers
        .iter()
        .map(|holder| waits.enter(On::Http, holder.clone()).unwrap())
        .collect();
    assert_eq!(
        waits.enter(On::Http, Waiter::Owner).err(),
        Some(Crowded::Listener)
    );
    assert_eq!(
        waits.enter(On::Http, device()).err(),
        Some(Crowded::Listener)
    );
    assert_eq!(held(&waits), (0, 8, 8));
    // The socket's waits are its own.
    let on_the_socket = waits.enter(On::Socket, Waiter::Owner).unwrap();
    assert_eq!(held(&waits), (1, 8, 9));
    drop(on_the_socket);
    slots.pop();
    let again = waits.enter(On::Http, Waiter::Owner).unwrap();
    assert_eq!(
        waits.enter(On::Http, device()).err(),
        Some(Crowded::Listener)
    );
    assert_eq!(held(&waits), (0, 8, 8));
    drop((slots, again));
    assert_eq!(held(&waits), (0, 0, 0));
}

#[test]
fn refuses_a_callers_wait_past_its_cap_naming_only_that_caller() {
    let waits = Waits::new(crate::accept::SOCKET_MAX, 128);
    let mut owners: Vec<Slot> = (0..64)
        .map(|_| waits.enter(On::Socket, Waiter::Owner).unwrap())
        .collect();
    let refused = waits.enter(On::Socket, Waiter::Owner).err();
    assert_eq!(
        refused.map(|c| c.to_string()).as_deref(),
        Some("you already hold 64 waits, as many as one caller may; let one end first")
    );
    // Another caller's waits are counted apart, on either listener.
    let agents: Vec<Slot> = (0..64)
        .map(|n| {
            let on = if n % 2 == 0 { On::Socket } else { On::Http };
            waits.enter(on, Waiter::Agent(agent())).unwrap()
        })
        .collect();
    assert_eq!(
        waits
            .enter(On::Http, Waiter::Agent(agent()))
            .err()
            .map(|c| c.to_string()),
        Some(format!(
            "{AGENT} already holds 64 waits, as many as one caller may; let one end first"
        ))
    );
    let by_a_device = waits.enter(On::Http, device()).unwrap();
    // A wait ended makes room for the owner's next.
    owners.pop();
    owners.push(waits.enter(On::Socket, Waiter::Owner).unwrap());
    assert!(
        waits.enter(On::Socket, Waiter::Owner).is_err(),
        "a 65th wait"
    );
    drop((owners, agents, by_a_device));
    assert_eq!(held(&waits), (0, 0, 0));
}

#[test]
fn lets_a_caller_hold_at_most_a_quarter_of_the_sockets_waits() {
    let waits = Waits::new(64, 128);
    let slots: Vec<Slot> = (0..8)
        .map(|_| waits.enter(On::Http, Waiter::Owner).unwrap())
        .collect();
    assert!(matches!(
        waits.enter(On::Http, Waiter::Owner),
        Err(Crowded::Caller { held: 8, .. })
    ));
    drop(slots);
}

/// A commit watch the test commits to by hand.
fn commits() -> (watch::Sender<u64>, watch::Receiver<u64>) {
    watch::channel(0)
}

#[test]
fn judges_again_after_a_commit_that_lands_while_the_first_judgement_is_made() {
    crate::testing::paused().block_on(async {
        let (commit, committed) = commits();
        let calls = AtomicUsize::new(0);
        let started = Instant::now();
        let judge = || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                commit.send_replace(1);
            }
            std::future::ready(Ok::<_, ()>(Judged {
                done: call > 0,
                value: call,
            }))
        };
        let (first, watching) = Watching::first(committed, Duration::from_secs(60), judge)
            .await
            .unwrap();
        let answer = watching.until(first, judge).await;
        assert_eq!((answer, started.elapsed()), (Ok(1), Duration::ZERO));
    });
}

#[test]
fn answers_at_its_deadline_however_many_commits_come_before_it() {
    crate::testing::paused().block_on(async {
        let (commit, committed) = commits();
        let started = Instant::now();
        let mut committing = tokio::task::JoinSet::new();
        committing.spawn(async move {
            for n in 1..=5 {
                tokio::time::sleep(Duration::from_secs(10)).await;
                commit.send_replace(n);
            }
            std::future::pending::<()>().await;
        });
        let judgements = AtomicUsize::new(0);
        let judge = || {
            let made = judgements.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok::<_, ()>(Judged {
                done: false,
                value: made,
            }))
        };
        let (first, watching) = Watching::first(committed, Duration::from_secs(30), judge)
            .await
            .unwrap();
        let answer = watching.until(first, judge).await;
        // The first, one after each of the two commits before the deadline, and one at it.
        assert_eq!(
            (answer, started.elapsed()),
            (Ok(3), Duration::from_secs(30))
        );
    });
}

#[test]
fn answers_with_its_last_judgement_once_the_store_is_gone() {
    crate::testing::paused().block_on(async {
        let (commit, committed) = commits();
        let started = Instant::now();
        let judge = || {
            std::future::ready(Ok::<_, ()>(Judged {
                done: false,
                value: "pending",
            }))
        };
        let (first, watching) = Watching::first(committed, Duration::from_secs(60), judge)
            .await
            .unwrap();
        drop(commit);
        let answer = watching.until(first, judge).await;
        assert_eq!((answer, started.elapsed()), (Ok("pending"), Duration::ZERO));
    });
}

/// A store with one agent, served by a daemon whose waits are `waits`.
struct Daemon {
    shared: Shared,
    thread: Option<Thread>,
    _dir: TempDir,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.finish();
        }
    }
}

fn daemon(socket: usize, http: usize) -> Daemon {
    let dir = TempDir::new("waits");
    let path = dir.path().join("bazhen.db");
    let (store, thread) =
        crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
    let shared = Shared::new(&"f".repeat(64), Stop::default(), store).with_waits(socket, http);
    let daemon = Daemon {
        shared,
        thread: Some(thread),
        _dir: dir,
    };
    daemon.write(|w| {
        w.connection().execute_batch(&format!(
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
               SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
             INSERT INTO environments (id, kind, created_event_id) VALUES ('{ENV}', 'local', 1);
             INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
               created_event_id, updated_event_id)
               VALUES ('{AGENT}', '{ENV}', 'claude-code', 'p', '/w', 'running', 1, 1);"
        ))?;
        Ok(())
    });
    daemon
}

impl Daemon {
    fn write<T: Send + 'static>(
        &self,
        write: impl FnOnce(&bazhen_store::Writer<'_>) -> Result<T, AppendError> + Send + 'static,
    ) -> T {
        let store = self.shared.store.clone();
        std::thread::spawn(move || {
            crate::testing::runtime()
                .block_on(store.run(move |store| store.write(write)))
                .unwrap()
                .unwrap()
        })
        .join()
        .unwrap()
    }

    fn queued(&self, bodies: &[&'static str]) -> Vec<MessageId> {
        let bodies = bodies.to_vec();
        self.write(move |w| {
            bodies
                .iter()
                .map(|body| w.queue_mail(&agent(), body, None).map(|(id, _)| id))
                .collect()
        })
    }

    fn step(&self, message: &MessageId, change: MailChange) {
        let message = message.clone();
        self.write(move |w| w.mail_step(&message, change));
    }

    async fn wait(&self, body: Value) -> (u16, Value) {
        wait(self.shared.clone(), body).await
    }
}

/// The route's answer to `body`, on the socket, as the owner.
async fn wait(shared: Shared, body: Value) -> (u16, Value) {
    let response = messages(
        State(shared),
        Extension(On::Socket),
        None,
        None,
        None,
        Bytes::from(body.to_string()),
    )
    .await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn undeliverable() -> MailChange {
    MailChange::Undeliverable(MailUndeliverable {
        reason: UndeliverableReason::AgentClosed,
    })
}

fn states(answer: &Value) -> Vec<&str> {
    answer["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["state"].as_str().unwrap())
        .collect()
}

#[test]
fn answers_once_every_message_is_settled_with_each_in_the_order_asked() {
    let d = daemon(crate::accept::SOCKET_MAX, 128);
    let ids = d.queued(&["one", "two"]);
    let asked = json!({ "messageIds": [ids[1], ids[0]], "timeoutMs": 60_000 });
    crate::testing::runtime().block_on(async {
        let mut waiting = tokio::task::JoinSet::new();
        waiting.spawn(wait(d.shared.clone(), asked));
        tokio::task::yield_now().await;
        d.step(&ids[0], undeliverable());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            waiting.try_join_next().is_none(),
            "answered with one message still queued"
        );
        d.step(&ids[1], undeliverable());
        let (status, answer) = tokio::time::timeout(Duration::from_secs(10), waiting.join_next())
            .await
            .expect("still waiting once both were settled")
            .unwrap()
            .unwrap();
        assert_eq!(status, 200);
        assert_eq!(states(&answer), ["undeliverable", "undeliverable"]);
        assert_eq!(answer["messages"][0]["id"], json!(ids[1]));
        assert_eq!(answer["messages"][0]["agentId"], json!(AGENT));
    });
    assert_eq!(held(&d.shared.waits), (0, 0, 0));
}

#[test]
fn answers_a_wait_of_no_time_and_refuses_a_message_never_queued_with_its_callers_cap_full() {
    let d = daemon(8, 8);
    let ids = d.queued(&["one"]);
    let _full = d.shared.waits.enter(On::Socket, Waiter::Owner).unwrap();
    crate::testing::runtime().block_on(async {
        let now = d
            .wait(json!({ "messageIds": [ids[0]], "timeoutMs": 0 }))
            .await;
        assert_eq!(now.0, 200, "answered {}", now.1);
        assert_eq!(states(&now.1), ["queued"]);
        let never = "msg_01900000000070008000000000000042";
        let unknown = d
            .wait(json!({ "messageIds": [ids[0], never], "timeoutMs": 1000 }))
            .await;
        assert_eq!(
            unknown,
            (
                404,
                json!({ "error": "not_found", "message": format!("no message {never}") })
            )
        );
        let crowded = d
            .wait(json!({ "messageIds": [ids[0]], "timeoutMs": 1000 }))
            .await;
        assert_eq!(
            (crowded.0, &crowded.1["error"]),
            (429, &json!("rate_limited"))
        );
    });
}

/// One request sent on a connection of its own, which the daemon closes once it answers.
async fn sent(address: std::net::SocketAddr, path: &str, body: Option<&Value>) -> TcpStream {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let head = match body {
        Some(body) => {
            let body = body.to_string();
            format!(
                "POST {path} HTTP/1.1\r\nhost: {address}\r\nconnection: close\r\n\
                 content-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
        }
        None => format!("GET {path} HTTP/1.1\r\nhost: {address}\r\nconnection: close\r\n\r\n"),
    };
    stream.write_all(head.as_bytes()).await.unwrap();
    stream
}

/// The status a connection's answer gives, once it comes; `None` if none comes in `within`.
async fn status(mut stream: TcpStream, within: Duration) -> Option<u16> {
    let mut answer = Vec::new();
    tokio::time::timeout(within, stream.read_to_end(&mut answer))
        .await
        .ok()?
        .unwrap();
    let text = String::from_utf8_lossy(&answer);
    text.split(' ').nth(1).and_then(|code| code.parse().ok())
}

struct Served {
    address: std::net::SocketAddr,
    stop: CancellationToken,
    tracker: TaskTracker,
}

/// `router` served on loopback TCP with `limits`, as a listener serves it.
async fn served(router: axum::Router, limits: Limits) -> Served {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, tracker) = (CancellationToken::new(), TaskTracker::new());
    tracker.spawn(crate::accept::serve_on(
        listener,
        router,
        limits,
        stop.clone(),
        tracker.clone(),
        || {},
    ));
    Served {
        address,
        stop,
        tracker,
    }
}

fn multi() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

/// Waits until `waits` holds `want`, as [`held`] counts it, failing after 5 s.
async fn holding(waits: &Waits, want: (usize, usize, usize)) {
    for _ in 0..500 {
        if held(waits) == want {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(held(waits), want, "still holding after 5 s");
}

#[test]
fn refuses_a_wait_over_http_past_half_its_connections_and_still_answers_there() {
    let d = daemon(crate::accept::SOCKET_MAX, 8);
    let ids = d.queued(&["one"]);
    multi().block_on(async {
        let limits = Limits {
            connections: 8,
            ..crate::accept::HTTP
        };
        let server = served_http(&d, limits).await;
        let long = json!({ "messageIds": [ids[0]], "timeoutMs": 60_000 });
        let mut waiting = Vec::new();
        for _ in 0..4 {
            waiting.push(sent(server.address, "/v1/messages/wait", Some(&long)).await);
        }
        holding(&d.shared.waits, (0, 4, 1)).await;
        let short = json!({ "messageIds": [ids[0]], "timeoutMs": 2000 });
        let fifth = sent(server.address, "/v1/messages/wait", Some(&short)).await;
        assert_eq!(status(fifth, Duration::from_secs(5)).await, Some(429));
        let health = sent(server.address, "/v1/health", None).await;
        assert_eq!(status(health, Duration::from_secs(5)).await, Some(200));
        assert_eq!(held(&d.shared.waits), (0, 4, 1));
        server.stop.cancel();
        drop(waiting);
    });
}

/// The HTTP listener's router for `d`, served with `limits`, the caller the test's own process.
async fn served_http(d: &Daemon, limits: Limits) -> Served {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let gate = Gate {
        allow: guard::allowlists(address.port(), None, &[]),
        pairing_required: false,
    };
    let router = crate::testing::connected(crate::routes::http_router(d.shared.clone(), gate));
    let (stop, tracker) = (CancellationToken::new(), TaskTracker::new());
    tracker.spawn(crate::accept::serve_on(
        listener,
        router,
        limits,
        stop.clone(),
        tracker.clone(),
        || {},
    ));
    Served {
        address,
        stop,
        tracker,
    }
}

#[test]
fn drops_a_wait_at_a_stop_rather_than_waiting_out_its_time() {
    let d = daemon(crate::accept::SOCKET_MAX, 128);
    let ids = d.queued(&["one"]);
    multi().block_on(async {
        let router = crate::testing::without_the_callers_socket(crate::routes::socket_router(
            d.shared.clone(),
        ));
        let server = served(router, crate::accept::SOCKET).await;
        let long = json!({ "messageIds": [ids[0]], "timeoutMs": 60_000 });
        let waiting = sent(server.address, "/v1/messages/wait", Some(&long)).await;
        holding(&d.shared.waits, (1, 0, 1)).await;
        server.tracker.close();
        server.stop.cancel();
        let drained = tokio::time::timeout(Duration::from_secs(2), server.tracker.wait()).await;
        assert!(drained.is_ok(), "the stop still waits on the wait");
        // Dropped unanswered, so its client asks the next daemon.
        assert_eq!(status(waiting, Duration::from_secs(1)).await, None);
        assert_eq!(held(&d.shared.waits), (0, 0, 0));
    });
}

#[test]
fn gives_back_the_places_of_waits_whose_clients_hang_up() {
    let d = daemon(crate::accept::SOCKET_MAX, 8);
    let ids = d.queued(&["one"]);
    multi().block_on(async {
        let limits = Limits {
            connections: 8,
            ..crate::accept::HTTP
        };
        let server = served_http(&d, limits).await;
        let long = json!({ "messageIds": [ids[0]], "timeoutMs": 60_000 });
        let mut waiting = Vec::new();
        for _ in 0..4 {
            waiting.push(sent(server.address, "/v1/messages/wait", Some(&long)).await);
        }
        holding(&d.shared.waits, (0, 4, 1)).await;
        drop(waiting);
        holding(&d.shared.waits, (0, 0, 0)).await;
        let _fifth = sent(server.address, "/v1/messages/wait", Some(&long)).await;
        holding(&d.shared.waits, (0, 1, 1)).await;
        server.stop.cancel();
    });
}

#[test]
fn judges_a_wait_for_mail_while_the_writer_is_busy() {
    let d = daemon(crate::accept::SOCKET_MAX, 128);
    let ids = d.queued(&["one"]);
    let (free, freed) = std::sync::mpsc::channel::<()>();
    let (busy, writing) = std::sync::mpsc::channel();
    let store = d.shared.store.clone();
    let writer = std::thread::spawn(move || {
        crate::testing::runtime().block_on(store.run(move |_| {
            busy.send(()).unwrap();
            freed.recv().ok();
        }))
    });
    writing.recv().unwrap();
    let judged = crate::testing::runtime().block_on(async {
        tokio::time::timeout(
            Duration::from_secs(2),
            d.wait(json!({ "messageIds": [ids[0]], "timeoutMs": 0 })),
        )
        .await
    });
    free.send(()).unwrap();
    writer.join().unwrap().unwrap();
    let (status, answer) = judged.expect("judged behind the writer's work");
    assert_eq!((status, states(&answer)), (200, vec!["queued"]));
}
