use std::sync::Mutex as StdMutex;

use bazhen_protocol::agents::LaunchAgentRequest;
use rustix::process::Pid;
use serde_json::{Value, json};
use tokio_util::task::TaskTracker;

use super::*;
use crate::agents::{Agents, AgentsDeps, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::roles::Roles;
use crate::routes::Stop;
use crate::terminals::fake::Fake;
use crate::testing::stub_harness::production_for_test;
use crate::testing::{TempDir, runtime};
use crate::tokens::AgentTokens;
use crate::writer::Thread;

/// The root process the fake runtime records for an agent's first terminal.
const ROOT: i32 = 5000;

/// A Claude Code agent launched on the fake runtime, on the session `session-1`.
struct Fixture {
    shared: Shared,
    agent: AgentId,
    dir: TempDir,
    thread: Option<Thread>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.finish();
        }
    }
}

fn fixture() -> Fixture {
    let dir = TempDir::new("hooks");
    let path = dir.path().join("bazhen.db");
    let (store, thread) =
        crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(home.join("repo")).unwrap();
    let run = dir.path().join("run");
    let uid = rustix::process::getuid().as_raw();
    let budget = Budget::new(
        100,
        Arc::new(Machine(StdMutex::new(roomy()))),
        Box::new(|_| {}),
    );
    let hooks = Arc::new(Hooks::waiting(Duration::from_millis(50)));
    let agents = Arc::new(Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::new(Fake::default()),
        budget: Arc::new(budget),
        home: home.to_string_lossy().into_owned(),
        socket: "/run/b.sock".to_owned(),
        tracker: TaskTracker::new(),
        roles: Arc::new(Roles::new(None)),
        harnesses: production_for_test(),
        hook_built: true,
        turns: Arc::default(),
        tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
        prompts: prompts::daemon_prompts(&run, uid),
        login_shell: None,
        hooks: Arc::clone(&hooks),
    }));
    let launched = runtime()
        .block_on(agents.launch(&LaunchAgentRequest {
            idempotency_key: "k-1".to_owned(),
            harness: HarnessId::ClaudeCode,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: None,
            role: None,
            compact_window_tokens: None,
        }))
        .unwrap();
    let shared = Shared::new(&"f".repeat(64), Stop::default(), store)
        .with_hooks(hooks)
        .with_agents(agents);
    Fixture {
        shared,
        agent: launched.agent_id,
        dir,
        thread: Some(thread),
    }
}

/// A hook client whose parent runs from `line`, each process by its pid and name, nearest first.
fn caller(line: &[(i32, &str)]) -> PeerRead {
    PeerRead::Read(peer_on(line))
}

fn peer_on(line: &[(i32, &str)]) -> Peer {
    let pid = |pid: i32| Pid::from_raw(pid).unwrap();
    Peer {
        pid: pid(9000),
        session: None,
        codex_server: None,
        environment_withheld: false,
        ancestors: line.iter().map(|(at, _)| pid(*at)).collect(),
        names: line.iter().map(|(_, name)| (*name).to_owned()).collect(),
    }
}

/// The TUI the agent's terminal runs.
fn its_tui() -> PeerRead {
    caller(&[(ROOT, "claude")])
}

/// A TUI a shell in the agent's terminal runs.
fn nested_tui() -> PeerRead {
    caller(&[(6000, "claude"), (6001, "zsh"), (ROOT, "claude")])
}

impl Fixture {
    fn request(&self, version: &str, event: &str, payload: &Value) -> HookRequest {
        let body = json!({
            "protocolVersion": version, "agentId": self.agent.as_str(), "event": event,
            "pid": 77, "ppid": ROOT, "payload": payload,
        });
        edge::<HookRequest>(body.to_string().as_bytes()).unwrap()
    }

    fn post(&self, version: &str, event: &str, payload: &Value, peer: PeerRead) -> Response {
        let hook = self.request(version, event, payload);
        runtime().block_on(taken(&self.shared, &hook, None, Some(peer), None))
    }

    /// Posts a waiter's hook, and says whether it is held; once it is, its client goes. A hook
    /// neither answered nor held by the deadline fails the test rather than hang it.
    fn wait(&self, payload: &Value, peer: PeerRead) -> bool {
        let hook = self.request(HOOK_PROTOCOL_VERSION, "wait", payload);
        let held = runtime().block_on(async {
            tokio::time::timeout(DEADLINE, async {
                let answered = taken(&self.shared, &hook, None, Some(peer), None);
                let mut answered = std::pin::pin!(answered);
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut answered => return false,
                        () = tokio::task::yield_now() => {
                            if self.shared.hooks.waiters.holds(&self.agent) {
                                return true;
                            }
                        }
                    }
                }
            })
            .await
        });
        held.expect("the waiter's hook was neither answered nor held by the deadline")
    }

    fn hook(&self, event: &str, payload: &Value, peer: PeerRead) -> Response {
        self.post(HOOK_PROTOCOL_VERSION, event, payload, peer)
    }

    /// Each event recorded after the launch, by its type and payload.
    fn since_launch(&self) -> Vec<(String, Value)> {
        let reader = self.shared.store.reader().unwrap();
        let events = reader.reads().events(0, 1000).unwrap();
        let after = events
            .iter()
            .position(|e| e.kind == "agent.running")
            .map_or(0, |at| at + 1);
        events
            .into_iter()
            .skip(after)
            .map(|e| (e.kind, serde_json::from_str(&e.payload).unwrap()))
            .collect()
    }

    fn of(&self, kind: &str) -> Vec<Value> {
        self.since_launch()
            .into_iter()
            .filter(|(k, _)| k == kind)
            .map(|(_, payload)| payload)
            .collect()
    }
}

fn prompt(session: &str) -> Value {
    json!({ "hook_event_name": "UserPromptSubmit", "session_id": session, "prompt": "go" })
}

fn session_start(session: &str, source: &str) -> Value {
    json!({
        "hook_event_name": "SessionStart", "session_id": session, "source": source,
        "transcript_path": format!("/t/{session}.jsonl"),
    })
}

#[test]
fn records_what_the_agents_own_session_says_it_is_doing_and_not_another_sessions() {
    let f = fixture();
    let stop = |session: &str| json!({ "hook_event_name": "Stop", "session_id": session });
    f.hook("UserPromptSubmit", &prompt("session-1"), its_tui());
    f.hook("Stop", &stop("other"), its_tui());
    f.hook("UserPromptSubmit", &prompt("session-1"), its_tui());
    let values: Vec<Value> = f
        .of("agent.activity")
        .into_iter()
        .map(|a| json!([a["value"], a["source"], a["confidence"]]))
        .collect();
    assert_eq!(values, [json!(["working", "native", 1])]);
}

#[test]
fn moves_the_agent_to_a_session_its_own_tui_started_and_records_its_transcript() {
    let f = fixture();
    f.wait(&session_start("session-3", "clear"), nested_tui());
    f.wait(&session_start("session-2", "clear"), its_tui());
    assert_eq!(
        (
            f.of("agent.external_ref_updated"),
            f.of("agent.transcript_recorded")
        ),
        (
            vec![json!({ "externalRef": {
                "environmentId": f.of_env(), "kind": "claude-session", "id": "session-2" } })],
            vec![json!({ "sessionId": "session-2", "path": "/t/session-2.jsonl" })]
        )
    );
}

impl Fixture {
    fn of_env(&self) -> Value {
        let reader = self.shared.store.reader().unwrap();
        let binding = reader.reads().agent_binding(self.agent.as_str()).unwrap();
        json!(binding.unwrap().environment)
    }
}

#[test]
fn records_a_compaction_of_the_agents_session_with_the_hook_that_reported_it() {
    let f = fixture();
    f.wait(&session_start("session-1", "compact"), its_tui());
    f.wait(&session_start("session-1", "compact"), its_tui());
    assert_eq!(
        f.of("agent.compacted"),
        [json!({ "sign": "claude_hook", "hook": { "sessionId": "session-1", "pid": 77 } })]
    );
}

/// A response's status, its framing headers and its body.
fn reply_of(response: Response) -> (u16, Vec<String>, Vec<u8>) {
    let status = response.status().as_u16();
    let headers = [
        "content-type",
        "bazhen-exit-code",
        "bazhen-offered",
        "bazhen-stdout-bytes",
    ]
    .map(|name| {
        let value = response.headers().get(name);
        value.map_or("-".to_owned(), |v| v.to_str().unwrap().to_owned())
    })
    .to_vec();
    let body = runtime().block_on(axum::body::to_bytes(response.into_body(), 1 << 20));
    (status, headers, body.unwrap().to_vec())
}

#[test]
fn answers_quiet_a_hook_of_another_major_and_tells_a_late_caller_to_try_again() {
    let f = fixture();
    let quiet = (
        200,
        vec![
            HOOK_REPLY_TYPE.to_owned(),
            "0".to_owned(),
            String::new(),
            "0".to_owned(),
        ],
        Vec::new(),
    );
    assert_eq!(
        [
            reply_of(f.post("2.0", "UserPromptSubmit", &prompt("session-1"), its_tui())),
            reply_of(f.post("1.9", "UserPromptSubmit", &prompt("other"), its_tui())),
        ],
        [quiet.clone(), quiet]
    );
    let (status, ..) = reply_of(f.hook("wait", &prompt("session-1"), PeerRead::Late));
    assert_eq!((status, f.of("agent.activity")), (503, vec![]));
}

#[test]
fn frames_a_reply_as_the_hook_client_reads_it() {
    let reply = HookReply {
        exit_code: 2,
        stdout: "é\n".to_owned(),
        stderr: "no".to_owned(),
        offered: [
            "msg_0190000000007000800000000000000a-1",
            "msg_0190000000007000800000000000000b-2",
        ]
        .map(|token| OfferToken::parse(token).unwrap())
        .to_vec(),
    };
    assert_eq!(
        reply_of(framed(&reply)),
        (
            200,
            vec![
                HOOK_REPLY_TYPE.to_owned(),
                "2".to_owned(),
                "msg_0190000000007000800000000000000a-1,msg_0190000000007000800000000000000b-2"
                    .to_owned(),
                "3".to_owned()
            ],
            "é\nno".as_bytes().to_vec()
        )
    );
}

#[test]
fn takes_only_a_version_whose_major_is_this_ones_as_text() {
    assert_eq!(
        ["1.0", "1.7", "01.0", "2.0", "0.9", "99999999999999999999.0"].map(compatible),
        [true, true, false, false, false, false]
    );
}

#[test]
fn takes_a_hook_past_axums_default_body_limit_as_the_typescript_daemon_does() {
    use tower::ServiceExt as _;
    let f = fixture();
    // A `PostToolUse` for an edit carries the whole file it wrote.
    let file = "x".repeat(3 << 20);
    let payload = json!({ "hook_event_name": "PostToolUse", "session_id": "session-1",
                          "tool_input": { "content": file } });
    let hook = |path: &str, body: &Value| {
        let request = axum::http::Request::post(path)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let router = crate::routes::socket_router(f.shared.clone());
        runtime().block_on(router.oneshot(request)).unwrap()
    };
    let body = json!({
        "protocolVersion": HOOK_PROTOCOL_VERSION, "agentId": f.agent.as_str(),
        "event": "PostToolUse", "pid": 77, "ppid": ROOT, "payload": payload,
    });
    let ack = json!({ "agentId": f.agent.as_str(), "offered": [], "pad": file });
    let (hooked, acked) = (hook("/v1/hooks", &body), hook("/v1/hooks/ack", &ack));
    assert_eq!((reply_of(hooked).0, acked.status().as_u16()), (200, 200));
}

fn stop_in(session: &str) -> Value {
    json!({ "hook_event_name": "Stop", "session_id": session })
}

impl Fixture {
    /// Sets the agent's state as its row records it, as a close would.
    fn set_state(&self, state: &'static str) {
        let agent = self.agent.clone();
        runtime()
            .block_on(write(&self.shared.store, move |w| {
                w.connection().execute(
                    "UPDATE agent_sessions SET state = ? WHERE id = ?",
                    (state, agent.as_str()),
                )?;
                Ok(())
            }))
            .unwrap();
    }
}

#[test]
fn records_the_harness_up_once_and_only_from_the_tui_its_terminal_started() {
    let f = fixture();
    f.hook("UserPromptSubmit", &prompt("session-1"), nested_tui());
    let nested = f.of("agent.ready").len();
    f.hook("UserPromptSubmit", &prompt("session-1"), its_tui());
    f.hook("UserPromptSubmit", &prompt("session-1"), its_tui());
    assert_eq!(
        (nested, f.of("agent.ready")),
        (0, vec![json!({ "sign": "claude_hook" })])
    );
}

#[test]
fn holds_the_waiter_of_the_agents_own_session_and_answers_a_closed_agents_at_once() {
    let f = fixture();
    let (own, other) = (
        f.wait(&stop_in("session-1"), its_tui()),
        f.wait(&stop_in("other"), its_tui()),
    );
    f.set_state("closed");
    let closed = f.wait(&stop_in("session-1"), its_tui());
    assert_eq!((own, other, closed), (true, false, false));
}

/// The fixture's daemon, served on a real socket through `accept::serve_on`, its caller read as
/// the agent's own TUI.
struct Served {
    f: Fixture,
    path: std::path::PathBuf,
    stop: tokio_util::sync::CancellationToken,
    runtime: tokio::runtime::Runtime,
}

fn served() -> Served {
    let mut f = fixture();
    f.shared.peers = crate::peer::Peers::with(Duration::from_secs(5), |_, _| {
        Ok(peer_on(&[(ROOT, "claude")]))
    });
    let path = f.dir.path().join("hooks.sock");
    let stop = tokio_util::sync::CancellationToken::new();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let router = crate::routes::socket_router(f.shared.clone());
    let listener = runtime.block_on(async { tokio::net::UnixListener::bind(&path).unwrap() });
    runtime.spawn(crate::accept::serve_on(
        listener,
        router,
        crate::accept::SOCKET,
        stop.clone(),
        TaskTracker::new(),
        || {},
    ));
    Served {
        f,
        path,
        stop,
        runtime,
    }
}

/// How long a proof waits for what it polls for.
const DEADLINE: Duration = Duration::from_secs(10);

impl Served {
    /// Opens a connection and sends a waiter's hook from the agent's own session on it.
    fn wait(&self) -> tokio::net::UnixStream {
        use tokio::io::AsyncWriteExt as _;
        let body = json!({
            "protocolVersion": HOOK_PROTOCOL_VERSION, "agentId": self.f.agent.as_str(),
            "event": "wait", "pid": 77, "ppid": ROOT, "payload": stop_in("session-1"),
        })
        .to_string();
        let request = format!(
            "POST /v1/hooks HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        self.runtime.block_on(async {
            let mut stream = tokio::net::UnixStream::connect(&self.path).await.unwrap();
            stream.write_all(request.as_bytes()).await.unwrap();
            stream
        })
    }

    /// Whether the agent holds a waiter by the deadline, or no longer holds one, as `held` asks.
    fn holds_by_deadline(&self, held: bool) -> bool {
        let waiters = Arc::clone(&self.f.shared.hooks);
        let agent = self.f.agent.clone();
        self.runtime.block_on(async move {
            tokio::time::timeout(DEADLINE, async {
                while waiters.waiters.holds(&agent) != held {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_ok()
        })
    }

    /// The head of the reply on `stream`, or none by the deadline.
    fn reply_head(&self, stream: &mut tokio::net::UnixStream) -> Option<String> {
        use tokio::io::AsyncReadExt as _;
        self.runtime.block_on(async {
            let mut sent = Vec::new();
            tokio::time::timeout(DEADLINE, async {
                while !sent.windows(4).any(|w| w == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let read = stream.read(&mut chunk).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    sent.extend_from_slice(chunk.get(..read).unwrap_or_default());
                }
            })
            .await
            .ok()
            .map(|()| String::from_utf8_lossy(&sent).into_owned())
        })
    }

    /// What the daemon sent on `stream` before it closed it, or none by the deadline.
    fn read_to_close(&self, stream: &mut tokio::net::UnixStream) -> Option<Vec<u8>> {
        use tokio::io::AsyncReadExt as _;
        self.runtime.block_on(async {
            let mut sent = Vec::new();
            tokio::time::timeout(DEADLINE, stream.read_to_end(&mut sent))
                .await
                .ok()
                .map(|read| {
                    read.unwrap();
                    sent
                })
        })
    }
}

#[test]
fn forgets_a_waiter_whose_client_closed_its_connection() {
    let s = served();
    let client = s.wait();
    let registered = s.holds_by_deadline(true);
    drop(client);
    assert_eq!((registered, s.holds_by_deadline(false)), (true, true));
}

#[test]
fn keeps_the_newer_waiter_when_the_older_it_answered_goes() {
    let s = served();
    let mut older = s.wait();
    let registered = s.holds_by_deadline(true);
    let _newer = s.wait();
    let head = s.reply_head(&mut older).unwrap_or_default();
    drop(older);
    assert_eq!(
        (
            registered,
            head.starts_with("HTTP/1.1 200"),
            head.contains("bazhen-exit-code: 0")
        ),
        (true, true, true)
    );
    // Answered, the older's handler has gone, its wait with it; the newer stays.
    assert!(s.f.shared.hooks.waiters.holds(&s.f.agent));
}

#[test]
fn drops_a_held_waiters_connection_unanswered_when_the_daemon_stops() {
    let s = served();
    let mut client = s.wait();
    let registered = s.holds_by_deadline(true);
    s.stop.cancel();
    assert_eq!(
        (registered, s.read_to_close(&mut client)),
        (true, Some(Vec::new()))
    );
}

#[test]
fn answers_the_waiter_a_hook_registers_after_the_close_it_read_the_agent_open_before() {
    let f = fixture();
    let (hooks, store, agent) = (&f.shared.hooks, &f.shared.store, f.agent.clone());
    let answered = runtime().block_on(async {
        // A hook has read the agent open, and holds its turn.
        let turn = hooks.turn_of(&agent);
        let held = turn.lock().await;
        let closing = agent.clone();
        write(store, move |w| {
            w.connection().execute(
                "UPDATE agent_sessions SET state = 'closed' WHERE id = ?",
                [closing.as_str()],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let mut closed = std::pin::pin!(hooks.closed(store, &agent));
        let ran = tokio::time::timeout(Duration::from_millis(50), &mut closed)
            .await
            .is_ok();
        // The hook registers its waiter, as it read the agent open, then gives up its turn.
        let mut waiting = hooks.waiters.wait(&agent);
        drop(held);
        if !ran {
            closed.await;
        }
        tokio::time::timeout(Duration::from_secs(2), waiting.answered())
            .await
            .ok()
    });
    assert_eq!(answered, Some(quiet()));
}
