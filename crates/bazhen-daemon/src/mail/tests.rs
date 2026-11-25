use std::sync::Mutex as StdMutex;

use bazhen_harness::{
    ActivitySource, BoxFuture, Capabilities, ChannelPort, Output, RunError, RunPort,
};
use bazhen_protocol::agents::LaunchAgentRequest;
use serde_json::{Value, json};
use tokio_util::task::TaskTracker;

use super::*;
use crate::agents::{AgentsDeps, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::roles::Roles;
use crate::routes::Stop;
use crate::terminals::fake::Fake;
use crate::testing::stub_harness::{STUB_SESSION, StubHarness};
use crate::testing::{TempDir, paused};
use crate::tokens::AgentTokens;
use crate::writer::Thread;

/// A port nothing runs through: the stub's pushes never use it.
struct Port;

impl RunPort for Port {
    fn run<'a>(
        &'a self,
        _argv: &'a [String],
        _timeout: Duration,
    ) -> BoxFuture<'a, Result<Output, RunError>> {
        Box::pin(std::future::ready(Err(RunError {
            message: "the stub runs nothing".to_owned(),
        })))
    }
}

impl PushPort for Port {
    fn channel(&self) -> Option<&dyn ChannelPort> {
        None
    }
}

fn taking(delivery: Delivery) -> Capabilities {
    Capabilities {
        delivery,
        approvals: true,
        activity: ActivitySource::Hooks,
    }
}

/// Two agents launched on the fake runtime, the stub serving their harness, running.
struct Fixture {
    shared: Shared,
    tracker: TaskTracker,
    stub: StubHarness,
    to: AgentId,
    peer: AgentId,
    runtime: tokio::runtime::Runtime,
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

fn fixture(stub: StubHarness) -> Fixture {
    let dir = TempDir::new("mail");
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
    let tracker = TaskTracker::new();
    let agents = Arc::new(Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::new(Fake::default()),
        budget: Arc::new(budget),
        home: home.to_string_lossy().into_owned(),
        socket: "/run/b.sock".to_owned(),
        tracker: tracker.clone(),
        roles: Arc::new(Roles::new(None)),
        harnesses: stub.served_as(HarnessId::ClaudeCode),
        hook_built: true,
        turns: Arc::default(),
        tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
        prompts: prompts::daemon_prompts(&run, uid),
        login_shell: None,
        hooks: Arc::default(),
    }));
    let runtime = paused();
    let launch = |key: &str| {
        let request = LaunchAgentRequest {
            idempotency_key: key.to_owned(),
            harness: HarnessId::ClaudeCode,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: None,
            role: None,
            compact_window_tokens: None,
        };
        runtime.block_on(agents.launch(&request)).unwrap().agent_id
    };
    let (to, peer) = (launch("launch-1"), launch("launch-2"));
    let mut shared = Shared::new(&"f".repeat(64), Stop::default(), store)
        .with_hooks(Arc::clone(agents.hooks()))
        .with_agents(agents);
    shared.push = Some(PushTo(Arc::new(Port)));
    let f = Fixture {
        shared,
        tracker,
        stub,
        to,
        peer,
        runtime,
        _dir: dir,
        thread: Some(thread),
    };
    f.set_state(&f.to.clone(), "running");
    f.set_state(&f.peer.clone(), "running");
    f
}

impl Fixture {
    /// Sends `body` to `to` under `key`, as `caller`, and waits for any push it starts.
    fn send(&self, caller: Option<&AgentId>, to: &AgentId, key: &str, body: &str) -> (u16, Value) {
        let request = json!({ "idempotencyKey": key, "body": body }).to_string();
        let caller = axum::Extension(Caller(caller.cloned()));
        let response = self.runtime.block_on(async {
            let response = send(
                State(self.shared.clone()),
                Path(to.as_str().to_owned()),
                Some(caller),
                Bytes::from(request),
            )
            .await;
            self.tracker.close();
            self.tracker.wait().await;
            self.tracker.reopen();
            response
        });
        let status = response.status().as_u16();
        let bytes = self
            .runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Sets an agent's state as its row records it.
    fn set_state(&self, agent: &AgentId, state: &'static str) {
        let agent = agent.clone();
        self.runtime
            .block_on(self.shared.store.run(move |store| {
                store.write(|w| {
                    w.connection().execute(
                        "UPDATE agent_sessions SET state = ? WHERE id = ?",
                        (state, agent.as_str()),
                    )?;
                    Ok::<_, AppendError>(())
                })
            }))
            .unwrap()
            .unwrap();
    }

    /// Each mail event's type and payload, in order.
    fn mail(&self) -> Vec<(String, Value)> {
        let reader = self.shared.store.reader().unwrap();
        reader
            .reads()
            .events(0, 1000)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind.starts_with("mailbox."))
            .map(|e| (e.kind, serde_json::from_str(&e.payload).unwrap()))
            .collect()
    }

    fn queued(&self, body: &str) -> (String, Value) {
        (
            "mailbox.queued".to_owned(),
            json!({ "agentId": self.to.as_str(), "body": body }),
        )
    }
}

fn pull() -> StubHarness {
    StubHarness::new(taking(Delivery::Pull))
}

#[test]
fn queues_the_humans_mail_once_per_key_and_refuses_the_key_for_another_message() {
    let f = fixture(pull());
    let (first, again) = (
        f.send(None, &f.to, "k", "hello"),
        f.send(None, &f.to, "k", "hello"),
    );
    let other = f.send(None, &f.to, "k", "goodbye").0;
    assert_eq!(
        (first.0, first.1 == again.1, other, f.mail()),
        (200, true, 409, vec![f.queued("hello")])
    );
    assert!(first.1["messageId"].as_str().unwrap().starts_with("msg_"));
}

#[test]
fn wraps_an_agents_mail_in_a_line_naming_it_and_saying_how_to_answer() {
    let f = fixture(pull());
    let (status, _) = f.send(Some(&f.peer), &f.to, "k", "look at this");
    let [(kind, payload)] = f.mail().try_into().unwrap();
    let peer = f.peer.as_str();
    let reader = f.shared.store.reader().unwrap();
    let sender = reader.reads().sender(peer).unwrap().unwrap();
    let (name, cwd) = (sender.name, sender.cwd);
    assert_eq!(
        (status, kind, payload),
        (
            200,
            "mailbox.queued".to_owned(),
            json!({
                "agentId": f.to.as_str(),
                "from": peer,
                "body": format!(
                    "From {name} ({peer}, claude-code, {cwd}). If it needs an answer: bazhen \
                     agents send {peer} \"<answer>\"\n\nlook at this"
                ),
            })
        )
    );
}

#[test]
fn refuses_an_agents_mail_to_itself_from_a_closed_agent_or_past_the_limit() {
    let f = fixture(pull());
    let to_itself = f.send(Some(&f.peer), &f.peer, "k-1", "hi");
    let too_long = f.send(Some(&f.peer), &f.to, "k-2", &"x".repeat(20_000));
    f.set_state(&f.peer.clone(), "lost");
    let closed = f.send(Some(&f.peer), &f.to, "k-3", "hi");
    assert_eq!(
        (
            (to_itself.0, to_itself.1["error"].clone()),
            (too_long.0, too_long.1["error"].clone()),
            (closed.0, closed.1["message"].clone()),
            f.mail(),
        ),
        (
            (403, json!("forbidden")),
            (400, json!("invalid_request")),
            (404, json!(format!("no agent {} that is open", f.peer))),
            vec![],
        )
    );
}

#[test]
fn refuses_mail_for_an_agent_gone_or_whose_harness_takes_none_for_it_with_its_reason() {
    let answer = |stub: StubHarness, state: &'static str| {
        let f = fixture(stub);
        f.set_state(&f.to.clone(), state);
        let (status, body) = f.send(None, &f.to, "k", "hi");
        let to = f.to.as_str().to_owned();
        let message = body["message"].as_str().map(|m| m.replace(&to, "A"));
        (status, message, f.mail().len())
    };
    assert_eq!(
        [
            answer(pull(), "closed"),
            answer(StubHarness::new(taking(Delivery::None)), "running"),
            answer(pull().refusing_mail("bound to a Codex thread"), "running"),
        ],
        [
            (
                409,
                Some("agent A is closed and takes no mail".to_owned()),
                0
            ),
            (404, Some("no agent A that takes mail".to_owned()), 0),
            (
                404,
                Some("no agent A bound to a Codex thread".to_owned()),
                0
            ),
        ]
    );
}

fn push(answers: impl IntoIterator<Item = Pushed>) -> StubHarness {
    StubHarness::new(taking(Delivery::Push)).pushing(answers)
}

#[test]
fn pushes_mail_to_a_harness_that_takes_it_by_push_and_offers_it_to_no_hook() {
    let f = fixture(push([Pushed::Accepted { offline: true }]));
    let (_, sent) = f.send(None, &f.to, "k", "hello");
    let pushes = f.stub.pushes.lock().unwrap().clone();
    assert_eq!(
        (
            pushes
                .iter()
                .map(|p| (p.message_id.as_str(), p.body.as_str(), p.session.as_deref()))
                .collect::<Vec<_>>(),
            f.mail(),
        ),
        (
            vec![(
                sent["messageId"].as_str().unwrap(),
                "hello",
                Some(STUB_SESSION)
            )],
            vec![
                f.queued("hello"),
                ("mailbox.accepted".to_owned(), json!({ "offline": true })),
            ],
        )
    );
}

#[test]
fn gives_pushed_mail_up_after_three_failures_a_second_then_two_apart() {
    let failed = || Pushed::Failed {
        detail: "the server is gone".to_owned(),
    };
    let f = fixture(push([failed(), failed(), failed()]));
    f.send(None, &f.to, "k", "hello");
    let at: Vec<_> = f.stub.pushes.lock().unwrap().iter().map(|p| p.at).collect();
    let gaps: Vec<_> = at.windows(2).map(|w| w[1] - w[0]).collect();
    assert_eq!(
        (gaps, f.mail()),
        (
            vec![Duration::from_secs(1), Duration::from_secs(2)],
            vec![
                f.queued("hello"),
                (
                    "mailbox.undeliverable".to_owned(),
                    json!({ "reason": "gave_up" })
                ),
            ],
        )
    );
}

#[test]
fn leaves_pushed_mail_queued_when_the_harness_says_not_now_or_the_agent_still_starts() {
    let f = fixture(push([Pushed::NotNow]));
    f.send(None, &f.to, "k-1", "now");
    f.set_state(&f.to.clone(), "starting");
    f.send(None, &f.to, "k-2", "later");
    assert_eq!(
        (f.stub.pushes.lock().unwrap().len(), f.mail()),
        (1, vec![f.queued("now"), f.queued("later")])
    );
}
