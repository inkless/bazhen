use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use bazhen_harness::{
    BoxFuture, Gate, HarnessDeps, Harnesses, Key, Keyed, Observed, SessionKey, Settled, ToolKey,
    compiled,
};
use bazhen_protocol::agent_events::AgentExited;
use bazhen_protocol::agents::{
    ActivityValue, ExitStatus, LaunchAgentRequest, LaunchAgentResponse, RespawnAgentRequest,
};
use bazhen_store::{AgentChange, AppendError, NewEvent};
use serde_json::{Value, json};
use tokio::net::UnixListener;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use super::*;
use crate::agents::{AgentError, Agents, AgentsDeps, NO_CHANNEL, prompts};
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
    /// The terminals the Codex agents start in.
    fake: Arc<Fake>,
    codex_home: PathBuf,
    home: String,
    tracker: TaskTracker,
    stop: CancellationToken,
    _dir: TempDir,
    _codex: TempDir,
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

fn agents_over(
    store: &Writer,
    dir: &TempDir,
    harnesses: Harnesses,
    hooks: &Arc<Hooks>,
    terminals: Arc<Fake>,
) -> Agents {
    let run = dir.path().join("run");
    let uid = rustix::process::getuid().as_raw();
    Agents::new(AgentsDeps {
        store: store.clone(),
        terminals,
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
    let codex = TempDir::short("cx");
    let codex_home = codex.path().to_path_buf();
    std::fs::create_dir_all(codex_home.join("app-server-control")).unwrap();
    let hooks = Arc::new(Hooks::default());
    // Launched by a harness of the test's under Codex's id, as Codex launches only over its server.
    let launcher = agents_over(
        &store,
        &dir,
        StubHarness::new(pull()).served_as(HarnessId::Codex),
        &hooks,
        Arc::new(Fake::default()),
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
    let fake = Arc::new(Fake::default());
    let agents = Arc::new(agents_over(&store, &dir, served, &hooks, Arc::clone(&fake)));
    let shared = Shared::new(&"f".repeat(64), Stop::default(), store)
        .with_hooks(hooks)
        .with_agents(agents);
    let f = Fixture {
        shared,
        agent,
        fake,
        codex_home,
        home: home.to_string_lossy().into_owned(),
        tracker: TaskTracker::new(),
        stop: CancellationToken::new(),
        _dir: dir,
        _codex: codex,
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

    fn events(&self) -> usize {
        let reader = self.shared.store.reader().unwrap();
        reader.reads().events(0, 1000).unwrap().len()
    }

    /// The session `agent` is bound to, by its id.
    fn bound_to(&self, agent: &AgentId) -> Option<String> {
        let reader = self.shared.store.reader().unwrap();
        let binding = reader.reads().agent_binding(agent.as_str()).unwrap();
        binding.and_then(|b| b.session).map(|session| session.id)
    }

    /// Whether the channel to Codex's server has no connection up, as the agents' channels show
    /// it: read from their debug form, which is all of a channel's link a test can see.
    fn unconnected(&self) -> bool {
        let agents = self.shared.agents.as_ref().unwrap();
        format!("{agents:?}").contains("Link { up: None")
    }

    /// `agent`'s process exited, as its terminal and the store show it; its generation.
    async fn exited(&self, agent: &AgentId) -> u64 {
        let reader = self.shared.store.reader().unwrap();
        let found = reader
            .reads()
            .agent_terminal(agent.as_str())
            .unwrap()
            .unwrap();
        self.fake
            .exit_unseen(found.terminal_id.as_ref().unwrap().as_str());
        let change = AgentChange::Exited(AgentExited {
            exit: ExitStatus::Unknown,
        });
        let event = NewEvent::Agent {
            agent: agent.clone(),
            actor: "system".to_owned(),
            change,
        };
        let store = &self.shared.store;
        store
            .run(move |store| store.write(|w| w.append(&event)))
            .await
            .unwrap()
            .unwrap();
        found.generation.unwrap()
    }

    /// A launch of another Codex agent, as the human asks for it, on a task of its own.
    fn launching(&self, key: &str) -> JoinHandle<Result<LaunchAgentResponse, AgentError>> {
        let agents = Arc::clone(self.shared.agents.as_ref().unwrap());
        let request = LaunchAgentRequest {
            idempotency_key: key.to_owned(),
            harness: HarnessId::Codex,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: None,
            role: None,
            compact_window_tokens: None,
        };
        self.tracker
            .spawn(async move { agents.launch(&request).await })
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

    /// Listens where the Codex home's server would, and starts the channels to it.
    fn started(&self) -> UnixListener {
        let socket = self
            .codex_home
            .join("app-server-control/app-server-control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let commands = Arc::new(Commands::new(crate::env::Env::new()));
        start(&self.shared, &commands, &self.tracker, &self.stop);
        listener
    }

    /// The server's side of the next connection, once its handshake is answered.
    async fn handshaken(&self, listener: &UnixListener) -> Server {
        let mut server = accepted(listener).await;
        let init = heard(&mut server).await;
        assert_eq!(init["method"], "initialize", "{init}");
        let codex_home = self.codex_home.to_string_lossy();
        let answer = json!({ "codexHome": codex_home, "userAgent": "codex_cli_rs/1.2.3 (Linux)" });
        say(&mut server, json!({ "id": init["id"], "result": answer })).await;
        let initialized = heard(&mut server).await;
        assert_eq!(initialized["method"], "initialized", "{initialized}");
        server
    }

    /// The server's side of the channel `start` opens, once its handshake and the pickup of the
    /// agent's session are answered: the pickup's params.
    async fn picked_up(&self) -> (Server, Value) {
        let listener = self.started();
        let mut server = self.handshaken(&listener).await;
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

/// Answers a launch's requests on `server`: the thread it starts, `thread`, and the instructions
/// put on it. The start's params.
async fn started_thread(server: &mut Server, thread: &str) -> Value {
    let start = heard(server).await;
    assert_eq!(start["method"], "thread/start", "{start}");
    let started = json!({ "thread": { "id": thread } });
    say(server, json!({ "id": start["id"], "result": started })).await;
    let injected = heard(server).await;
    assert_eq!(injected["method"], "thread/inject_items", "{injected}");
    say(server, json!({ "id": injected["id"], "result": {} })).await;
    start["params"].clone()
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

#[test]
fn launches_a_codex_agent_on_the_thread_its_server_starts_over_the_channel() {
    let f = fixture();
    // No agent served, so nothing but the launch connects.
    f.set("state = 'closed'");
    let (cwd, bound) = runtime().block_on(async {
        let listener = f.started();
        let mut launched = f.launching("k-2");
        let server = tokio::select! {
            server = f.handshaken(&listener) => Some(server),
            _ = &mut launched => None,
        };
        let Some(mut server) = server else {
            return (None, None);
        };
        let params = started_thread(&mut server, "t-new").await;
        let agent = within(LIMIT, launched).await.unwrap().unwrap().agent_id;
        (Some(params["cwd"].clone()), f.bound_to(&agent))
    });
    assert_eq!(
        (cwd, bound),
        (
            Some(json!(format!("{}/repo", f.home))),
            Some("t-new".to_owned())
        )
    );
}

#[test]
fn connects_again_for_an_agent_bound_after_the_connection_its_launch_made_ended() {
    let f = fixture();
    f.set("state = 'closed'");
    let gate = Arc::new(Semaphore::new(0));
    f.fake
        .set(|state| state.hold_creates = Some(Arc::clone(&gate)));
    let resumed = runtime().block_on(async {
        let listener = f.started();
        let launched = f.launching("k-2");
        let mut server = f.handshaken(&listener).await;
        started_thread(&mut server, "t-new").await;
        // Ended while its terminal is created, when no agent is bound yet to connect again for.
        drop(server);
        until("the connection was let go", || f.unconnected()).await;
        gate.add_permits(1);
        within(LIMIT, launched).await.unwrap().unwrap();
        let again = tokio::time::timeout(LIMIT, f.handshaken(&listener)).await;
        match again {
            Ok(mut server) => Some(heard(&mut server).await),
            Err(_) => None,
        }
    });
    let resumed = resumed.map(|r| (r["method"].clone(), r["params"]["threadId"].clone()));
    assert_eq!(resumed, Some((json!("thread/resume"), json!("t-new"))));
}

#[test]
fn refuses_a_launch_over_a_server_before_the_channels_start_recording_nothing() {
    let f = fixture();
    let before = f.events();
    let refused = runtime().block_on(async { f.launching("k-2").await.unwrap() });
    assert_eq!(
        (refused.map(|r| r.agent_id), f.events()),
        (Err(AgentError::Unavailable(NO_CHANNEL.to_owned())), before)
    );
}

#[test]
fn records_the_version_its_server_answers_on_once_for_each_change() {
    let f = fixture();
    let versions = runtime().block_on(async {
        let _picked = f.picked_up().await;
        until("the version was recorded", || {
            !f.of("environment.harness_version").is_empty()
        })
        .await;
        for told in [None, Some("1.2.3"), Some("1.3.0")] {
            let told = Event::Version(told.map(str::to_owned));
            super::heard(&f.shared, HarnessId::Codex, told)
                .await
                .unwrap();
        }
        f.of("environment.harness_version")
    });
    assert_eq!(
        versions,
        [
            json!({ "harness": "codex", "version": "1.2.3", "previous": null }),
            json!({ "harness": "codex", "version": "1.3.0", "previous": "1.2.3" }),
        ]
    );
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn respawns_a_codex_agent_on_its_thread_resumed_over_the_channel() {
    bazhen_test_signal::require_sandbox().unwrap();
    let f = fixture();
    f.set("state = 'closed'");
    let resumed = runtime().block_on(async {
        let listener = f.started();
        let launched = f.launching("k-2");
        let mut server = f.handshaken(&listener).await;
        started_thread(&mut server, "t-new").await;
        let agent = within(LIMIT, launched).await.unwrap().unwrap().agent_id;
        let generation = f.exited(&agent).await;
        let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
        let respawn = RespawnAgentRequest {
            idempotency_key: "k-3".to_owned(),
            generation,
            theme: None,
        };
        let mut respawned = f.tracker.spawn(async move {
            let replaced = |_| -> BoxFuture<'static, ()> { Box::pin(async {}) };
            agents.respawn(agent.as_str(), &respawn, replaced).await
        });
        let asked = tokio::select! {
            asked = heard(&mut server) => asked,
            _ = &mut respawned => return None,
        };
        let thread = json!({ "id": asked["params"]["threadId"], "status": { "type": "idle" } });
        let resumed = json!({ "id": asked["id"], "result": { "thread": thread } });
        say(&mut server, resumed).await;
        within(LIMIT, respawned).await.unwrap().unwrap();
        Some((asked["method"].clone(), asked["params"]["threadId"].clone()))
    });
    assert_eq!(resumed, Some((json!("thread/resume"), json!("t-new"))));
}
