use std::sync::Mutex as StdMutex;
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use bazhen_protocol::agents::{HarnessId, LaunchAgentRequest};
use bazhen_protocol::edge::edge;
use bazhen_protocol::mail::{HOOK_PROTOCOL_VERSION, HookAck, HookRequest};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::task::TaskTracker;

use super::super::tests::{ROOT, its_tui};
use super::super::{Hooks, acked, taken};
use super::*;
use crate::agents::{Agents, AgentsDeps, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::callers::Caller;
use crate::roles::Roles;
use crate::routes::Stop;
use crate::terminals::fake::Fake;
use crate::testing::stub_harness::production_for_test;
use crate::testing::{TempDir, runtime};
use crate::tokens::AgentTokens;
use crate::writer::Thread;

/// How long a test waits for what it waits on before it fails.
const DEADLINE: Duration = Duration::from_secs(5);

/// A short deadline, which a test waits out on the wall clock. Not on a paused one: each step
/// awaits the store's writer, a thread of its own, and a paused runtime with nothing else to run
/// moves its clock on to the next timer while it waits, so a deadline would come due in the middle
/// of the step it guards. So the tests assert only that a deadline took at least its time.
const SHORT: Duration = Duration::from_millis(100);

/// Deadlines no test waits out.
fn long() -> Deadlines {
    Deadlines {
        ack: Duration::from_secs(3600),
        unseen: Duration::from_secs(3600),
    }
}

/// A Claude Code agent launched on the fake runtime, on the session `session-1`, with one
/// runtime for the whole test, on which the mailbox's deadlines run.
struct Fixture {
    shared: Shared,
    agent: AgentId,
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

fn fixture(deadlines: Deadlines) -> Fixture {
    let dir = TempDir::new("mailbox");
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
    let hooks = Arc::new(Hooks::with_deadlines(Duration::from_millis(50), deadlines));
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
    let runtime = runtime();
    let launched = runtime
        .block_on(agents.launch(&LaunchAgentRequest {
            idempotency_key: "launch-1".to_owned(),
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
    shared.hooks = hooks;
    Fixture {
        shared,
        agent: launched.agent_id,
        runtime,
        _dir: dir,
        thread: Some(thread),
    }
}

/// A hook's reply as the hook client reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Reply {
    exit: String,
    offered: Vec<String>,
    stdout: String,
    stderr: String,
}

impl Fixture {
    fn hook_of(&self, event: &str, payload: &Value) -> HookRequest {
        let body = json!({
            "protocolVersion": HOOK_PROTOCOL_VERSION, "agentId": self.agent.as_str(),
            "event": event, "pid": 77, "ppid": ROOT, "payload": payload,
        });
        edge::<HookRequest>(body.to_string().as_bytes()).unwrap()
    }

    /// Posts a hook from the agent's own TUI, and reads its reply.
    fn post(&self, event: &str, payload: &Value) -> Reply {
        let hook = self.hook_of(event, payload);
        let response =
            self.runtime
                .block_on(taken(&self.shared, &hook, None, Some(its_tui()), None));
        self.read(response)
    }

    /// Posts a waiter's hook, and comes back once it is held or answered.
    fn hold(&self, payload: &Value) -> JoinHandle<Response> {
        let (shared, hook) = (self.shared.clone(), self.hook_of("wait", payload));
        let held = self
            .runtime
            .spawn(async move { taken(&shared, &hook, None, Some(its_tui()), None).await });
        let waiters = &self.shared.hooks.waiters;
        let settled = self.until(|| held.is_finished() || waiters.holds(&self.agent));
        assert!(settled, "the waiter was neither held nor answered");
        held
    }

    /// What a held waiter was answered with; none if it wasn't by the deadline.
    fn answered(&self, held: JoinHandle<Response>) -> Option<Reply> {
        let response = self
            .runtime
            .block_on(async { tokio::time::timeout(DEADLINE, held).await })
            .ok()?;
        Some(self.read(response.unwrap()))
    }

    fn read(&self, response: Response) -> Reply {
        let header = |name: &str| {
            let value = response.headers().get(name);
            value.map_or(String::new(), |v| v.to_str().unwrap().to_owned())
        };
        let (exit, offered, split) = (
            header("bazhen-exit-code"),
            header("bazhen-offered"),
            header("bazhen-stdout-bytes"),
        );
        let body = self
            .runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
            .unwrap();
        let (stdout, stderr) = body.split_at(split.parse().unwrap_or(0));
        Reply {
            exit,
            offered: offered
                .split(',')
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .collect(),
            stdout: String::from_utf8(stdout.to_vec()).unwrap(),
            stderr: String::from_utf8(stderr.to_vec()).unwrap(),
        }
    }

    /// Sends `body` as the human, answering the message's id.
    fn send(&self, body: &str) -> String {
        let key = format!("send-{}", self.mail().len());
        let request = json!({ "idempotencyKey": key, "body": body }).to_string();
        let response = self.runtime.block_on(crate::mail::send(
            State(self.shared.clone()),
            Path(self.agent.as_str().to_owned()),
            Some(axum::Extension(Caller(None))),
            Bytes::from(request),
        ));
        assert_eq!(response.status().as_u16(), 200);
        let bytes = self
            .runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
            .unwrap();
        let sent: Value = serde_json::from_slice(&bytes).unwrap();
        sent["messageId"].as_str().unwrap().to_owned()
    }

    /// Acks `offered` from the agent's own TUI.
    fn ack(&self, offered: &[String]) {
        let ack = json!({ "agentId": self.agent.as_str(), "offered": offered });
        let ack = edge::<HookAck>(ack.to_string().as_bytes()).unwrap();
        self.runtime
            .block_on(acked(&self.shared, &ack, None, Some(its_tui())));
    }

    /// Each mail event, by its type without `mailbox.`, and its payload.
    fn mail(&self) -> Vec<(String, Value)> {
        let reader = self.shared.store.reader().unwrap();
        let events = reader.reads().events(0, 1000).unwrap();
        events
            .into_iter()
            .filter_map(|e| {
                let kind = e.kind.strip_prefix("mailbox.")?.to_owned();
                Some((kind, serde_json::from_str(&e.payload).unwrap()))
            })
            .collect()
    }

    /// Each mail event's type without `mailbox.`.
    fn steps(&self) -> Vec<String> {
        self.mail().into_iter().map(|(kind, _)| kind).collect()
    }

    /// Whether `what` holds by the deadline, letting the runtime run meanwhile.
    fn until(&self, what: impl Fn() -> bool) -> bool {
        let since = Instant::now();
        while !what() {
            if since.elapsed() > DEADLINE {
                return false;
            }
            self.sleep(Duration::from_millis(5));
        }
        true
    }

    fn sleep(&self, wait: Duration) {
        self.runtime
            .block_on(async { tokio::time::sleep(wait).await });
    }

    fn set_state(&self, state: &'static str) {
        let agent = self.agent.clone();
        self.runtime
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

/// A waiter that runs while the agent is idle, ending no turn.
fn idle() -> Value {
    json!({ "hook_event_name": "Notification", "session_id": "session-1" })
}

fn prompt(text: &str, prompt_id: &str) -> Value {
    json!({
        "hook_event_name": "UserPromptSubmit", "session_id": "session-1", "prompt": text,
        "prompt_id": prompt_id,
    })
}

fn stop(prompt_id: &str) -> Value {
    json!({ "hook_event_name": "Stop", "session_id": "session-1", "prompt_id": prompt_id })
}

fn stop_failure(prompt_id: &str) -> Value {
    json!({
        "hook_event_name": "StopFailure", "session_id": "session-1", "prompt_id": prompt_id,
        "error": "server_error",
    })
}

fn tool_done(prompt_id: &str) -> Value {
    json!({
        "hook_event_name": "PostToolUse", "session_id": "session-1", "prompt_id": prompt_id,
        "tool_use_id": "toolu_1", "tool_name": "Bash", "tool_input": { "command": "ls" },
    })
}

fn session_start(source: &str) -> Value {
    json!({
        "hook_event_name": "SessionStart", "session_id": "session-1", "source": source,
        "transcript_path": "/t/session-1.jsonl",
    })
}

fn step(kind: &str, payload: Value) -> (String, Value) {
    (kind.to_owned(), payload)
}

fn requeued(reason: &str) -> (String, Value) {
    step("requeued", json!({ "reason": reason }))
}

#[test]
fn wakes_a_held_waiter_with_mail_sent_to_it_and_takes_the_ack_of_that_offer_only() {
    let f = fixture(long());
    let held = f.hold(&idle());
    let id = f.send("hello");
    let reply = f.answered(held).unwrap();
    f.ack(&[format!("{id}-0")]);
    let after_another = f.steps();
    f.ack(&reply.offered);
    assert_eq!(
        (
            reply.exit.as_str(),
            reply.stderr.contains("hello"),
            reply.offered.len(),
            reply.offered[0].starts_with(&format!("{id}-")),
            after_another,
            f.mail(),
        ),
        (
            "2",
            true,
            1,
            true,
            vec!["queued".to_owned(), "offered".to_owned()],
            vec![
                step(
                    "queued",
                    json!({ "agentId": f.agent.as_str(), "body": "hello" })
                ),
                step("offered", json!({})),
                step("emitted", json!({})),
            ],
        )
    );
}

#[test]
fn offers_mail_queued_while_no_waiter_is_held_to_the_next_waiter_at_once() {
    let f = fixture(long());
    let id = f.send("hello");
    let before = f.steps();
    let reply = f.hold(&idle());
    let reply = f.answered(reply).map(|r| r.offered.len());
    assert_eq!(
        (before, reply, f.steps(), id.starts_with("msg_")),
        (
            vec!["queued".to_owned()],
            Some(1),
            vec!["queued".to_owned(), "offered".to_owned()],
            true
        )
    );
}

#[test]
fn requeues_mail_its_hook_never_wrote_and_offers_it_again_as_a_possible_redelivery() {
    let f = fixture(Deadlines {
        ack: SHORT,
        ..long()
    });
    let held = f.hold(&idle());
    let id = f.send("hello");
    let first = f.answered(held).unwrap();
    let requeued_in_time = f.until(|| f.steps().len() == 3);
    let again = f.hold(&idle());
    let again = f.answered(again);
    assert_eq!(
        (
            requeued_in_time,
            f.mail().into_iter().skip(1).collect::<Vec<_>>(),
            again
                .as_ref()
                .map(|r| r.stderr.contains(&format!("possible re-delivery of {id}"))),
            again.map(|r| r.offered == first.offered),
        ),
        (
            true,
            vec![
                step("offered", json!({})),
                requeued("not_written"),
                step("offered", json!({})),
            ],
            Some(true),
            Some(false),
        )
    );
}

#[test]
fn sees_a_wake_in_the_prompt_carrying_it_and_delivers_it_once_its_turn_stops() {
    let f = fixture(long());
    let held = f.hold(&idle());
    f.send("hello");
    let wake = f.answered(held).unwrap();
    f.ack(&wake.offered);
    f.post("UserPromptSubmit", &prompt(&wake.stderr, "p-1"));
    f.post("Stop", &stop("p-0"));
    let after_another_turn = f.steps();
    f.post("Stop", &stop("p-1"));
    assert_eq!(
        (after_another_turn.last().cloned(), f.mail().split_off(3)),
        (
            Some("seen".to_owned()),
            vec![
                step("seen", json!({ "promptId": "p-1" })),
                step("delivered", json!({})),
            ],
        )
    );
}

#[test]
fn requeues_what_a_failed_or_interrupted_turn_took_and_gives_a_message_up_after_four_failures() {
    let f = fixture(long());
    f.send("hello");
    for turn in 0..4 {
        let held = f.hold(&idle());
        let wake = f.answered(held).unwrap();
        f.ack(&wake.offered);
        let prompt_id = format!("p-{turn}");
        f.post("UserPromptSubmit", &prompt(&wake.stderr, &prompt_id));
        if turn % 2 == 0 {
            f.post("StopFailure", &stop_failure(&prompt_id));
        } else {
            f.post("UserPromptSubmit", &prompt("go on", &format!("q-{turn}")));
        }
    }
    let reasons: Vec<Value> = f
        .mail()
        .into_iter()
        .filter(|(kind, _)| kind == "requeued" || kind == "undeliverable")
        .map(|(_, payload)| payload["reason"].clone())
        .collect();
    assert_eq!(
        reasons,
        [
            "stop_failed",
            "interrupted",
            "stop_failed",
            "interrupted",
            "gave_up"
        ]
        .map(|reason| json!(reason))
    );
}

#[test]
fn folds_mail_into_the_running_turn_and_delivers_it_when_that_turn_stops_unwatched_meanwhile() {
    let f = fixture(Deadlines {
        unseen: SHORT,
        ..long()
    });
    f.post("UserPromptSubmit", &prompt("go", "p-1"));
    f.send("hello");
    let fold = f.post("PostToolUse", &tool_done("p-1"));
    f.ack(&fold.offered);
    // Past the four checks a wake's watch makes in a turn.
    f.sleep(SHORT * 6);
    let after_its_deadline = f.steps();
    f.post("Stop", &stop("p-1"));
    assert_eq!(
        (
            fold.stdout.contains("additionalContext") && fold.stdout.contains("hello"),
            after_its_deadline.last().cloned(),
            f.mail().split_off(1),
        ),
        (
            true,
            Some("emitted".to_owned()),
            vec![
                step("offered", json!({ "promptId": "p-1" })),
                step("emitted", json!({})),
                step("delivered", json!({})),
            ],
        )
    );
}

#[test]
fn requeues_a_written_wake_unseen_by_its_deadline_waiting_out_a_turn_under_way_three_times_more() {
    let unseen_after = |turn: bool| {
        let f = fixture(Deadlines {
            unseen: SHORT,
            ..long()
        });
        if turn {
            f.post("UserPromptSubmit", &prompt("go", "p-1"));
        }
        let held = f.hold(&idle());
        f.send("hello");
        let wake = f.answered(held).unwrap();
        f.ack(&wake.offered);
        let since = Instant::now();
        let requeued = f.until(|| f.steps().contains(&"requeued".to_owned()));
        (requeued, f.mail().last().cloned(), since.elapsed())
    };
    let (idle, turn) = (unseen_after(false), unseen_after(true));
    assert_eq!(
        (idle.0, idle.1, turn.0, turn.1),
        (
            true,
            Some(requeued("not_seen")),
            true,
            Some(requeued("not_seen"))
        )
    );
    assert!(idle.2 >= SHORT, "requeued after {:?}", idle.2);
    assert!(turn.2 >= SHORT * 4, "requeued after {:?}", turn.2);
}

#[test]
fn requeues_a_written_wake_still_unseen_when_a_second_turn_ends() {
    let f = fixture(long());
    let held = f.hold(&idle());
    f.send("hello");
    let wake = f.answered(held).unwrap();
    f.ack(&wake.offered);
    f.post("UserPromptSubmit", &prompt("go", "p-1"));
    f.post("Stop", &stop("p-1"));
    let after_one = f.steps().last().cloned();
    f.post("UserPromptSubmit", &prompt("go", "p-2"));
    f.post("Stop", &stop("p-2"));
    assert_eq!(
        (after_one, f.mail().last().cloned()),
        (Some("emitted".to_owned()), Some(requeued("not_seen")))
    );
}

#[test]
fn requeues_what_a_new_session_cant_see_and_keeps_what_a_compaction_keeps() {
    let f = fixture(long());
    f.post("UserPromptSubmit", &prompt("go", "p-1"));
    let folded = f.send("folded");
    let fold = f.post("PostToolUse", &tool_done("p-1"));
    f.ack(&fold.offered);
    let held = f.hold(&idle());
    let woken = f.send("woken");
    f.answered(held).unwrap();
    let state = |id: &str| {
        let reader = f.shared.store.reader().unwrap();
        let message = reader.reads().message(id).unwrap();
        message.map(|m| m.state.as_str())
    };
    // The compacted session's waiter is offered the wake again, and the new session's both.
    let compacted = f.answered(f.hold(&session_start("compact")));
    let after_compaction = (state(&folded), f.mail().into_iter().rev().nth(1));
    let cleared = f.answered(f.hold(&session_start("startup")));
    assert_eq!(
        (
            compacted.map(|r| r.offered.len()),
            after_compaction,
            cleared.map(|r| r.offered.len()),
            state(&folded),
            state(&woken),
            f.steps().iter().filter(|k| *k == "requeued").count()
        ),
        (
            Some(1),
            (Some("emitted"), Some(requeued("session_started"))),
            Some(2),
            Some("offered"),
            Some("offered"),
            3,
        )
    );
}

#[test]
fn offers_no_mail_to_an_agent_closing_and_calls_a_forgotten_agents_deadlines_off() {
    let f = fixture(Deadlines {
        ack: SHORT,
        ..long()
    });
    f.send("hello");
    f.set_state("closing");
    let held = f.hold(&idle());
    f.sleep(SHORT);
    let offered_closing = held.is_finished() || f.steps().len() > 1;
    f.set_state("running");
    let reply = f.answered(f.hold(&idle()));
    f.forget();
    f.sleep(SHORT * 4);
    assert_eq!(
        (offered_closing, reply.map(|r| r.offered.len()), f.steps()),
        (
            false,
            Some(1),
            vec!["queued".to_owned(), "offered".to_owned()]
        )
    );
}

#[test]
fn leaves_a_forgotten_agents_mail_alone_for_a_step_that_comes_after() {
    let f = fixture(long());
    f.forget();
    f.send("hello");
    let held = f.hold(&idle());
    f.sleep(SHORT);
    assert_eq!(
        (held.is_finished(), f.steps()),
        (false, vec!["queued".to_owned()])
    );
}

/// Closing an agent forgets its mail: the store has settled it as undeliverable, and what the
/// mailbox held of it, an offer awaiting its ack, goes, and the agent is marked so that no step
/// touches its mail again.
#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn forgets_a_closed_agents_mail_and_the_offers_it_held() {
    bazhen_test_signal::require_sandbox().unwrap();
    let f = fixture(long());
    f.send("hello");
    let reply = f.answered(f.hold(&idle()));
    let before = f.held_mail();
    let closed = f.close();
    assert_eq!(
        (
            reply.map(|r| r.offered.len()),
            before,
            closed,
            f.held_mail()
        ),
        (Some(1), (false, 1), Ok(()), (true, 0))
    );
}

impl Fixture {
    fn close(&self) -> Result<(), crate::agents::AgentError> {
        let agents = self.shared.agents.as_deref().unwrap();
        let reader = self.shared.store.reader().unwrap();
        let generation = reader
            .reads()
            .agent_terminal(self.agent.as_str())
            .unwrap()
            .and_then(|found| found.generation)
            .unwrap_or_default();
        let request = bazhen_protocol::agents::CloseAgentRequest {
            idempotency_key: "close-1".to_owned(),
            generation,
            force: None,
            keep_shells: None,
            confirm_busy: None,
            confirmed_busy: None,
        };
        self.runtime
            .block_on(agents.close(self.agent.as_str(), &request))
            .map(drop)
    }

    /// Whether the mailbox has forgotten the agent, and how many offers it holds awaiting their
    /// acks.
    fn held_mail(&self) -> (bool, usize) {
        let mail = self.shared.hooks.mailbox.of(&self.agent);
        self.runtime.block_on(async {
            let mail = mail.lock().await;
            (mail.forgotten, mail.unacked.len())
        })
    }

    fn forget(&self) {
        let agents = self.shared.agents.as_deref().unwrap();
        let forgotten = self.shared.hooks.mailbox.forget(agents, &self.agent);
        let forgotten = self
            .runtime
            .block_on(async { tokio::time::timeout(DEADLINE, forgotten).await });
        assert_eq!(forgotten, Ok(Ok(())));
    }
}

#[test]
fn keeps_an_offer_whole_when_its_caller_goes_mid_step_so_its_ack_deadline_still_requeues_it() {
    let f = fixture(Deadlines {
        ack: SHORT,
        ..long()
    });
    f.send("hello");
    let _waiting = f.shared.hooks.waiters.wait(&f.agent);
    // The writer takes the offer's write only once this one lets it go.
    let (release, stalled) = std::sync::mpsc::channel::<()>();
    let store = f.shared.store.clone();
    let stall = f.runtime.spawn(async move {
        write(&store, move |_| {
            stalled.recv().ok();
            Ok(())
        })
        .await
    });
    f.sleep(Duration::from_millis(20));
    let (shared, agent) = (f.shared.clone(), f.agent.clone());
    let caller = f
        .runtime
        .spawn(async move { shared.hooks.mailbox.offer(&shared, &agent).await });
    f.sleep(Duration::from_millis(20));
    caller.abort();
    release.send(()).unwrap();
    let stalled_write = f.runtime.block_on(stall).ok();
    let in_time = f.until(|| f.steps().contains(&"requeued".to_owned()));
    assert_eq!(
        (stalled_write, in_time, f.mail().split_off(1)),
        (
            Some(Ok(())),
            true,
            vec![step("offered", json!({})), requeued("not_written")]
        )
    );
}

#[test]
fn takes_the_late_end_of_a_turn_a_newer_prompt_cut_short_for_no_end_of_the_turn_under_way() {
    let f = fixture(long());
    let held = f.hold(&idle());
    f.send("hello");
    let wake = f.answered(held).unwrap();
    f.ack(&wake.offered);
    f.post("UserPromptSubmit", &prompt("go", "p-1"));
    f.post("UserPromptSubmit", &prompt("go on", "p-2"));
    f.post("Stop", &stop("p-1"));
    f.post("Stop", &stop("p-2"));
    // Only the turn under way ended: one boundary, which a wake outlasts.
    assert_eq!(f.mail().last().cloned(), Some(step("emitted", json!({}))));
}
