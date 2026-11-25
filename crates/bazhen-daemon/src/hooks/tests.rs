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
    _dir: TempDir,
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
        tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
        prompts: prompts::daemon_prompts(&run, uid),
        login_shell: None,
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
    let mut shared = Shared::new(&"f".repeat(64), Stop::default(), store).with_agents(agents);
    shared.hooks = Arc::new(Hooks::waiting(Duration::from_millis(50)));
    Fixture {
        shared,
        agent: launched.agent_id,
        _dir: dir,
        thread: Some(thread),
    }
}

/// A hook client whose parent runs from `line`, each process by its pid and name, nearest first.
fn caller(line: &[(i32, &str)]) -> PeerRead {
    let pid = |pid: i32| Pid::from_raw(pid).unwrap();
    PeerRead::Read(Peer {
        pid: pid(9000),
        session: None,
        codex_server: None,
        environment_withheld: false,
        ancestors: line.iter().map(|(at, _)| pid(*at)).collect(),
        names: line.iter().map(|(_, name)| (*name).to_owned()).collect(),
    })
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
    fn post(&self, version: &str, event: &str, payload: &Value, peer: PeerRead) -> Response {
        let body = json!({
            "protocolVersion": version, "agentId": self.agent.as_str(), "event": event,
            "pid": 77, "ppid": ROOT, "payload": payload,
        });
        let hook = edge::<HookRequest>(body.to_string().as_bytes()).unwrap();
        runtime().block_on(taken(&self.shared, &hook, None, Some(peer)))
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
    f.hook("wait", &session_start("session-3", "clear"), nested_tui());
    f.hook("wait", &session_start("session-2", "clear"), its_tui());
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
    f.hook("wait", &session_start("session-1", "compact"), its_tui());
    f.hook("wait", &session_start("session-1", "compact"), its_tui());
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
