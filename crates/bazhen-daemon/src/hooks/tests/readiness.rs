//! Launch readiness: each start timed from its own start, by the follower of the committed
//! events, the human told once per start that waited its deadline out, and a sign of life a TUI
//! gave before its start was recorded taken for that start. On the wall clock: the follower times
//! starts by when they were recorded.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use bazhen_protocol::agent_events::AgentExited;
use bazhen_protocol::agents::ExitStatus;
use bazhen_store::{AgentChange, NewEvent, StoredEvent, Waiting};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::readiness::{Source, StoreSource, follow};

/// A deadline short enough to wait out, and long enough that a look before it comes in time.
const SOON: Duration = Duration::from_millis(600);
/// A deadline no test waits out.
const LATER: Duration = Duration::from_secs(600);

/// A follower on a task of its own, until it is stopped.
struct Following {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Following {
    /// Whether the follower is still going.
    fn going(&self) -> bool {
        !self.task.is_finished()
    }

    /// Stops the follower; whether it ended by the deadline.
    async fn stopped(self) -> bool {
        self.stop.cancel();
        tokio::time::timeout(DEADLINE, self.task).await.is_ok()
    }
}

fn following(f: &Fixture, source: impl Source + 'static, deadline: Duration) -> Following {
    let stop = CancellationToken::new();
    let task = TaskTracker::new().spawn(follow(f.shared.clone(), source, deadline, stop.clone()));
    Following { stop, task }
}

fn follows(f: &Fixture, deadline: Duration) -> Following {
    following(f, StoreSource::new(f.shared.store.clone()), deadline)
}

/// The log, read through a source that says when the follower has booted, and fails its first
/// `failures` reads of events.
struct Watched {
    store: StoreSource,
    booted: Arc<AtomicBool>,
    failures: Arc<AtomicUsize>,
}

impl Watched {
    fn new(f: &Fixture, failures: usize) -> Self {
        Self {
            store: StoreSource::new(f.shared.store.clone()),
            booted: Arc::new(AtomicBool::new(false)),
            failures: Arc::new(AtomicUsize::new(failures)),
        }
    }
}

impl Source for Watched {
    fn boot(&mut self) -> Result<(u64, Vec<Waiting>), String> {
        let booted = self.store.boot();
        self.booted.store(booted.is_ok(), Ordering::SeqCst);
        booted
    }

    fn events(&mut self, after: u64, limit: u32) -> Result<Vec<StoredEvent>, String> {
        let left = self.failures.load(Ordering::SeqCst);
        if left > 0 {
            self.failures.store(left - 1, Ordering::SeqCst);
            return Err("disk I/O error".to_owned());
        }
        self.store.events(after, limit)
    }
}

/// Waits on the wall clock until `done`, or the deadline; whether it was done.
async fn eventually(mut done: impl FnMut() -> bool) -> bool {
    let start = std::time::Instant::now();
    while !done() {
        if start.elapsed() > DEADLINE {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    true
}

impl Fixture {
    /// The summary of each stuck-starting item opened, oldest first.
    fn stuck(&self) -> Vec<String> {
        self.of("attention.opened")
            .into_iter()
            .filter(|opened| opened["kind"] == "stuck_starting")
            .map(|opened| opened["summary"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    /// Runs `sql` in one job on the writer, so the follower hears of what it commits.
    async fn exec(&self, sql: String) {
        write(&self.shared.store, move |w| {
            w.connection().execute_batch(&sql)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    /// Records `change` of the agent, as the daemon would.
    async fn append(&self, change: AgentChange) {
        let agent = self.agent.clone();
        write(&self.shared.store, move |w| {
            w.append(&NewEvent::Agent {
                agent,
                actor: "system".to_owned(),
                change,
            })
        })
        .await
        .unwrap();
    }

    /// Sets the agent's terminal's state, as its row records it.
    fn terminal(&self, state: &str) -> String {
        format!(
            "UPDATE terminals SET state = '{state}'
               WHERE id = (SELECT terminal_id FROM agent_sessions WHERE id = '{}');",
            self.agent.as_str()
        )
    }

    /// The agent's process exited, and a respawn of it was asked for.
    async fn respawn_asked(&self) {
        let exit = ExitStatus::Unknown;
        self.append(AgentChange::Exited(AgentExited { exit })).await;
        self.append(AgentChange::RespawnRequested).await;
    }

    /// The respawn's terminal runs: its start is recorded.
    async fn respawned(&self) {
        let start = raw(self.agent.as_str(), "agent.respawned", &now());
        self.exec(format!("{start} {}", self.terminal("running")))
            .await;
    }

    /// The respawn's terminal runs a new process, `root`: its start is recorded.
    async fn respawned_as(&self, root: i32) {
        let moved = format!(
            "UPDATE terminals SET locator = json_set(locator, '$.childPid', '{root}')
               WHERE id = (SELECT terminal_id FROM agent_sessions WHERE id = '{}');",
            self.agent.as_str()
        );
        let start = raw(self.agent.as_str(), "agent.respawned", &now());
        self.exec(format!("{moved} {start} {}", self.terminal("running")))
            .await;
    }

    /// A prompt from the TUI that `peer` reads, which says the harness is up.
    async fn prompted(&self, peer: PeerRead) {
        let hook = self.request(
            HOOK_PROTOCOL_VERSION,
            "UserPromptSubmit",
            &prompt("session-1"),
        );
        taken(&self.shared, &hook, None, Some(peer), None).await;
    }
}

/// Records the event `kind` of `entity`, as the log holds one, at `ts`.
fn raw(entity: &str, kind: &str, ts: &str) -> String {
    format!(
        "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
           SELECT id, '{ts}', '{kind}', 'agent', '{entity}', 'system', '{{}}' FROM host;"
    )
}

fn now() -> String {
    format!("{:.3}", jiff::Timestamp::now())
}

const SAID: &str = "Its harness hasn't shown it is up after 1 s. Look in its terminal for a dialog \
                    to answer.";

#[test]
fn tells_the_human_once_a_start_has_waited_its_deadline_and_not_before() {
    let f = fixture();
    runtime().block_on(async {
        let following = follows(&f, SOON);
        tokio::time::sleep(SOON / 3).await;
        let early = f.stuck();
        assert!(eventually(|| !f.stuck().is_empty()).await);
        tokio::time::sleep(SOON * 2).await;
        assert_eq!((early, f.stuck()), (vec![], vec![SAID.to_owned()]));
        assert!(following.stopped().await);
    });
}

#[test]
fn times_a_start_again_from_its_own_start_once_its_agent_starts_again() {
    let f = fixture();
    runtime().block_on(async {
        let following = follows(&f, SOON);
        assert!(eventually(|| f.stuck().len() == 1).await);
        f.respawn_asked().await;
        f.respawned().await;
        let told = eventually(|| f.stuck().len() == 2).await;
        let closed = f.of("attention.closed");
        assert_eq!((told, closed), (true, vec![json!({ "reason": "stale" })]));
        assert!(following.stopped().await);
    });
}

#[test]
fn tells_nothing_of_a_start_its_tui_shows_up_in_before_its_deadline() {
    let f = fixture();
    runtime().block_on(async {
        let following = follows(&f, SOON);
        f.prompted(its_tui()).await;
        tokio::time::sleep(SOON * 2).await;
        assert_eq!(
            (f.of("agent.ready").len(), f.stuck()),
            (1, Vec::<String>::new())
        );
        assert!(following.stopped().await);
    });
}

#[test]
fn tells_the_human_at_once_of_a_start_from_before_a_restart_that_has_waited_its_deadline_out() {
    let f = fixture();
    runtime().block_on(async {
        let long_ago = format!(
            "{:.3}",
            jiff::Timestamp::now() - jiff::SignedDuration::from_mins(20)
        );
        f.exec(format!(
            "UPDATE events SET ts = '{long_ago}' WHERE type = 'agent.running'"
        ))
        .await;
        let following = follows(&f, LATER);
        assert!(
            eventually(|| !f.stuck().is_empty()).await,
            "nothing was opened by the deadline"
        );
        assert!(following.stopped().await);
    });
}

#[test]
fn tells_nothing_of_a_start_whose_terminal_stopped_running_before_its_deadline() {
    let f = fixture();
    runtime().block_on(async {
        let source = Watched::new(&f, 0);
        let booted = Arc::clone(&source.booted);
        let following = following(&f, source, SOON);
        // Once the follower has timed the start, which it does at boot.
        assert!(eventually(|| booted.load(Ordering::SeqCst)).await);
        f.exec(f.terminal("exited")).await;
        tokio::time::sleep(SOON * 2).await;
        assert_eq!(f.stuck(), Vec::<String>::new());
        assert!(following.stopped().await);
    });
}

#[test]
fn tells_the_human_a_deadline_later_when_the_first_telling_cant_be_recorded() {
    let f = fixture();
    runtime().block_on(async {
        f.exec(
            "CREATE TEMP TRIGGER refuse BEFORE INSERT ON attention_items
               BEGIN SELECT RAISE(ABORT, 'refused'); END;"
                .to_owned(),
        )
        .await;
        let following = follows(&f, SOON);
        tokio::time::sleep(SOON + SOON / 2).await;
        let refused = f.stuck();
        f.exec("DROP TRIGGER refuse;".to_owned()).await;
        let told = eventually(|| !f.stuck().is_empty()).await;
        assert_eq!((refused, told), (vec![], true));
        assert!(following.stopped().await);
    });
}

#[test]
fn takes_a_sign_its_tui_gave_once_its_start_was_asked_for_and_none_from_before() {
    let f = fixture();
    runtime().block_on(async {
        let following = follows(&f, LATER);
        f.prompted(its_tui()).await;
        // The agent's process exits, and its TUI says it is up before the respawn is asked for:
        // that sign is the old process's.
        f.append(AgentChange::Exited(AgentExited {
            exit: ExitStatus::Unknown,
        }))
        .await;
        f.prompted(its_tui()).await;
        f.append(AgentChange::RespawnRequested).await;
        f.respawned().await;
        tokio::time::sleep(SOON).await;
        let before = f.of("agent.ready").len();
        // Asked for again, the new TUI says it is up before its start is recorded.
        f.append(AgentChange::Exited(AgentExited {
            exit: ExitStatus::Unknown,
        }))
        .await;
        f.append(AgentChange::RespawnRequested).await;
        f.prompted(its_tui()).await;
        f.respawned().await;
        let taken = eventually(|| f.of("agent.ready").len() == 2).await;
        assert_eq!((before, taken), (1, true));
        assert!(following.stopped().await);
    });
}

#[test]
fn takes_a_sign_kept_for_a_start_the_follower_reads_only_after_it() {
    let f = fixture();
    runtime().block_on(async {
        f.respawn_asked().await;
        f.prompted(its_tui()).await;
        f.respawned().await;
        let kept = f.of("agent.ready").len();
        let following = follows(&f, LATER);
        let taken = eventually(|| f.of("agent.ready").len() == 1).await;
        assert_eq!((kept, taken), (0, true));
        assert!(following.stopped().await);
    });
}

#[test]
fn takes_no_sign_from_the_process_before_the_one_the_start_runs() {
    let f = fixture();
    runtime().block_on(async {
        let following = follows(&f, LATER);
        f.respawn_asked().await;
        // The old TUI, its terminal's process until the respawn runs another, says it is up.
        f.prompted(its_tui()).await;
        f.respawned_as(6000).await;
        tokio::time::sleep(SOON).await;
        assert_eq!(f.of("agent.ready"), Vec::<Value>::new());
        assert!(following.stopped().await);
    });
}

#[test]
fn reads_on_past_a_read_that_fails_and_an_event_it_cant_read() {
    let f = fixture();
    runtime().block_on(async {
        // At boot, no start waits.
        f.exec(f.terminal("creating")).await;
        let source = Watched::new(&f, 2);
        let (booted, failures) = (Arc::clone(&source.booted), Arc::clone(&source.failures));
        let following = following(&f, source, SOON);
        // So the follower reads the start as an event, after the one it can't read.
        assert!(eventually(|| booted.load(Ordering::SeqCst)).await);
        let unreadable = raw("not an agent", "agent.running", &now());
        let start = raw(f.agent.as_str(), "agent.running", &now());
        f.exec(format!("{unreadable} {start} {}", f.terminal("running")))
            .await;
        let told = eventually(|| !f.stuck().is_empty()).await;
        assert_eq!((failures.load(Ordering::SeqCst), told), (0, true));
        assert!(following.stopped().await);
    });
}

#[test]
fn ends_only_at_the_stop_however_its_reads_fail() {
    let f = fixture();
    runtime().block_on(async {
        let source = Watched::new(&f, usize::MAX);
        let booted = Arc::clone(&source.booted);
        let following = following(&f, source, LATER);
        assert!(eventually(|| booted.load(Ordering::SeqCst)).await);
        let event = raw(f.agent.as_str(), "agent.running", &now());
        f.exec(event).await;
        tokio::time::sleep(SOON).await;
        assert!(following.going(), "the follower ended before its stop");
        assert!(following.stopped().await, "the follower outlived its stop");
    });
}
