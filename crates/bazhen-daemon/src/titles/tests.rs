//! A starting Codex agent's terminal title, read as its start is timed and each time the runtime
//! tells it changed or that events were missed, records the agent up once it names the agent's
//! thread, from the process that starts and no other, and pushes the mail queued for it.

use std::sync::Mutex as StdMutex;
use std::time::Duration;

use bazhen_harness::{
    BoxFuture, ChannelPort, HarnessDeps, Output, PushPort, RunError, RunPort, compiled,
};
use bazhen_protocol::agent_events::AgentExited;
use bazhen_protocol::agents::{ExitStatus, LaunchAgentRequest};
use bazhen_store::{AgentChange, AppendError, NewEvent};

use super::*;
use crate::agents::{AgentsDeps, prompts};
use crate::budget::Budget;
use crate::budget::tests::{Machine, roomy};
use crate::hooks::Hooks;
use crate::mail::PushTo;
use crate::readiness::{StoreSource, follow};
use crate::roles::Roles;
use crate::routes::Stop;
use crate::terminals::fake::Fake;
use crate::testing::stub_harness::{StubHarness, pull};
use crate::testing::{TempDir, runtime, within};
use crate::tokens::AgentTokens;
use crate::writer::{Thread, Writer};
use tokio_util::task::TaskTracker;

/// Long enough for any step here, which comes at once or never.
const LIMIT: Duration = Duration::from_secs(10);
/// A deadline no test waits out.
const LATER: Duration = Duration::from_secs(600);
/// The agent's thread, as Codex titles its terminal with it.
const THREAD: &str = "0190a1b2-c3d4-7abc-8def-0123456789ab";

/// What the daemon ran to push mail, each command's argv in order; each run succeeds.
#[derive(Debug, Default)]
struct Ran(StdMutex<Vec<Vec<String>>>);

impl RunPort for Ran {
    fn run<'a>(
        &'a self,
        argv: &'a [String],
        _timeout: Duration,
    ) -> BoxFuture<'a, Result<Output, RunError>> {
        self.0.lock().unwrap().push(argv.to_vec());
        Box::pin(std::future::ready(Ok(Output {
            code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
        })))
    }
}

impl PushPort for Ran {
    fn channel(&self) -> Option<&dyn ChannelPort> {
        None
    }
}

/// A Codex agent starting on thread [`THREAD`] in a terminal of the fake runtime, its start
/// recorded, and the daemon serving it with the Codex adapter.
struct Fixture {
    shared: Shared,
    agent: AgentId,
    terminal: TerminalId,
    fake: Arc<Fake>,
    ran: Arc<Ran>,
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

fn agents_over(
    store: &Writer,
    dir: &TempDir,
    harnesses: bazhen_harness::Harnesses,
    hooks: &Arc<Hooks>,
    fake: &Arc<Fake>,
) -> Agents {
    let run = dir.path().join("run");
    let uid = rustix::process::getuid().as_raw();
    Agents::new(AgentsDeps {
        store: store.clone(),
        terminals: Arc::clone(fake) as Arc<dyn crate::terminals::Terminals>,
        budget: Arc::new(Budget::new(
            100,
            Arc::new(Machine(StdMutex::new(roomy()))),
            Box::new(|_| {}),
        )),
        home: dir.path().join("home").to_string_lossy().into_owned(),
        socket: "/run/b.sock".to_owned(),
        tracker: TaskTracker::new(),
        roles: Arc::new(Roles::new(None)),
        harnesses: Arc::new(harnesses),
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
    let dir = TempDir::new("titles");
    let path = dir.path().join("bazhen.db");
    let (store, thread) =
        crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(home.join("repo")).unwrap();
    let hooks = Arc::new(Hooks::default());
    let fake = Arc::new(Fake::default());
    // Launched by a harness of the test's under Codex's id, as Codex launches only over its server.
    let launcher = agents_over(
        &store,
        &dir,
        StubHarness::new(pull()).served_as(HarnessId::Codex),
        &hooks,
        &fake,
    );
    let agent = runtime()
        .block_on(launcher.launch(&LaunchAgentRequest {
            idempotency_key: "k-1".to_owned(),
            harness: HarnessId::Codex,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: None,
            role: None,
            compact_window_tokens: None,
        }))
        .unwrap()
        .agent_id;
    let served = compiled(HarnessDeps {
        new_session_id: Box::new(|| "session-1".to_owned()),
        hook_command: "exec '/state/hook/bazhen-hook'".to_owned(),
        daemon_env: Box::new(|_| None),
        user_env: Box::new(|_| None),
        home: home.to_string_lossy().into_owned(),
        read_file: Box::new(|_| None),
        scan_transcript: Box::new(|_, _| false),
        now_ms: Box::new(|| 0),
        daemon_socket: "/run/b.sock".to_owned(),
        real_path: Arc::new(|path| Some(path.to_owned())),
    });
    let agents = Arc::new(agents_over(&store, &dir, served, &hooks, &fake));
    let ran = Arc::new(Ran::default());
    let mut shared = Shared::new(&"f".repeat(64), Stop::default(), store)
        .with_hooks(hooks)
        .with_agents(agents);
    shared.push = Some(PushTo(Arc::clone(&ran) as Arc<dyn PushPort>));
    let terminal = shared
        .store
        .reader()
        .unwrap()
        .reads()
        .agent_terminal(agent.as_str())
        .unwrap()
        .unwrap()
        .terminal_id
        .unwrap();
    let f = Fixture {
        shared,
        agent,
        terminal,
        fake,
        ran,
        stop: CancellationToken::new(),
        _dir: dir,
        thread: Some(thread),
    };
    f.write(&format!(
        "UPDATE agent_sessions SET state = 'starting', \
         external_ref = json_set(external_ref, '$.kind', 'codex-thread', '$.id', '{THREAD}') \
         WHERE id = ?"
    ));
    f
}

impl Fixture {
    /// Runs `sql` on the store, its one parameter the agent's id.
    fn write(&self, sql: &str) {
        let (agent, sql) = (self.agent.clone(), sql.to_owned());
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

    fn state(&self) -> String {
        let reader = self.shared.store.reader().unwrap();
        reader
            .reads()
            .agent_state(self.agent.as_str())
            .unwrap()
            .unwrap()
    }

    fn reads(&self) -> usize {
        self.fake.state.lock().unwrap().titles_read.len()
    }

    /// Times the agent's start, and reads the titles of the terminals it watches, until the
    /// fixture drops.
    fn follow(&self) {
        let tracker = TaskTracker::new();
        tracker.spawn(follow(
            self.shared.clone(),
            StoreSource::new(self.shared.store.clone()),
            LATER,
            self.stop.clone(),
        ));
        tracker.spawn(super::follow(self.shared.clone(), self.stop.clone()));
    }

    fn queue_mail(&self, body: &str) {
        let (agent, body) = (self.agent.clone(), body.to_owned());
        runtime()
            .block_on(
                self.shared
                    .store
                    .run(move |store| store.write(|w| w.queue_mail(&agent, &body, None))),
            )
            .unwrap()
            .unwrap();
    }
}

/// Waits until `done`, for no longer than [`LIMIT`], failing the test if it never is.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + LIMIT;
    while !done() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(done(), "{what}");
}

#[test]
fn records_a_starting_codex_agent_up_once_its_terminal_is_titled_with_its_thread() {
    let f = fixture();
    let state = runtime().block_on(async {
        f.follow();
        until("the title was never read as the start was timed", || {
            f.reads() == 1
        })
        .await;
        f.fake.title(f.terminal.as_str(), THREAD);
        f.shared.hooks.titles.told(&f.terminal);
        until("the agent never came up", || f.state() == "running").await;
        f.state()
    });
    assert_eq!(state, "running");
}

#[test]
fn records_a_codex_agent_up_on_a_title_its_tui_set_before_its_start_was_timed() {
    let f = fixture();
    f.fake.title_unseen(f.terminal.as_str(), THREAD);
    let state = runtime().block_on(async {
        f.follow();
        until("the agent never came up", || f.state() == "running").await;
        f.state()
    });
    assert_eq!(state, "running");
}

#[test]
fn reads_a_title_again_that_could_not_be_read_while_its_terminal_still_ran() {
    let f = fixture();
    f.fake.title_unseen(f.terminal.as_str(), THREAD);
    f.fake.set(|state| {
        state
            .titles_refused
            .push_back(TerminalError::Unreachable("its holder refused".to_owned()));
    });
    let state = runtime().block_on(async {
        f.follow();
        until("the agent never came up", || f.state() == "running").await;
        f.state()
    });
    assert_eq!((state, f.reads()), ("running".to_owned(), 2));
}

#[test]
fn reads_every_watched_title_again_once_events_were_missed() {
    let f = fixture();
    let state = runtime().block_on(async {
        f.follow();
        until("the title was never read as the start was timed", || {
            f.reads() == 1
        })
        .await;
        f.fake.title_unseen(f.terminal.as_str(), THREAD);
        f.shared.hooks.titles.missed();
        until("the agent never came up", || f.state() == "running").await;
        f.state()
    });
    assert_eq!(state, "running");
}

#[test]
fn records_no_codex_agent_up_on_a_title_another_process_in_its_terminal_set() {
    let f = fixture();
    f.fake.respawn_unseen(f.terminal.as_str());
    f.fake.title_unseen(f.terminal.as_str(), THREAD);
    let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
    let watch = Watch {
        agent: f.agent.clone(),
        generation: 0,
    };
    runtime()
        .block_on(read_one(&f.shared, &agents, &f.terminal, &watch))
        .unwrap();
    assert_eq!((f.reads(), f.state()), (1, "starting".to_owned()));
}

#[test]
fn pushes_the_mail_queued_for_a_codex_agent_once_its_title_says_it_is_up() {
    let f = fixture();
    f.queue_mail("hello");
    f.fake.title_unseen(f.terminal.as_str(), THREAD);
    let pushed = runtime().block_on(async {
        f.follow();
        until("the agent never came up", || f.state() == "running").await;
        until("its mail was never pushed", || {
            !f.ran.0.lock().unwrap().is_empty()
        })
        .await;
        f.ran.0.lock().unwrap()[0].clone()
    });
    assert_eq!(
        pushed[..4],
        ["codex", "queue", "--thread", THREAD].map(str::to_owned)
    );
}

#[test]
fn watches_no_terminal_of_a_start_once_its_agent_has_exited() {
    let f = fixture();
    let titles = Arc::clone(&f.shared.hooks.titles);
    let other = TerminalId::parse("term_0190a1b2c3d47abc8def0123456789ff").unwrap();
    let watch = Watch {
        agent: AgentId::parse("agent_0190a1b2c3d47abc8def0123456789ff").unwrap(),
        generation: 0,
    };
    let due = runtime().block_on(async {
        // Times the start alone, so nothing but the test takes what is due.
        TaskTracker::new().spawn(follow(
            f.shared.clone(),
            StoreSource::new(f.shared.store.clone()),
            LATER,
            f.stop.clone(),
        ));
        within(LIMIT, async {
            while titles.next().await.iter().all(|(t, _)| t != &f.terminal) {}
        })
        .await;
        let agent = f.agent.clone();
        f.shared
            .store
            .run(move |store| {
                store.write(|w| {
                    w.append(&NewEvent::Agent {
                        agent,
                        actor: "system".to_owned(),
                        change: AgentChange::Exited(AgentExited {
                            exit: ExitStatus::Exited { code: 0 },
                        }),
                    })
                })
            })
            .await
            .unwrap()
            .unwrap();
        let deadline = tokio::time::Instant::now() + LIMIT;
        loop {
            titles.told(&f.terminal);
            titles.watch(other.clone(), watch.clone());
            let due = within(LIMIT, titles.next()).await;
            if due.iter().all(|(t, _)| t != &f.terminal) || tokio::time::Instant::now() >= deadline
            {
                return due;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    assert_eq!(due, [(other, watch)]);
}
