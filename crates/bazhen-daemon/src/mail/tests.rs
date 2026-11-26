use std::sync::Mutex as StdMutex;

use bazhen_harness::{
    ActivitySource, BoxFuture, Capabilities, ChannelPort, Output, ReadySource, RunError, RunPort,
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

/// How long a test waits for what it waits on before it fails.
const DEADLINE: Duration = Duration::from_secs(10);

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

pub(crate) fn taking(delivery: Delivery) -> Capabilities {
    Capabilities {
        delivery,
        approvals: true,
        activity: ActivitySource::Hooks,
        ready: ReadySource::Hooks,
    }
}

/// Two agents launched on the fake runtime, the stub serving their harness, running.
pub(crate) struct Fixture {
    pub(crate) shared: Shared,
    tracker: TaskTracker,
    pub(crate) stub: StubHarness,
    pub(crate) to: AgentId,
    pub(crate) peer: AgentId,
    pub(crate) runtime: tokio::runtime::Runtime,
    /// What the agents' writes handed over, which `hand_over` delivers.
    handed: StdMutex<tokio::sync::mpsc::UnboundedReceiver<Queued>>,
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

pub(crate) fn fixture(stub: StubHarness) -> Fixture {
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
    let (handing, handed) = tokio::sync::mpsc::unbounded_channel();
    let agents = Arc::new(Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::new(Fake::default()),
        budget: Arc::new(budget),
        home: home.to_string_lossy().into_owned(),
        socket: "/run/b.sock".to_owned(),
        tracker: tracker.clone(),
        roles: Arc::new(Roles::new(None)),
        harnesses: Arc::new(stub.served_as(HarnessId::ClaudeCode)),
        hook_built: true,
        turns: Arc::default(),
        tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
        prompts: prompts::daemon_prompts(&run, uid),
        login_shell: None,
        hooks: Arc::default(),
        handing,
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
        handed: StdMutex::new(handed),
        _dir: dir,
        thread: Some(thread),
    };
    f.set_state(&f.to.clone(), "running");
    f.set_state(&f.peer.clone(), "running");
    f
}

impl Fixture {
    /// Sends `body` to `to` under `key`, as `caller`, and waits for any push it starts.
    pub(crate) fn send(
        &self,
        caller: Option<&AgentId>,
        to: &AgentId,
        key: &str,
        body: &str,
    ) -> (u16, Value) {
        let sent = self.send_to(caller, to.as_str(), key, body);
        self.settle();
        sent
    }

    /// Delivers what the agents' writes have handed over so far, and waits for the pushes that
    /// starts; answers what it delivered.
    pub(crate) fn hand_over(&self) -> Vec<Queued> {
        let mut handed = Vec::new();
        while let Ok(queued) = self.handed.lock().unwrap().try_recv() {
            handed.push(queued);
        }
        self.runtime.block_on(async {
            for queued in handed.clone() {
                deliver(&self.shared, queued).await;
            }
        });
        self.settle();
        handed
    }

    /// Waits for every push under way.
    pub(crate) fn settle(&self) {
        self.runtime.block_on(async {
            self.tracker.close();
            self.tracker.wait().await;
            self.tracker.reopen();
        });
    }

    /// Sends `body` to the agent the path `to` names, under `key`, as `caller`.
    fn send_to(&self, caller: Option<&AgentId>, to: &str, key: &str, body: &str) -> (u16, Value) {
        let request = json!({ "idempotencyKey": key, "body": body }).to_string();
        let caller = axum::Extension(Caller(caller.cloned()));
        let response = self.runtime.block_on(send(
            State(self.shared.clone()),
            Path(to.to_owned()),
            Some(caller),
            Bytes::from(request),
        ));
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
    pub(crate) fn set_state(&self, agent: &AgentId, state: &'static str) {
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
    pub(crate) fn mail(&self) -> Vec<(String, Value)> {
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

    pub(crate) fn queued(&self, body: &str) -> (String, Value) {
        (
            "mailbox.queued".to_owned(),
            json!({ "agentId": self.to.as_str(), "body": body }),
        )
    }
}

pub(crate) fn pull() -> StubHarness {
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

pub(crate) fn push(answers: impl IntoIterator<Item = Pushed>) -> StubHarness {
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

#[test]
fn sends_to_an_agent_its_path_names_by_id_or_live_name_and_refuses_one_it_names_none() {
    let f = fixture(pull());
    let reader = f.shared.store.reader().unwrap();
    let name = reader.reads().sender(f.to.as_str()).unwrap().unwrap().name;
    let answer = |to: &str, key: &str| {
        let (status, body) = f.send_to(None, to, key, "hi");
        (status, body["message"].clone())
    };
    let unknown = "agent_01900000000070008000000000000009";
    assert_eq!(
        [
            answer(&name, "k-1"),
            answer(unknown, "k-2"),
            answer("nobody", "k-3"),
        ],
        [
            (200, Value::Null),
            (404, json!(format!("no agent {unknown}"))),
            (404, json!("no agent nobody by that name")),
        ]
    );
}

#[test]
fn leaves_pushed_mail_queued_for_an_agent_that_starts_again_while_its_push_is_under_way() {
    let f = fixture(push([Pushed::Accepted { offline: false }]));
    let open = f.stub.holding_push();
    f.send_to(None, f.to.as_str(), "k", "hello");
    // The paused clock stands still while this yields, so the deadline is the wall clock's.
    let since = std::time::Instant::now();
    let started = || !f.stub.pushes.lock().unwrap().is_empty();
    f.runtime.block_on(async {
        while !started() && since.elapsed() < DEADLINE {
            tokio::task::yield_now().await;
        }
    });
    assert!(started(), "the push never started");
    f.set_state(&f.to.clone(), "starting");
    open.send(()).unwrap();
    f.settle();
    assert_eq!(
        (f.stub.pushes.lock().unwrap().len(), f.mail()),
        (1, vec![f.queued("hello")])
    );
}

#[test]
fn delivers_what_a_write_hands_over_in_the_order_handed_until_the_daemon_stops() {
    let accepted = Pushed::Accepted { offline: false };
    let f = fixture(push([accepted.clone(), accepted]));
    let (to, agents) = (f.to.clone(), Arc::clone(f.shared.agents.as_ref().unwrap()));
    let run = Arc::clone(&agents);
    let queued = f
        .runtime
        .block_on(f.shared.store.run(move |store| {
            store.write(|w| {
                let mut fresh = Vec::new();
                for body in ["one", "two"] {
                    queue(w, run.harnesses(), &to, body, None, &mut fresh)?;
                }
                Ok::<_, Sending>(fresh)
            })
        }))
        .unwrap()
        .unwrap();
    let (handing, handed) = mpsc::unbounded_channel();
    for queued in queued {
        handing.send(queued).unwrap();
    }
    let stop = CancellationToken::new();
    let drain = f
        .runtime
        .spawn(hand_over(f.shared.clone(), handed, stop.clone()));
    let pushed = || f.stub.pushes.lock().unwrap().len();
    f.runtime.block_on(async {
        let waited = tokio::time::Instant::now();
        while pushed() < 2 && waited.elapsed() < DEADLINE {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        stop.cancel();
        drain.await.unwrap();
    });
    let bodies: Vec<String> = f
        .stub
        .pushes
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.body.clone())
        .collect();
    assert_eq!(bodies, ["one", "two"]);
}

#[test]
fn delivers_what_was_handed_over_before_the_daemon_stopped() {
    let accepted = Pushed::Accepted { offline: false };
    let f = fixture(push([accepted.clone(), accepted]));
    let (to, agents) = (f.to.clone(), Arc::clone(f.shared.agents.as_ref().unwrap()));
    let run = Arc::clone(&agents);
    let queued = f
        .runtime
        .block_on(f.shared.store.run(move |store| {
            store.write(|w| {
                let mut fresh = Vec::new();
                for body in ["one", "two"] {
                    queue(w, run.harnesses(), &to, body, None, &mut fresh)?;
                }
                Ok::<_, Sending>(fresh)
            })
        }))
        .unwrap()
        .unwrap();
    let (handing, handed) = mpsc::unbounded_channel();
    for queued in queued {
        handing.send(queued).unwrap();
    }
    let stop = CancellationToken::new();
    stop.cancel();
    let pushed = || f.stub.pushes.lock().unwrap().len();
    f.runtime.block_on(async {
        hand_over(f.shared.clone(), handed, stop).await;
        let waited = tokio::time::Instant::now();
        while pushed() < 2 && waited.elapsed() < DEADLINE {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let bodies: Vec<String> = f
        .stub
        .pushes
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.body.clone())
        .collect();
    assert_eq!(bodies, ["one", "two"]);
}

impl Fixture {
    /// The bodies of the mail handed to the stub to push, in order.
    fn pushed(&self) -> Vec<String> {
        self.stub
            .pushes
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.body.clone())
            .collect()
    }
}

#[test]
fn pushes_an_agents_queued_mail_oldest_first_once_it_is_asked_to() {
    let accepted = || Pushed::Accepted { offline: false };
    let f = fixture(push([accepted(), accepted()]));
    f.set_state(&f.to.clone(), "starting");
    f.send(None, &f.to, "k-1", "first");
    f.send(None, &f.to, "k-2", "second");
    let before = f.pushed();
    f.set_state(&f.to.clone(), "running");
    f.runtime.block_on(async { push_queued(&f.shared, &f.to) });
    f.settle();
    assert_eq!(
        (before, f.pushed()),
        (
            Vec::<String>::new(),
            vec!["first".to_owned(), "second".to_owned()]
        )
    );
}

#[test]
fn pushes_mail_sent_while_its_agents_mail_is_pushed_once_each_in_the_order_sent() {
    let accepted = || Pushed::Accepted { offline: false };
    let f = fixture(push([accepted(), accepted(), accepted()]));
    let open = f.stub.holding_push();
    f.send_to(None, f.to.as_str(), "k-1", "first");
    // The paused clock stands still while this yields, so the deadline is the wall clock's.
    let since = std::time::Instant::now();
    let started = || !f.stub.pushes.lock().unwrap().is_empty();
    f.runtime.block_on(async {
        while !started() && since.elapsed() < DEADLINE {
            tokio::task::yield_now().await;
        }
    });
    assert!(started(), "the push never started");
    f.send_to(None, f.to.as_str(), "k-2", "second");
    f.send_to(None, f.to.as_str(), "k-3", "third");
    open.send(()).unwrap();
    f.settle();
    assert_eq!(f.pushed(), ["first", "second", "third"].map(str::to_owned));
}

#[test]
fn pushes_none_of_an_agents_later_mail_once_its_harness_cant_take_mail_now() {
    let f = fixture(push([Pushed::NotNow]));
    f.set_state(&f.to.clone(), "starting");
    f.send(None, &f.to, "k-1", "first");
    f.send(None, &f.to, "k-2", "second");
    f.set_state(&f.to.clone(), "running");
    f.runtime.block_on(async { push_queued(&f.shared, &f.to) });
    f.settle();
    assert_eq!(
        (f.pushed(), f.mail()),
        (
            vec!["first".to_owned()],
            vec![f.queued("first"), f.queued("second")]
        )
    );
}
