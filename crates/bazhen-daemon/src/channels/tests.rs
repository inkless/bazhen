use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use bazhen_harness::{
    Gate, HarnessDeps, Harnesses, Key, Keyed, Observed, SessionKey, Settled, ToolKey, compiled,
};
use bazhen_protocol::agents::{ActivityValue, LaunchAgentRequest};
use bazhen_store::AppendError;
use serde_json::{Value, json};
use tokio::net::UnixListener;

use super::*;
use crate::agents::{Agents, AgentsDeps, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::hooks::Hooks;
use crate::roles::Roles;
use crate::routes::Stop;
use crate::terminals::fake::Fake;
use crate::testing::stub_harness::{STUB_SESSION, StubHarness, pull};
use crate::testing::{Server, TempDir, accepted, heard, runtime, say, within};
use crate::tokens::AgentTokens;
use crate::writer::Thread;

/// Long enough for any step here, which comes at once or never.
const LIMIT: Duration = Duration::from_secs(10);

/// A Codex agent, running on the session `STUB_SESSION`, whose launch named it `rev` and set its
/// compaction window; the daemon serving it with the Codex adapter, on a Codex home of the test's.
struct Fixture {
    shared: Shared,
    agent: AgentId,
    codex_home: PathBuf,
    home: String,
    tracker: TaskTracker,
    stop: CancellationToken,
    _dir: TempDir,
    thread: Option<Thread>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(thread) = self.thread.take() {
            thread.finish();
        }
    }
}

fn agents_over(store: &Writer, dir: &TempDir, harnesses: Harnesses, hooks: &Arc<Hooks>) -> Agents {
    let run = dir.path().join("run");
    let uid = rustix::process::getuid().as_raw();
    Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::new(Fake::default()),
        budget: Arc::new(Budget::new(
            100,
            Arc::new(Machine(StdMutex::new(roomy()))),
            Box::new(|_| {}),
        )),
        home: dir.path().join("home").to_string_lossy().into_owned(),
        socket: "/run/b.sock".to_owned(),
        tracker: TaskTracker::new(),
        roles: Arc::new(Roles::new(None)),
        harnesses,
        hook_built: true,
        turns: Arc::default(),
        tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
        prompts: prompts::daemon_prompts(&run, uid),
        login_shell: None,
        hooks: Arc::clone(hooks),
    })
}

fn fixture() -> Fixture {
    let dir = TempDir::new("channels");
    let path = dir.path().join("bazhen.db");
    let (store, thread) =
        crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(home.join("repo")).unwrap();
    let codex_home = dir.path().join("codex");
    std::fs::create_dir_all(codex_home.join("app-server-control")).unwrap();
    let hooks = Arc::new(Hooks::default());
    // Launched by a harness of the test's under Codex's id, as Codex launches only over its server.
    let launcher = agents_over(
        &store,
        &dir,
        StubHarness::new(pull()).served_as(HarnessId::Codex),
        &hooks,
    );
    let agent = runtime()
        .block_on(launcher.launch(&LaunchAgentRequest {
            idempotency_key: "k-1".to_owned(),
            harness: HarnessId::Codex,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: Some(bazhen_protocol::names::AgentName::parse("rev").unwrap()),
            role: None,
            compact_window_tokens: Some(200_000),
        }))
        .unwrap()
        .agent_id;
    let codex_text = codex_home.to_string_lossy().into_owned();
    let served = compiled(HarnessDeps {
        new_session_id: Box::new(|| "session-1".to_owned()),
        hook_command: "exec '/state/hook/bazhen-hook'".to_owned(),
        daemon_env: Box::new(|_| None),
        user_env: Box::new(move |name| (name == "CODEX_HOME").then(|| codex_text.clone())),
        home: home.to_string_lossy().into_owned(),
        read_file: Box::new(|_| None),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
        daemon_socket: "/run/b.sock".to_owned(),
        real_path: Arc::new(|path| Some(path.to_owned())),
    });
    let agents = Arc::new(agents_over(&store, &dir, served, &hooks));
    let shared = Shared::new(&"f".repeat(64), Stop::default(), store)
        .with_hooks(hooks)
        .with_agents(agents);
    let f = Fixture {
        shared,
        agent,
        codex_home,
        home: home.to_string_lossy().into_owned(),
        tracker: TaskTracker::new(),
        stop: CancellationToken::new(),
        _dir: dir,
        thread: Some(thread),
    };
    f.set_running();
    f
}

impl Fixture {
    fn set_running(&self) {
        self.set("state = 'running'");
    }

    /// Sets the agent's row as `assignment` says, as an older daemon may have left it.
    fn set(&self, assignment: &str) {
        let (agent, sql) = (
            self.agent.clone(),
            format!("UPDATE agent_sessions SET {assignment} WHERE id = ?"),
        );
        runtime()
            .block_on(self.shared.store.run(move |store| {
                store.write(|w| {
                    w.connection().execute(&sql, [agent.as_str()])?;
                    Ok::<_, AppendError>(())
                })
            }))
            .unwrap()
            .unwrap();
    }

    /// The agent's events of `kind`, by their payloads, oldest first.
    fn of(&self, kind: &str) -> Vec<Value> {
        let reader = self.shared.store.reader().unwrap();
        let events = reader.reads().events(0, 1000).unwrap();
        events
            .into_iter()
            .filter(|e| e.kind == kind)
            .map(|e| serde_json::from_str(&e.payload).unwrap())
            .collect()
    }

    fn open_items(&self) -> usize {
        let reader = self.shared.store.reader().unwrap();
        reader
            .reads()
            .open_attention(self.agent.as_str())
            .unwrap()
            .len()
    }

    fn activity(&self) -> Option<ActivityValue> {
        let reader = self.shared.store.reader().unwrap();
        let activity = reader.reads().latest_activity(self.agent.as_str()).unwrap();
        activity.map(|activity| activity.value)
    }

    /// The server's side of the channel `start` opens, once its handshake and the pickup of the
    /// agent's session are answered: the pickup's params.
    async fn picked_up(&self) -> (Server, Value) {
        let socket = self
            .codex_home
            .join("app-server-control/app-server-control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let commands = Arc::new(Commands::new(crate::env::Env::new()));
        start(&self.shared, &commands, &self.tracker, &self.stop);
        let mut server = accepted(&listener).await;
        let init = heard(&mut server).await;
        assert_eq!(init["method"], "initialize", "{init}");
        let codex_home = self.codex_home.to_string_lossy();
        let answer = json!({ "codexHome": codex_home, "userAgent": "codex_cli_rs/1.2.3 (Linux)" });
        say(&mut server, json!({ "id": init["id"], "result": answer })).await;
        let initialized = heard(&mut server).await;
        assert_eq!(initialized["method"], "initialized", "{initialized}");
        let resume = heard(&mut server).await;
        assert_eq!(resume["method"], "thread/resume", "{resume}");
        let thread = json!({ "id": STUB_SESSION, "status": { "type": "idle" } });
        say(
            &mut server,
            json!({ "id": resume["id"], "result": { "thread": thread } }),
        )
        .await;
        (server, resume["params"].clone())
    }
}

/// Waits until `done`, failing the test if it never is.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    within(LIMIT, async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(done(), "{what}");
}

fn notification(method: &str, params: &Value) -> Value {
    json!({ "method": method, "params": params })
}

#[test]
fn picks_up_the_served_agents_session_with_its_launch_and_applies_what_its_server_says_of_it() {
    let f = fixture();
    let (picked, compacted, worked) = runtime().block_on(async {
        let (mut server, params) = f.picked_up().await;
        let other = json!({ "threadId": "t-other", "turn": { "id": "u-1", "status": "inProgress" } });
        say(&mut server, notification("turn/started", &other)).await;
        let item = json!({ "threadId": STUB_SESSION, "item": { "type": "contextCompaction", "id": "i-1" } });
        say(&mut server, notification("item/completed", &item)).await;
        until("the compaction was recorded", || !f.of("agent.compacted").is_empty()).await;
        // Applied in order, so the other thread's turn, told first, is done with by now, and the
        // pickup's idle thread is all the agent has done.
        let unmoved = f.activity();
        let turn = json!({ "threadId": STUB_SESSION, "turn": { "id": "u-2", "status": "inProgress" } });
        say(&mut server, notification("turn/started", &turn)).await;
        until("the turn was recorded", || f.activity() == Some(ActivityValue::Working)).await;
        (params, (f.of("agent.compacted"), unmoved), f.activity())
    });
    assert_eq!(
        (
            &picked["threadId"],
            &picked["config"]["model_auto_compact_token_limit"]
        ),
        (&json!(STUB_SESSION), &json!(200_000))
    );
    assert_eq!(
        compacted,
        (
            vec![json!({ "sign": "codex_item" })],
            Some(ActivityValue::Idle)
        )
    );
    assert_eq!(worked, Some(ActivityValue::Working));
}

#[test]
fn opens_an_approval_its_server_asks_offering_nothing_and_closes_it_once_the_tui_answers() {
    let f = fixture();
    let (offered, answered, closed) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        let asked = json!({ "threadId": STUB_SESSION, "itemId": "call-1", "command": "ls" });
        let request = json!({
            "id": 7, "method": "item/commandExecution/requestApproval", "params": asked,
        });
        say(&mut server, request).await;
        until("the approval was opened", || f.open_items() == 1).await;
        let offered = actions(&f).await;
        let reader = f.shared.store.reader().unwrap();
        let id = reader.reads().open_attention(f.agent.as_str()).unwrap()[0]
            .id
            .clone();
        let body = json!({ "idempotencyKey": "k", "decision": "allow" }).to_string();
        let response = crate::attention::answer(
            State(f.shared.clone()),
            Path(id.as_str().to_owned()),
            None,
            Bytes::from(body),
        )
        .await;
        let resolved = json!({ "threadId": STUB_SESSION, "requestId": 7 });
        say(
            &mut server,
            notification("serverRequest/resolved", &resolved),
        )
        .await;
        until("the approval was closed", || f.open_items() == 0).await;
        (
            offered,
            response.status().as_u16(),
            f.of("attention.closed"),
        )
    });
    assert_eq!((offered, answered), (vec![json!([])], 409));
    assert_eq!(
        closed
            .iter()
            .map(|closed| closed["reason"].clone())
            .collect::<Vec<_>>(),
        [json!("answered_in_tui")]
    );
}

#[test]
fn closes_an_approval_its_server_settled_for_the_reason_it_gives() {
    let f = fixture();
    let on_session = |fact| Keyed {
        key: Key::Session(SessionKey(STUB_SESSION.to_owned())),
        gate: Gate::None,
        fact,
    };
    let hows = [
        Settled::AnsweredInTui,
        Settled::Superseded,
        Settled::AgentClosed,
        Settled::Stale,
    ];
    runtime().block_on(async {
        for (n, how) in hows.into_iter().enumerate() {
            let key = ToolKey {
                key: format!("call-{n}"),
                caller: None,
                prompt_id: None,
            };
            let asked = Observed::ApprovalAsked {
                key: key.clone(),
                summary: "Run ls".to_owned(),
                question: false,
            };
            let settled = Observed::ApprovalSettled { key, how };
            let told = vec![on_session(asked), on_session(settled)];
            f.shared
                .hooks
                .channel(&f.shared, HarnessId::Codex, told)
                .await
                .unwrap();
        }
    });
    let reasons: Vec<_> = f
        .of("attention.closed")
        .iter()
        .map(|closed| closed["reason"].clone())
        .collect();
    assert_eq!(
        reasons,
        ["answered_in_tui", "superseded", "agent_closed", "stale"].map(|r| json!(r))
    );
}

/// What `/v1/state` offers for each open item, oldest first.
async fn actions(f: &Fixture) -> Vec<Value> {
    let response = crate::routes::state(State(f.shared.clone()), None).await;
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let state: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    state["attention"]
        .as_array()
        .map_or_else(Vec::new, |items| {
            items
                .iter()
                .filter(|item| item["state"] == "open")
                .map(|item| item["actions"].clone())
                .collect()
        })
}

#[test]
fn picks_up_each_served_agent_on_its_session_with_what_its_launch_set() {
    let f = fixture();
    let bound = read_bound(&f.shared.store, HarnessId::Codex).unwrap();
    let picked: Vec<_> = bound
        .into_iter()
        .map(|b| (b.agent, b.session.id, b.launch))
        .collect();
    assert_eq!(
        picked,
        [(
            f.agent.clone(),
            STUB_SESSION.to_owned(),
            LaunchRequest {
                cwd: format!("{}/repo", f.home),
                theme: None,
                instructions: None,
                instructions_file: None,
                instructions_changed: false,
                name: Some("rev".to_owned()),
                compact_window_tokens: Some(200_000),
            }
        )]
    );
    assert_eq!(
        read_bound(&f.shared.store, HarnessId::ClaudeCode).unwrap(),
        []
    );
}

#[test]
fn picks_up_an_agent_stored_with_an_empty_name_as_one_with_none() {
    let f = fixture();
    f.set("name = ''");
    let bound = read_bound(&f.shared.store, HarnessId::Codex).unwrap();
    let names: Vec<_> = bound.into_iter().map(|b| b.launch.name).collect();
    assert_eq!(names, [None]);
}
