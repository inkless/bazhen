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
    ActivityValue, ExitStatus, LaunchAgentRequest, LaunchAgentResponse, RelaunchAgentRequest,
    RespawnAgentRequest, UsageLimit,
};
use bazhen_protocol::ids::MessageId;
use bazhen_protocol::mail::MailboxState;
use bazhen_protocol::mail_events::MailAccepted;
use bazhen_store::{AgentChange, AppendError, MailChange, NewEvent};
use serde_json::{Value, json};
use tokio::net::UnixListener;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use super::*;
use crate::agents::{AgentError, Agents, AgentsDeps, NO_CHANNEL, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::channel::rpc::RequestId;
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

/// A first wait to connect again longer than any here, so a channel connects again in a test
/// only when asked to.
const NEVER: Duration = Duration::from_secs(600);

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
    dir: TempDir,
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
        handing: tokio::sync::mpsc::unbounded_channel().0,
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
        dir,
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
        self.set_on(&self.agent, assignment);
    }

    /// Sets `agent`'s row as `assignment` says.
    fn set_on(&self, agent: &AgentId, assignment: &str) {
        let (agent, sql) = (
            agent.clone(),
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

    /// Another agent, launched as the fixture's was, on the same session, and running.
    fn launched(&self, key: &str, name: &str) -> AgentId {
        let launcher = agents_over(
            &self.shared.store,
            &self.dir,
            StubHarness::new(pull()).served_as(HarnessId::Codex),
            &self.shared.hooks,
            Arc::new(Fake::default()),
        );
        let agent = runtime()
            .block_on(launcher.launch(&LaunchAgentRequest {
                idempotency_key: key.to_owned(),
                harness: HarnessId::Codex,
                cwd: "~/repo".to_owned(),
                project: None,
                theme: None,
                name: Some(bazhen_protocol::names::AgentName::parse(name).unwrap()),
                role: None,
                compact_window_tokens: None,
            }))
            .unwrap()
            .agent_id;
        self.set_on(&agent, "state = 'running'");
        agent
    }

    /// A message queued for `agent`, which Codex holds already when `in_codex`.
    fn queued(&self, agent: &AgentId, in_codex: bool) -> MessageId {
        let agent = agent.clone();
        runtime()
            .block_on(self.shared.store.run(move |store| {
                store.write(|w| {
                    let (message, _) = w.queue_mail(&agent, "hello", None)?;
                    if in_codex {
                        let accepted = MailAccepted { offline: false };
                        w.mail_step(&message, MailChange::Accepted(accepted))?;
                    }
                    Ok::<_, AppendError>(message)
                })
            }))
            .unwrap()
            .unwrap()
    }

    fn state_of(&self, message: &MessageId) -> MailboxState {
        let reader = self.shared.store.reader().unwrap();
        let message = reader.reads().message(message.as_str()).unwrap();
        message.unwrap().state
    }

    /// The usage limits `agent`'s usage holds.
    fn limits_of(&self, agent: &AgentId) -> Option<Vec<UsageLimit>> {
        let reader = self.shared.store.reader().unwrap();
        let usage = reader.reads().agent_usage(agent.as_str()).unwrap();
        usage.and_then(|usage| usage.limits)
    }

    /// Applies `told` as one report of the Codex server's, routed as `routed` says.
    fn told(&self, told: Vec<Keyed>, routed: Option<(&SessionKey, Option<&AgentId>)>) {
        self.try_told(told, routed).unwrap();
    }

    fn try_told(
        &self,
        told: Vec<Keyed>,
        routed: Option<(&SessionKey, Option<&AgentId>)>,
    ) -> Result<(), String> {
        runtime()
            .block_on(
                self.shared
                    .hooks
                    .channel(&self.shared, HarnessId::Codex, told, routed),
            )
            .map(drop)
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

    /// Whether the channel to Codex's server has no connection up.
    fn unconnected(&self) -> bool {
        let agents = self.shared.agents.as_ref().unwrap();
        !agents.channel(HarnessId::Codex).unwrap().unwrap().up()
    }

    /// `agent`'s process exited, as its terminal and the store show it; its generation.
    async fn exited(&self, agent: &AgentId) -> u64 {
        let exited = AgentChange::Exited(AgentExited {
            exit: ExitStatus::Unknown,
        });
        self.ended(agent, Fake::exit_unseen, exited).await
    }

    /// `agent`'s terminal lost, as its terminal and the store show it; its generation.
    async fn lost(&self, agent: &AgentId) -> u64 {
        self.ended(agent, Fake::gone, AgentChange::Lost).await
    }

    /// `agent`'s terminal ended as `end` ends it, and recorded as `change` says; its generation.
    async fn ended(&self, agent: &AgentId, end: fn(&Fake, &str), change: AgentChange) -> u64 {
        let reader = self.shared.store.reader().unwrap();
        let found = reader
            .reads()
            .agent_terminal(agent.as_str())
            .unwrap()
            .unwrap();
        end(&self.fake, found.terminal_id.as_ref().unwrap().as_str());
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

    /// The agent's session moved to `session`, as a reconcile or a restart records it.
    async fn moved_to(&self, session: &str) {
        let (agent, session) = (self.agent.clone(), session.to_owned());
        let store = &self.shared.store;
        store
            .run(move |store| {
                store.write(|w| {
                    let external_ref = bazhen_protocol::agents::ExternalRef {
                        environment_id: w.local_environment()?,
                        kind: bazhen_protocol::agents::ExternalRefKind::CodexThread,
                        id: session,
                    };
                    w.append(&NewEvent::Agent {
                        agent,
                        actor: "system".to_owned(),
                        change: AgentChange::ExternalRefUpdated(
                            bazhen_protocol::agent_events::AgentExternalRefUpdated { external_ref },
                        ),
                    })
                })
            })
            .await
            .unwrap()
            .unwrap();
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

    /// The open items of the agent, oldest first.
    fn items(&self) -> Vec<String> {
        let reader = self.shared.store.reader().unwrap();
        let open = reader.reads().open_attention(self.agent.as_str()).unwrap();
        open.into_iter()
            .map(|item| item.id.as_str().to_owned())
            .collect()
    }

    /// The reasons the items closed for, oldest first.
    fn closed(&self) -> Vec<Value> {
        let closed = self.of("attention.closed");
        closed
            .iter()
            .map(|closed| closed["reason"].clone())
            .collect()
    }

    /// Applies `event` as the channel tells it.
    fn heard(&self, event: Event) {
        runtime()
            .block_on(super::heard(&self.shared, HarnessId::Codex, event))
            .unwrap();
    }

    /// Listens where the Codex home's server would, and starts the channels to it.
    fn started(&self) -> UnixListener {
        self.started_retrying(FIRST_RETRY)
    }

    /// The same, each channel first waiting `first_retry` to connect again once a connection
    /// ends.
    fn started_retrying(&self, first_retry: Duration) -> UnixListener {
        let socket = self
            .codex_home
            .join("app-server-control/app-server-control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let commands = Arc::new(Commands::new(crate::env::Env::new()));
        start_retrying(
            &self.shared,
            &commands,
            &self.tracker,
            &self.stop,
            first_retry,
        );
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
        self.pickup(&listener, &[]).await
    }

    /// The server's side of the next connection to `listener`, once its handshake and the pickup
    /// of the agent's session are answered, the server sending `first` before it answers the
    /// pickup: the pickup's params.
    async fn pickup(&self, listener: &UnixListener, first: &[Value]) -> (Server, Value) {
        let mut server = self.handshaken(listener).await;
        let resume = heard(&mut server).await;
        assert_eq!(resume["method"], "thread/resume", "{resume}");
        for message in first {
            say(&mut server, message.clone()).await;
        }
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

/// How long a server hears nothing before it is taken that nothing was sent.
const QUIET: Duration = Duration::from_millis(200);

/// A connection of the daemon's to a server of the test's, as a channel's would be, and the
/// server's side of it.
async fn connection(f: &Fixture) -> (Rpc, crate::channel::rpc::Inbox, Server, TempDir) {
    let dir = TempDir::short("on");
    let socket = dir.path().join("server.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (connected, server) = tokio::join!(
        crate::channel::rpc::connect(&socket, &f.tracker, f.stop.clone()),
        accepted(&listener)
    );
    let (on, inbox) = connected.unwrap();
    (on, inbox, server, dir)
}

/// Waits until the open items offer `offered`, as each is held once its item is opened, failing
/// the test if they never do.
async fn offering(f: &Fixture, offered: &[Value]) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    let mut now = actions(f).await;
    while now != offered && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
        now = actions(f).await;
    }
    assert_eq!(now, offered);
}

/// The next message the daemon sends the server.
async fn frame(server: &mut Server) -> Value {
    within(LIMIT, heard(server)).await
}

/// The server's request `id` to approve the command the call `call` runs on the agent's session.
fn approval(id: u64, call: &str) -> Value {
    let params = json!({ "threadId": STUB_SESSION, "itemId": call, "command": "ls" });
    json!({ "id": id, "method": "item/commandExecution/requestApproval", "params": params })
}

/// What the daemon answers the approval `id` with for `decision`.
fn decided(id: u64, decision: &str) -> Value {
    json!({ "id": id, "result": { "decision": decision } })
}

/// The status of the human's `decision` on the item `id`, under `key`.
async fn decide(f: &Fixture, id: &str, key: &str, decision: &str) -> u16 {
    let body = json!({ "idempotencyKey": key, "decision": decision }).to_string();
    let response = crate::attention::answer(
        State(f.shared.clone()),
        Path(id.to_owned()),
        None,
        Bytes::from(body),
    )
    .await;
    response.status().as_u16()
}

/// The status and body of the reply `text` to the item `id`, from `caller`, or the human.
async fn reply(f: &Fixture, id: &str, caller: Option<&AgentId>, text: &str) -> (u16, Value) {
    let caller = caller.map(|agent| axum::Extension(crate::callers::Caller(Some(agent.clone()))));
    let body = json!({ "idempotencyKey": "reply-1", "body": text }).to_string();
    let response = crate::attention::reply(
        State(f.shared.clone()),
        Path(id.to_owned()),
        caller,
        Bytes::from(body),
    )
    .await;
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The server's request `id` asking the human one question in their own words.
fn user_input(id: u64) -> Value {
    let question = json!({ "id": "q-1", "question": "Which branch?" });
    let params = json!({ "threadId": STUB_SESSION, "itemId": "ask-1", "questions": [question] });
    json!({ "id": id, "method": "item/tool/requestUserInput", "params": params })
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

/// The human's answer goes to the request on the connection it came on, and the TUI hearing it
/// too settles nothing more.
#[test]
fn answers_an_approval_its_server_asks_on_the_connection_it_came_on() {
    let f = fixture();
    let (offered, answered, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, approval(7, "call-1")).await;
        offering(&f, &[json!(["allow", "deny"])]).await;
        let offered = actions(&f).await;
        let answered = decide(&f, &f.items()[0], "answer-1", "allow").await;
        let sent = frame(&mut server).await;
        let resolved = json!({ "threadId": STUB_SESSION, "requestId": 7 });
        say(
            &mut server,
            notification("serverRequest/resolved", &resolved),
        )
        .await;
        // Told in order, so the resolution is done with once the turn is recorded.
        let turn =
            json!({ "threadId": STUB_SESSION, "turn": { "id": "u-1", "status": "inProgress" } });
        say(&mut server, notification("turn/started", &turn)).await;
        until("the turn was recorded", || {
            f.activity() == Some(ActivityValue::Working)
        })
        .await;
        (offered, answered, sent)
    });
    assert_eq!(
        (offered, answered, sent),
        (vec![json!(["allow", "deny"])], 200, decided(7, "accept"))
    );
    assert_eq!(
        (f.open_items(), f.of("attention.answered"), f.closed()),
        (0, vec![json!({ "decision": "allow" })], vec![])
    );
}

/// A request its server asks again holds nothing of the one it held until it is held itself: an
/// answer in between is refused, never sent for a request the server may no longer wait on.
#[test]
fn answers_nothing_between_a_request_asked_again_and_its_hold() {
    let f = fixture();
    let (answered, sent) = runtime().block_on(async {
        let (mut first, _) = f.picked_up().await;
        say(&mut first, approval(7, "call-1")).await;
        offering(&f, &[json!(["allow", "deny"])]).await;
        let (on, _inbox, mut second, _dir) = connection(&f).await;
        let asked_again = approval(8, "call-1");
        let message = Inbound::Request {
            id: RequestId::Number(8.into()),
            method: asked_again["method"].as_str().unwrap().to_owned(),
            params: Some(asked_again["params"].clone()),
        };
        let (opened, hold) = super::asked(&f.shared, HarnessId::Codex, message, on)
            .await
            .unwrap()
            .unwrap();
        let between = (
            actions(&f).await,
            decide(&f, opened.as_str(), "answer-1", "allow").await,
        );
        assert_eq!(between, (vec![json!([])], 409));
        f.shared
            .hooks
            .approvals
            .hold(&opened, Responder::Server(hold));
        let answered = decide(&f, opened.as_str(), "answer-2", "allow").await;
        (answered, frame(&mut second).await)
    });
    assert_eq!((answered, sent), (200, decided(8, "accept")));
}

/// Each request is answered once: by the first key that answers its item, again by that key
/// without a second answer, and never by another.
#[test]
fn answers_each_request_its_server_asks_once() {
    let f = fixture();
    let (answered, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, approval(7, "call-1")).await;
        say(&mut server, approval(8, "call-2")).await;
        let held = json!(["allow", "deny"]);
        offering(&f, &[held.clone(), held]).await;
        let items = f.items();
        let answered = [
            decide(&f, &items[0], "answer-1", "allow").await,
            decide(&f, &items[0], "answer-2", "deny").await,
            decide(&f, &items[0], "answer-1", "allow").await,
            decide(&f, &items[1], "answer-3", "deny").await,
        ];
        (
            answered,
            [frame(&mut server).await, frame(&mut server).await],
        )
    });
    assert_eq!(answered, [200, 409, 200, 200]);
    assert_eq!(sent, [decided(7, "accept"), decided(8, "decline")]);
}

/// A request the TUI answered first is answered by nothing the human sends after, its item
/// settled by the request, though no agent is on its thread now.
#[test]
fn answers_nothing_the_tui_answered_first() {
    let f = fixture();
    let (answered, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, approval(7, "call-1")).await;
        say(&mut server, approval(8, "call-2")).await;
        let held = json!(["allow", "deny"]);
        offering(&f, &[held.clone(), held]).await;
        let items = f.items();
        f.moved_to("elsewhere").await;
        let resolved = json!({ "threadId": STUB_SESSION, "requestId": 7 });
        say(
            &mut server,
            notification("serverRequest/resolved", &resolved),
        )
        .await;
        offering(&f, &[json!(["allow", "deny"])]).await;
        let answered = [
            decide(&f, &items[0], "answer-1", "allow").await,
            decide(&f, &items[1], "answer-2", "allow").await,
        ];
        (answered, frame(&mut server).await)
    });
    assert_eq!(
        (answered, sent, f.closed()),
        (
            [409, 200],
            decided(8, "accept"),
            vec![json!("answered_in_tui")]
        )
    );
}

/// A request is answered only on the connection it came on: once that ends, its item offers
/// nothing until the server asks it again on the next, whose request the answer goes to; one it
/// doesn't ask again is stale.
#[test]
fn answers_a_request_on_the_connection_its_server_asked_it_on_last() {
    let f = fixture();
    let (gone, again, answered, sent) = runtime().block_on(async {
        let listener = f.started();
        let (mut server, _) = f.pickup(&listener, &[]).await;
        say(&mut server, approval(7, "call-1")).await;
        say(&mut server, approval(8, "call-2")).await;
        let held = json!(["allow", "deny"]);
        offering(&f, &[held.clone(), held]).await;
        let items = f.items();
        drop(server);
        offering(&f, &[json!([]), json!([])]).await;
        let gone = decide(&f, &items[0], "answer-1", "allow").await;
        let (mut server, _) = f.pickup(&listener, &[approval(12, "call-1")]).await;
        offering(&f, &[json!(["allow", "deny"])]).await;
        let again = (f.items() == items[..1], actions(&f).await);
        let answered = decide(&f, &items[0], "answer-2", "allow").await;
        (gone, again, answered, frame(&mut server).await)
    });
    assert_eq!(gone, 409);
    assert_eq!(again, (true, vec![json!(["allow", "deny"])]));
    assert_eq!((answered, sent), (200, decided(12, "accept")));
    assert_eq!(
        (f.of("attention.opened").len(), f.closed()),
        (2, vec![json!("stale")])
    );
}

/// The server asks again each request it still holds once a new connection is up, so the
/// pickup of a session on the same connection stales nothing.
#[test]
fn stales_nothing_its_server_asked_on_the_connection_still_up() {
    let f = fixture();
    let session = SessionKey(STUB_SESSION.to_owned());
    f.told(
        vec![on_thread(STUB_SESSION, asked("call-1"))],
        Some((&session, Some(&f.agent))),
    );
    f.heard(Event::Connected(vec![]));
    let kept = f.open_items();
    f.heard(Event::Disconnected(vec![]));
    f.heard(Event::Connected(vec![]));
    assert_eq!(
        (kept, f.open_items(), f.closed()),
        (1, 0, vec![json!("stale")])
    );
}

fn question(call: &str) -> Observed {
    Observed::QuestionAsked {
        key: ToolKey {
            key: call.to_owned(),
            caller: None,
            prompt_id: None,
        },
        summary: "Pick one".to_owned(),
    }
}

/// A question only the TUI can answer is one item however often its server asks it, and stale
/// once a new connection is up without it.
#[test]
fn opens_a_question_its_server_asks_again_once_and_stales_one_it_does_not() {
    let f = fixture();
    let session = SessionKey(STUB_SESSION.to_owned());
    let routed = Some((&session, Some(&f.agent)));
    let asks = |calls: &[&str]| {
        let told = calls
            .iter()
            .map(|call| on_thread(STUB_SESSION, question(call)));
        f.told(told.collect(), routed);
    };
    asks(&["ask-1", "ask-2"]);
    f.heard(Event::Disconnected(vec![]));
    asks(&["ask-1"]);
    f.heard(Event::Connected(vec![]));
    assert_eq!(
        (f.of("attention.opened").len(), f.open_items(), f.closed()),
        (2, 1, vec![json!("stale")])
    );
}

/// A request its server asks again where it can't be routed, as on a session two agents are on,
/// leaves the item it opened to go stale.
#[test]
fn stales_an_approval_its_server_asks_again_on_a_session_two_agents_are_on() {
    let f = fixture();
    let session = SessionKey(STUB_SESSION.to_owned());
    f.told(
        vec![on_thread(STUB_SESSION, asked("call-1"))],
        Some((&session, Some(&f.agent))),
    );
    f.launched("k-2", "two");
    f.heard(Event::Disconnected(vec![]));
    f.told(
        vec![on_thread(STUB_SESSION, asked("call-1"))],
        Some((&session, None)),
    );
    f.heard(Event::Connected(vec![]));
    assert_eq!(
        (f.of("attention.opened").len(), f.open_items(), f.closed()),
        (1, 0, vec![json!("stale")])
    );
}

/// A request its server asks again on the same connection, where it can't be routed, as on a
/// session two agents are on, holds nothing of the one it held: the server may no longer answer
/// that one, so the human's answer is refused, and nothing is sent.
#[test]
fn answers_nothing_for_a_request_asked_again_on_its_connection_where_it_cant_be_routed() {
    let f = fixture();
    let session = SessionKey(STUB_SESSION.to_owned());
    // Under the key Codex gives the call on its thread, as the request asked again names it.
    let first_asked = Observed::ApprovalAsked {
        key: ToolKey {
            key: json!([STUB_SESSION, "call-1"]).to_string(),
            caller: None,
            prompt_id: None,
        },
        summary: "Run ls".to_owned(),
        question: false,
    };
    f.told(
        vec![on_thread(STUB_SESSION, first_asked)],
        Some((&session, Some(&f.agent))),
    );
    f.launched("k-2", "two");
    let (answered, sent) = runtime().block_on(async {
        let (on, _inbox, mut server, _dir) = connection(&f).await;
        let item = f.items().remove(0);
        let first = approval(7, "call-1");
        let held = ServerHold {
            on: on.clone(),
            id: RequestId::Number(7.into()),
            method: first["method"].as_str().unwrap().to_owned(),
        };
        f.shared
            .hooks
            .approvals
            .hold(&AttentionId::parse(&item).unwrap(), Responder::Server(held));
        let again = approval(8, "call-1");
        let message = Inbound::Request {
            id: RequestId::Number(8.into()),
            method: again["method"].as_str().unwrap().to_owned(),
            params: Some(again["params"].clone()),
        };
        // Kept open, as the channel keeps it, so that nothing heard is nothing sent.
        let _open = on.clone();
        super::inbound(&f.shared, HarnessId::Codex, message, on)
            .await
            .unwrap();
        let answered = decide(&f, &item, "answer-1", "allow").await;
        let sent = tokio::time::timeout(QUIET, heard(&mut server)).await.ok();
        (answered, sent)
    });
    assert_eq!((answered, sent), (409, None));
    assert_eq!((f.of("attention.opened").len(), f.open_items()), (1, 1));
}

/// A reply to a question its server asks is that request's answer, the human's text, and no
/// mail.
#[test]
fn answers_a_question_its_server_asks_with_the_humans_text() {
    let f = fixture();
    let (offered, replied, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, user_input(11)).await;
        offering(&f, &[json!(["reply"])]).await;
        let offered = actions(&f).await;
        let replied = reply(&f, &f.items()[0], None, "main").await;
        (offered, replied, frame(&mut server).await)
    });
    let answers = json!({ "q-1": { "answers": ["main"] } });
    assert_eq!(
        (offered, replied.0, &replied.1["messageId"], sent),
        (
            vec![json!(["reply"])],
            200,
            &Value::Null,
            json!({ "id": 11, "result": { "answers": answers } })
        )
    );
    assert_eq!(
        (f.closed(), f.of("mailbox.queued")),
        (vec![json!("replied")], vec![])
    );
}

/// A reply its harness can no longer answer is refused and undone: the item stays open, nothing
/// is sent, and nothing is recorded closed.
#[test]
fn keeps_a_question_open_and_sends_nothing_when_its_harness_cant_answer_it() {
    let f = fixture();
    let (replied, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, user_input(11)).await;
        offering(&f, &[json!(["reply"])]).await;
        // Told of a thread no agent is on, the harness lets go of what it held there.
        f.moved_to("elsewhere").await;
        let (on, _inbox, _other, _dir) = connection(&f).await;
        let turn = Inbound::Notification {
            method: "turn/started".to_owned(),
            params: Some(json!({ "threadId": STUB_SESSION, "turn": { "id": "u-1" } })),
        };
        super::asked(&f.shared, HarnessId::Codex, turn, on)
            .await
            .unwrap();
        f.moved_to(STUB_SESSION).await;
        let replied = reply(&f, &f.items()[0], None, "main").await.0;
        let sent = tokio::time::timeout(QUIET, heard(&mut server)).await.ok();
        (replied, sent)
    });
    assert_eq!((replied, sent), (409, None));
    assert_eq!(
        (f.open_items(), f.closed(), f.of("mailbox.queued")),
        (1, vec![], vec![])
    );
}

/// An agent can't answer a question its server asks, as it can't an approval: only the human.
#[test]
fn refuses_an_agents_reply_to_a_question_its_server_asks() {
    let f = fixture();
    let (refused, replied, sent) = runtime().block_on(async {
        let (mut server, _) = f.picked_up().await;
        say(&mut server, user_input(11)).await;
        offering(&f, &[json!(["reply"])]).await;
        let id = f.items()[0].clone();
        let refused = reply(&f, &id, Some(&f.agent), "yes").await.0;
        let replied = reply(&f, &id, None, "main").await.0;
        (refused, replied, frame(&mut server).await)
    });
    let answers = json!({ "q-1": { "answers": ["main"] } });
    assert_eq!(
        (refused, replied, sent),
        (
            403,
            200,
            json!({ "id": 11, "result": { "answers": answers } })
        )
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
                .channel(&f.shared, HarnessId::Codex, told, None)
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
        // Never connecting again of its own accord, so only the launch can connect it.
        let listener = f.started_retrying(NEVER);
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
fn records_no_more_than_the_first_128_bytes_of_the_version_its_server_names() {
    let f = fixture();
    // Two bytes each, so the 128th byte ends one.
    let named = "\u{e9}".repeat(100);
    let versions = runtime().block_on(async {
        let told = Event::Version(Some(named.clone()));
        super::heard(&f.shared, HarnessId::Codex, told)
            .await
            .unwrap();
        f.of("environment.harness_version")
    });
    let recorded: Vec<_> = versions.iter().map(|v| v["version"].clone()).collect();
    assert_eq!(recorded, [json!("\u{e9}".repeat(64))]);
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

#[test]
fn relaunches_a_lost_codex_agent_on_its_thread_resumed_over_the_channel() {
    let f = fixture();
    f.set("state = 'closed'");
    let resumed = runtime().block_on(async {
        let listener = f.started();
        let launched = f.launching("k-2");
        let mut server = f.handshaken(&listener).await;
        started_thread(&mut server, "t-new").await;
        let agent = within(LIMIT, launched).await.unwrap().unwrap().agent_id;
        let generation = f.lost(&agent).await;
        let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
        let relaunch = RelaunchAgentRequest {
            idempotency_key: "k-3".to_owned(),
            generation,
            theme: None,
            fresh: None,
        };
        let mut relaunched = f.tracker.spawn(async move {
            let replaced = |_| -> BoxFuture<'static, ()> { Box::pin(async {}) };
            agents.relaunch(agent.as_str(), &relaunch, replaced).await
        });
        let asked = tokio::select! {
            asked = heard(&mut server) => asked,
            _ = &mut relaunched => return None,
        };
        let thread = json!({ "id": asked["params"]["threadId"], "status": { "type": "idle" } });
        let resumed = json!({ "id": asked["id"], "result": { "thread": thread } });
        say(&mut server, resumed).await;
        within(LIMIT, relaunched).await.unwrap().unwrap();
        Some((asked["method"].clone(), asked["params"]["threadId"].clone()))
    });
    assert_eq!(resumed, Some((json!("thread/resume"), json!("t-new"))));
}

fn on_thread(thread: &str, fact: Observed) -> Keyed {
    Keyed {
        key: Key::Session(SessionKey(thread.to_owned())),
        gate: Gate::None,
        fact,
    }
}

fn asked(call: &str) -> Observed {
    Observed::ApprovalAsked {
        key: ToolKey {
            key: call.to_owned(),
            caller: None,
            prompt_id: None,
        },
        summary: "Run ls".to_owned(),
        question: false,
    }
}

fn taken(message: &MessageId) -> Observed {
    Observed::MailTaken {
        message_id: message.as_str().to_owned(),
    }
}

/// A report's facts of the session it was routed to go to the agent it was routed to, read once:
/// not to the agent the session is bound to when each is applied, nor to one bound since.
#[test]
fn applies_the_facts_of_the_session_a_report_was_routed_to_to_the_agent_it_was_routed_to() {
    let f = fixture();
    let session = SessionKey(STUB_SESSION.to_owned());
    // Moved off the session since the report was routed to it.
    f.set("external_ref = json_set(external_ref, '$.id', 't-moved')");
    f.told(
        vec![on_thread(STUB_SESSION, asked("call-1"))],
        Some((&session, Some(&f.agent))),
    );
    let routed = f.open_items();
    // Bound to it since the report was routed to no agent.
    f.set("external_ref = json_set(external_ref, '$.id', 'stub-session-1')");
    f.told(
        vec![on_thread(STUB_SESSION, asked("call-2"))],
        Some((&session, None)),
    );
    assert_eq!((routed, f.open_items()), (1, 1));
}

/// An update of the account's limits goes to every agent the server serves, a starting one and
/// two on one session alike, and to none it doesn't, one bound to no session of its.
#[test]
fn gives_the_accounts_limits_to_every_agent_its_server_serves() {
    let f = fixture();
    let (bob, carol, dan) = (
        f.launched("k-2", "bob"),
        f.launched("k-3", "carol"),
        f.launched("k-4", "dan"),
    );
    f.set_on(&carol, "state = 'starting'");
    f.set_on(&dan, "external_ref = NULL");
    let spent = UsageLimit {
        window: "codex.primary".to_owned(),
        used_percent: 12.0,
        resets_at: Some("2025-11-13T03:13:20.000Z".to_owned()),
    };
    let update = Keyed {
        key: Key::Account,
        gate: Gate::None,
        fact: Observed::AccountLimits(vec![spent.clone()]),
    };
    f.told(vec![update], None);
    let got = [&f.agent, &bob, &carol, &dan].map(|agent| f.limits_of(agent));
    let given = Some(vec![spent]);
    assert_eq!(got, [given.clone(), given.clone(), given, None]);
}

/// A message a turn took is confirmed by the message: on the session its agent alone is on, or on
/// one no agent is on once Codex held it. Not on one another agent is on, or two are, nor one
/// queued for an agent gone or of another harness, and one confirmed already is left so.
#[test]
fn confirms_a_message_a_turn_took_where_its_agent_alone_could_have_taken_it() {
    let f = fixture();
    let bob = f.launched("k-2", "bob");
    let carol = f.launched("k-3", "carol");
    f.set_on(
        &bob,
        "external_ref = json_set(external_ref, '$.id', 't-bob')",
    );
    f.set_on(
        &carol,
        "external_ref = json_set(external_ref, '$.id', 't-carol')",
    );
    let own = f.queued(&f.agent, false);
    let held_off = f.queued(&f.agent, true);
    let queued_off = f.queued(&f.agent, false);
    let bobs = f.queued(&bob, true);
    let gone = f.queued(&carol, true);
    f.set_on(&carol, "state = 'exited'");
    let elsewhere = f.queued(&bob, true);
    let shared = f.queued(&f.agent, true);
    f.told(
        vec![
            on_thread(STUB_SESSION, taken(&own)),
            on_thread("t-none", taken(&held_off)),
            on_thread("t-none", taken(&queued_off)),
            on_thread(STUB_SESSION, taken(&bobs)),
            on_thread("t-none", taken(&gone)),
        ],
        None,
    );
    // Bob is of another harness now, with a message Codex held.
    f.set_on(&bob, "harness = 'claude-code'");
    f.told(vec![on_thread("t-none", taken(&elsewhere))], None);
    // Bob back on Codex, on the agent's session: two are on it.
    f.set_on(
        &bob,
        "harness = 'codex', external_ref = json_set(external_ref, '$.id', 'stub-session-1')",
    );
    f.told(vec![on_thread(STUB_SESSION, taken(&shared))], None);
    let states = [
        &own,
        &held_off,
        &queued_off,
        &bobs,
        &gone,
        &elsewhere,
        &shared,
    ]
    .map(|message| f.state_of(message));
    assert_eq!(
        states,
        [
            MailboxState::Delivered,
            MailboxState::Delivered,
            MailboxState::Queued,
            MailboxState::QueuedInCodex,
            MailboxState::QueuedInCodex,
            MailboxState::QueuedInCodex,
            MailboxState::QueuedInCodex
        ]
    );
}

/// A message taken again, confirmed already, is no error: the report's facts after it are applied.
#[test]
fn applies_the_facts_after_a_message_taken_again() {
    let f = fixture();
    let own = f.queued(&f.agent, false);
    f.told(vec![on_thread(STUB_SESSION, taken(&own))], None);
    let again = f.try_told(
        vec![
            on_thread(STUB_SESSION, taken(&own)),
            on_thread(STUB_SESSION, asked("call-1")),
        ],
        None,
    );
    assert_eq!(
        (again, f.state_of(&own), f.open_items()),
        (Ok(()), MailboxState::Delivered, 1)
    );
}
