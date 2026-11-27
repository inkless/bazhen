//! What the runtime hears of its holders without asking: one connection to each live holder,
//! never subscribed, so its holder sends it only what it pushes to every connection, `exited`,
//! `respawned` and `title`, and its holder's death hangs it up. Nothing polls. A connection that
//! ends gets `hello` again, which tells a holder that dropped it, as one serving all the
//! connections it can drops one, from a holder that has gone. One that won't answer while the
//! host still shows it running is asked again, backing off, until it answers or stops running.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use bazhen_holder_proto::body::{ExitStatus, Generation, HelloReply, Pid, StartTime};
use bazhen_host_guard::holder::{HolderProcess, StartedHolder};
use bazhen_protocol::ids::TerminalId;
use futures_util::future::{Either, select};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::client::{ClientOptions, HolderClient, HolderEvent, HolderEvents, connect};
use crate::locator::HolderRef;
use crate::runtime::Unreached;

/// How many events wait for a subscriber that is slow to take them, past which it is told it
/// missed some, and reads the inventory again.
pub const EVENTS_KEPT: usize = 1024;

/// The first wait before asking a holder again, doubled at each ask up to `LONGEST_WAIT`.
const FIRST_WAIT: Duration = Duration::from_millis(100);
const LONGEST_WAIT: Duration = Duration::from_secs(5);
/// How long a connection must have lasted for the next one to be asked for at once, the waits
/// starting again from none: one that keeps dropping sooner is asked for ever more slowly, so it
/// can't flood the events.
const STEADY: Duration = LONGEST_WAIT;

/// How many closed holders are remembered, each refused a watch; see `Closing`.
const CLOSED_KEPT: usize = 1024;

/// The next event, `None` inside for a connection that ended without `Ended`, or `None` once
/// `token` is cancelled.
async fn next(token: &CancellationToken, events: &mut HolderEvents) -> Option<Option<HolderEvent>> {
    match select(pin!(token.cancelled()), pin!(events.recv())).await {
        Either::Left(_) => None,
        Either::Right((event, _)) => Some(event),
    }
}

/// What a terminal's holder said unasked, or that it has gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeEvent {
    /// The terminal's process of `generation` ended: told once for each generation, the moment
    /// its watch opens for one that ended before.
    Exited {
        terminal_id: TerminalId,
        generation: Generation,
        status: ExitStatus,
    },
    /// A new process runs in the terminal: `terminal` names it.
    Respawned { terminal: HolderRef },
    /// The terminal's title may have changed, for `title` to read: as its watch opens, each time
    /// its program sets one, and when a connection opened again finds another. The title itself
    /// isn't told, as one told could be read after a respawn it predates.
    Title { terminal_id: TerminalId },
    /// The holder hung up, and asked again, nothing listens at the terminal's socket, or another
    /// holder answers there, or it won't answer and the host no longer shows it running: it has
    /// gone, or its socket has, which `gone` and `health` tell apart. One that won't answer while
    /// it still runs, as one serving all the connections it can refuses one, is asked again.
    Lost { terminal: HolderRef },
}

/// Whether the holder a watch records still runs, as the host shows it: the runtime's
/// `Host::may_run`, asked while that holder won't answer.
#[derive(Clone)]
pub(crate) struct Running(Arc<dyn Fn(HolderProcess) -> bool + Send + Sync>);

impl Running {
    pub(crate) fn new(runs: impl Fn(HolderProcess) -> bool + Send + Sync + 'static) -> Self {
        Self(Arc::new(runs))
    }
}

impl fmt::Debug for Running {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Running").finish_non_exhaustive()
    }
}

/// One watch, of one holder of a terminal.
#[derive(Debug)]
struct Watching {
    holder: (Pid, StartTime),
    token: CancellationToken,
    id: u64,
}

/// What the lock guards: the watches, and the holders being closed or closed, none of which is
/// watched again.
#[derive(Debug, Default)]
struct State {
    watching: HashMap<TerminalId, Watching>,
    /// How many closes of each terminal are under way.
    closing: HashMap<TerminalId, usize>,
    closed: VecDeque<(TerminalId, (Pid, StartTime))>,
}

/// Every watch, and the holders the runtime started, which it reaps.
#[derive(Debug)]
pub(crate) struct Watches {
    hello: Duration,
    running: Running,
    events: broadcast::Sender<RuntimeEvent>,
    state: Mutex<State>,
    next: AtomicU64,
    /// Cancelled at shutdown: every watch and every connection of the runtime ends.
    pub(crate) token: CancellationToken,
    pub(crate) tasks: TaskTracker,
}

/// Why asking a holder again found no connection to the watch's own holder.
enum Unanswered {
    /// Nothing listens at its socket, or another holder answers there.
    Gone,
    /// It didn't answer: it timed out, hung up before answering, or couldn't be read.
    Silent,
    Cancelled,
}

/// Why a watch whose connection ended ends too.
enum Unresumed {
    Lost,
    Cancelled,
}

/// The waits between asks of one watch's holder.
#[derive(Debug, Default)]
struct Backoff {
    wait: Duration,
}

impl Backoff {
    /// A connection that lasted `lasted` ended: one that was steady is asked for again at once.
    fn ended(&mut self, lasted: Duration) {
        if lasted >= STEADY {
            self.wait = Duration::ZERO;
        }
    }

    /// Waits as long as this ask must, and doubles the next wait; `false` once `token` is
    /// cancelled.
    async fn wait(&mut self, token: &CancellationToken) -> bool {
        let wait = self.wait;
        self.wait = (wait * 2).clamp(FIRST_WAIT, LONGEST_WAIT);
        if wait.is_zero() {
            return !token.is_cancelled();
        }
        let slept = pin!(tokio::time::sleep(wait));
        matches!(
            select(pin!(token.cancelled()), slept).await,
            Either::Right(_)
        )
    }
}

/// What a watch has told of its terminal, so a connection opened again tells only what changed.
#[derive(Debug, Default)]
struct Told {
    exited: Option<Generation>,
    title: Option<String>,
}

/// A close of a terminal under way, during which no watch of it starts; one that ends `closed`
/// leaves its holder refused a watch for good. An inventory that reached the holder before the
/// close may otherwise adopt it after, and its watch tell an exit, or a loss, of a terminal closed
/// on purpose. Only the last `CLOSED_KEPT` closed holders are kept: an inventory in flight ends
/// within its hello's bound, long before so many more closes.
#[derive(Debug)]
pub(crate) struct Closing<'a> {
    watches: &'a Watches,
    terminal_id: TerminalId,
    holder: (Pid, StartTime),
    closed: bool,
}

impl Closing<'_> {
    /// The holder has closed: it is never watched again.
    pub(crate) fn closed(mut self) {
        self.closed = true;
    }
}

impl Drop for Closing<'_> {
    fn drop(&mut self) {
        let mut state = self.watches.lock();
        if let Some(count) = state.closing.get_mut(&self.terminal_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.closing.remove(&self.terminal_id);
            }
        }
        if self.closed {
            if state.closed.len() >= CLOSED_KEPT {
                state.closed.pop_front();
            }
            state
                .closed
                .push_back((self.terminal_id.clone(), self.holder));
        }
    }
}

impl Watches {
    pub(crate) fn new(hello: Duration, running: Running) -> Self {
        Self {
            hello,
            running,
            events: broadcast::Sender::new(EVENTS_KEPT),
            state: Mutex::new(State::default()),
            next: AtomicU64::new(0),
            token: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // Each change under the lock is one insert or remove, which a panic leaves whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.events.subscribe()
    }

    fn tell(&self, event: RuntimeEvent) {
        // With no subscriber, nobody is listening, and the event has no one to go to.
        let _ = self.events.send(event);
    }

    /// Options for a connection that ends at shutdown, reading only.
    pub(crate) fn client_options(&self, cancel: &CancellationToken) -> ClientOptions {
        ClientOptions {
            writer: false,
            connect: self.hello,
            cancel: cancel.child_token(),
            ..ClientOptions::default()
        }
    }

    /// Watches `terminal` on `client`, a connection to its holder past `hello`, unless that
    /// holder is watched already, or is being closed or has been; a watch of another holder of
    /// the terminal ends.
    pub(crate) fn adopt(
        self: &Arc<Self>,
        terminal: HolderRef,
        client: HolderClient,
        events: HolderEvents,
    ) {
        let holder = (terminal.locator.holder_pid, terminal.locator.holder_start);
        if self.token.is_cancelled() {
            return;
        }
        let token = self.token.child_token();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut state = self.lock();
            let terminal_id = &terminal.terminal_id;
            if state.closing.contains_key(terminal_id)
                || state
                    .closed
                    .iter()
                    .any(|(closed, of)| closed == terminal_id && *of == holder)
            {
                return;
            }
            if let Some(current) = state.watching.get(terminal_id) {
                if current.holder == holder {
                    return;
                }
                current.token.cancel();
            }
            state.watching.insert(
                terminal_id.clone(),
                Watching {
                    holder,
                    token: token.clone(),
                    id,
                },
            );
        }
        let watches = Arc::clone(self);
        self.tasks
            .spawn(watches.run(id, terminal, client, events, token));
    }

    /// Ends the terminal's watch, telling nothing more of it, and starts none of it until the
    /// close the guard stands for has ended, nor after, of `terminal`'s holder, once it ends
    /// `closed`.
    pub(crate) fn closing(&self, terminal: &HolderRef) -> Closing<'_> {
        let terminal_id = terminal.terminal_id.clone();
        {
            let mut state = self.lock();
            *state.closing.entry(terminal_id.clone()).or_default() += 1;
            if let Some(watching) = state.watching.remove(&terminal_id) {
                watching.token.cancel();
            }
        }
        Closing {
            watches: self,
            terminal_id,
            holder: (terminal.locator.holder_pid, terminal.locator.holder_start),
            closed: false,
        }
    }

    /// Reaps a holder this process started once it exits, until shutdown lets it go.
    pub(crate) fn reap(&self, mut started: StartedHolder) {
        let token = self.token.clone();
        self.tasks.spawn(async move {
            let exited = pin!(started.exited());
            // Either it has exited and been reaped, or the daemon is going and leaves it running.
            drop(select(exited, pin!(token.cancelled())).await);
        });
    }

    /// Ends every watch and waits for every task.
    pub(crate) async fn shutdown(&self) {
        self.token.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }

    async fn run(
        self: Arc<Self>,
        id: u64,
        mut terminal: HolderRef,
        mut client: HolderClient,
        mut events: HolderEvents,
        token: CancellationToken,
    ) {
        let mut told = Told::default();
        let mut backoff = Backoff::default();
        let mut opened = Instant::now();
        self.caught_up(&mut terminal, client.hello(), &mut told);
        while let Some(event) = next(&token, &mut events).await {
            match event {
                Some(HolderEvent::Exited(exit)) => {
                    self.exited(&terminal, exit.generation, exit.status, &mut told);
                }
                Some(HolderEvent::Respawned(respawned)) => {
                    let locator = &mut terminal.locator;
                    locator.child_pid = respawned.child_pid;
                    locator.child_start = respawned.child_start;
                    locator.generation = Some(respawned.generation);
                    self.tell(RuntimeEvent::Respawned {
                        terminal: terminal.clone(),
                    });
                }
                Some(HolderEvent::Title(title)) => {
                    told.title = Some(title.text);
                    self.tell(RuntimeEvent::Title {
                        terminal_id: terminal.terminal_id.clone(),
                    });
                }
                Some(HolderEvent::Ended(_)) | None => {
                    backoff.ended(opened.elapsed());
                    match self.resume(&terminal, &token, &mut backoff).await {
                        Ok((again, more)) => {
                            self.caught_up(&mut terminal, again.hello(), &mut told);
                            (client, events) = (again, more);
                            opened = Instant::now();
                        }
                        Err(Unresumed::Lost) => {
                            self.lost(id, &terminal, &token);
                            break;
                        }
                        Err(Unresumed::Cancelled) => break,
                    }
                }
                Some(_) => {}
            }
        }
        drop(client);
        let mut state = self.lock();
        if state
            .watching
            .get(&terminal.terminal_id)
            .is_some_and(|w| w.id == id)
        {
            state.watching.remove(&terminal.terminal_id);
        }
    }

    /// Tells `terminal` lost, unless its watch has ended, or another has taken its place: done
    /// under the lock, so a loss is never told after a watch of the terminal's next holder has
    /// started, which would read as that one's.
    fn lost(&self, id: u64, terminal: &HolderRef, token: &CancellationToken) {
        let mut state = self.lock();
        let ours = state
            .watching
            .get(&terminal.terminal_id)
            .is_some_and(|w| w.id == id);
        if ours && !token.is_cancelled() {
            state.watching.remove(&terminal.terminal_id);
            self.tell(RuntimeEvent::Lost {
                terminal: terminal.clone(),
            });
        }
    }

    /// Asks the terminal's holder again until it answers, waiting longer each time, for as long
    /// as the host shows it running; lost once nothing listens, another answers, or it stops.
    async fn resume(
        &self,
        terminal: &HolderRef,
        token: &CancellationToken,
        backoff: &mut Backoff,
    ) -> Result<(HolderClient, HolderEvents), Unresumed> {
        loop {
            if !backoff.wait(token).await {
                return Err(Unresumed::Cancelled);
            }
            match self.again(terminal, token).await {
                Ok(connected) => return Ok(connected),
                Err(Unanswered::Gone) => return Err(Unresumed::Lost),
                Err(Unanswered::Cancelled) => return Err(Unresumed::Cancelled),
                Err(Unanswered::Silent) => {
                    if !terminal
                        .holder()
                        .is_some_and(|holder| (self.running.0)(holder))
                    {
                        return Err(Unresumed::Lost);
                    }
                }
            }
        }
    }

    /// One `hello` again at the terminal's socket, and the connection, if the watch's own holder
    /// answered.
    async fn again(
        &self,
        terminal: &HolderRef,
        token: &CancellationToken,
    ) -> Result<(HolderClient, HolderEvents), Unanswered> {
        let options = self.client_options(token);
        let connecting = pin!(connect(&terminal.locator.socket, &options));
        let Either::Right((connected, _)) = select(pin!(token.cancelled()), connecting).await
        else {
            return Err(Unanswered::Cancelled);
        };
        let (client, events) = connected.map_err(|e| match Unreached::from(e) {
            // A holder that shares no protocol with this build is never the one watched.
            Unreached::None { .. } | Unreached::Outdated { .. } => Unanswered::Gone,
            Unreached::Unreadable { .. } => Unanswered::Silent,
        })?;
        let hello = client.hello();
        let same = hello.terminal_id.as_str() == terminal.terminal_id.as_str()
            && terminal.locator.is_holder_of(hello);
        if same {
            Ok((client, events))
        } else {
            Err(Unanswered::Gone)
        }
    }

    /// Tells what `hello` shows that this watch hasn't told: a process it hasn't seen, an exit,
    /// and that the title may have changed, which a connection opened again tells only for a
    /// title other than the last it knew.
    fn caught_up(&self, terminal: &mut HolderRef, hello: &HelloReply, told: &mut Told) {
        let locator = &mut terminal.locator;
        if locator.generation != Some(hello.generation) || locator.child_pid != hello.child_pid {
            locator.child_pid = hello.child_pid;
            locator.child_start = hello.child_start;
            locator.generation = Some(hello.generation);
            self.tell(RuntimeEvent::Respawned {
                terminal: terminal.clone(),
            });
        }
        if let Some(status) = &hello.exit {
            self.exited(terminal, hello.generation, status.clone(), told);
        }
        if told.title.as_ref() != Some(&hello.title) {
            told.title = Some(hello.title.clone());
            self.tell(RuntimeEvent::Title {
                terminal_id: terminal.terminal_id.clone(),
            });
        }
    }

    /// Tells an exit, once for each generation.
    fn exited(
        &self,
        terminal: &HolderRef,
        generation: Generation,
        status: ExitStatus,
        told: &mut Told,
    ) {
        if told.exited == Some(generation) {
            return;
        }
        told.exited = Some(generation);
        self.tell(RuntimeEvent::Exited {
            terminal_id: terminal.terminal_id.clone(),
            generation,
            status,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use bazhen_holder_proto::Reply;
    use bazhen_holder_proto::body::{Exited, Offset, Respawned, Title};
    use tokio::net::UnixListener;

    use super::*;
    use crate::fake_holder::FakeHolder;
    use crate::fake_host::FakeHost;
    use crate::host::Host;
    use crate::locator::HolderLocator;
    use crate::test_support::{TempDir, block_on};

    /// Longer than any wait here should take, so a test that waits this long fails on what it
    /// asserts of what came, not on the run's own deadline.
    const PATIENCE: Duration = Duration::from_secs(10);

    fn terminal_id() -> TerminalId {
        TerminalId::mint(1, [7; 16])
    }

    fn named(hello: &mut HelloReply) {
        hello.terminal_id =
            bazhen_holder_proto::body::TerminalId::new(terminal_id().as_str()).unwrap();
    }

    fn generation(n: u64) -> Generation {
        Generation::new(n).unwrap()
    }

    fn exited(n: u64) -> Reply {
        Reply::Exited(Exited {
            generation: generation(n),
            status: ExitStatus::Unknown,
        })
    }

    fn told_exit(n: u64) -> RuntimeEvent {
        RuntimeEvent::Exited {
            terminal_id: terminal_id(),
            generation: generation(n),
            status: ExitStatus::Unknown,
        }
    }

    fn titled() -> RuntimeEvent {
        RuntimeEvent::Title {
            terminal_id: terminal_id(),
        }
    }

    fn title(text: &str) -> Reply {
        Reply::Title(Title {
            offset: Offset::new(0).unwrap(),
            text: text.to_owned(),
        })
    }

    fn respawned() -> Respawned {
        Respawned {
            generation: generation(1),
            child_pid: Pid::new(4300).unwrap(),
            child_start: StartTime::new(1_700_000_100).unwrap(),
        }
    }

    /// `terminal` once its holder has said `respawned`.
    fn after(terminal: &HolderRef, respawned: Respawned) -> HolderRef {
        let mut after = terminal.clone();
        after.locator.child_pid = respawned.child_pid;
        after.locator.child_start = respawned.child_start;
        after.locator.generation = Some(respawned.generation);
        after
    }

    /// Watches whose hello waits `hello`, and that take the holder watched for running while
    /// `runs` says so.
    fn watches(hello: Duration, runs: &Arc<std::sync::atomic::AtomicBool>) -> Arc<Watches> {
        let runs = Arc::clone(runs);
        Arc::new(Watches::new(
            hello,
            Running::new(move |_| runs.load(Ordering::Relaxed)),
        ))
    }

    fn running() -> Arc<std::sync::atomic::AtomicBool> {
        Arc::new(std::sync::atomic::AtomicBool::new(true))
    }

    /// `watches`' watch of a fake holder at `socket`, whose hello `edit` changes.
    async fn watching_with(
        watches: Arc<Watches>,
        socket: &Path,
        edit: impl FnOnce(&mut HelloReply),
    ) -> (
        Arc<Watches>,
        broadcast::Receiver<RuntimeEvent>,
        FakeHolder,
        HolderRef,
    ) {
        let told = watches.subscribe();
        let (client, events, holder) = FakeHolder::client_at(socket, |hello| {
            named(hello);
            edit(hello);
        })
        .await;
        let terminal = HolderRef {
            terminal_id: terminal_id(),
            locator: HolderLocator::of(socket.to_path_buf(), client.hello()),
        };
        watches.adopt(terminal.clone(), client, events);
        (watches, told, holder, terminal)
    }

    async fn watching(
        socket: &Path,
        edit: impl FnOnce(&mut HelloReply),
    ) -> (
        Arc<Watches>,
        broadcast::Receiver<RuntimeEvent>,
        FakeHolder,
        HolderRef,
    ) {
        watching_with(watches(Duration::from_secs(5), &running()), socket, edit).await
    }

    /// The next event told, or `None` if none comes within `PATIENCE`.
    async fn next(told: &mut broadcast::Receiver<RuntimeEvent>) -> Option<RuntimeEvent> {
        tokio::time::timeout(PATIENCE, told.recv())
            .await
            .ok()
            .map(Result::unwrap)
    }

    /// A listener at `socket` in place of the one there, so the watch's next hello reaches it.
    fn listen_again(socket: &Path) -> UnixListener {
        std::fs::remove_file(socket).unwrap();
        UnixListener::bind(socket).unwrap()
    }

    /// The next connection at `listener`, its hello answered as the watched holder's.
    async fn answered(listener: &UnixListener) -> FakeHolder {
        let (stream, _) = listener.accept().await.unwrap();
        let mut holder = FakeHolder::new(stream);
        holder.answer_hello_with(named).await;
        holder
    }

    #[test]
    fn tells_each_title_respawn_and_exit_its_holder_pushes_each_exit_once() {
        let dir = TempDir::new();
        block_on(async {
            let (watches, mut told, mut holder, terminal) =
                watching(&dir.path().join("t.sock"), |_| {}).await;
            assert_eq!(next(&mut told).await, Some(titled()));
            holder
                .send(&[
                    title("vim"),
                    exited(0),
                    exited(0),
                    Reply::Respawned(respawned()),
                    exited(1),
                ])
                .await;
            let mut seen = Vec::new();
            for _ in 0..4 {
                seen.push(next(&mut told).await);
            }
            assert_eq!(
                seen,
                [
                    Some(titled()),
                    Some(told_exit(0)),
                    Some(RuntimeEvent::Respawned {
                        terminal: after(&terminal, respawned())
                    }),
                    Some(told_exit(1))
                ]
            );
            // It never subscribes, nor asks anything else, and hangs up at shutdown.
            let (asked, ()) =
                futures_util::future::join(holder.until_eof(), watches.shutdown()).await;
            assert_eq!(asked, []);
        });
    }

    #[test]
    fn tells_an_exit_its_holder_said_before_the_watch_opened() {
        let dir = TempDir::new();
        block_on(async {
            let (watches, mut told, _holder, _) = watching(&dir.path().join("t.sock"), |h| {
                h.exit = Some(ExitStatus::Unknown);
            })
            .await;
            assert_eq!(
                [next(&mut told).await, next(&mut told).await],
                [Some(told_exit(0)), Some(titled())]
            );
            watches.shutdown().await;
        });
    }

    #[test]
    fn tells_a_holder_lost_once_it_hangs_up_and_its_socket_is_gone() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        block_on(async {
            let (watches, mut told, holder, terminal) = watching(&socket, |_| {}).await;
            assert_eq!(next(&mut told).await, Some(titled()));
            std::fs::remove_file(&socket).unwrap();
            drop(holder);
            assert_eq!(next(&mut told).await, Some(RuntimeEvent::Lost { terminal }));
            watches.shutdown().await;
        });
    }

    #[test]
    fn says_hello_again_once_dropped_resuming_on_the_same_holder_and_losing_another() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        let told: Vec<_> = [4242, 4999]
            .into_iter()
            .map(|pid| {
                block_on(async {
                    let (watches, mut told, holder, terminal) = watching(&socket, |_| {}).await;
                    assert_eq!(next(&mut told).await, Some(titled()));
                    let listener = listen_again(&socket);
                    drop(holder);
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut again = FakeHolder::new(stream);
                    let hello = again
                        .answer_hello_with(|h| {
                            named(h);
                            h.holder_pid = Pid::new(pid).unwrap();
                        })
                        .await;
                    assert_eq!(hello.writer, Some(false));
                    again.send(&[exited(0)]).await;
                    let first = next(&mut told).await;
                    if first != Some(told_exit(0)) {
                        // Not its holder: hung up on, nothing it says told.
                        assert_eq!(
                            tokio::time::timeout(PATIENCE, again.until_eof()).await.ok(),
                            Some(vec![])
                        );
                    }
                    std::fs::remove_file(&socket).unwrap();
                    watches.shutdown().await;
                    (first, terminal)
                })
            })
            .collect();
        let lost = RuntimeEvent::Lost {
            terminal: told[1].1.clone(),
        };
        let seen: Vec<_> = told.into_iter().map(|(seen, _)| seen).collect();
        assert_eq!(seen, [Some(told_exit(0)), Some(lost)]);
    }

    #[test]
    fn resumes_on_its_holder_after_a_refused_or_timed_out_hello_while_it_runs() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        let cases = [
            (false, Some(true)),
            (true, Some(true)),
            (false, None),
            (true, None),
        ];
        let seen: Vec<_> = cases
            .into_iter()
            .map(|(times_out, running)| {
                block_on(async {
                    let hello = Duration::from_millis(300);
                    let host: Box<dyn Host> = Box::new(FakeHost {
                        running,
                        ..FakeHost::default()
                    });
                    let watches = Arc::new(Watches::new(
                        hello,
                        Running::new(move |holder| host.may_run(holder)),
                    ));
                    let (watches, mut told, holder, _) =
                        watching_with(watches, &socket, |_| {}).await;
                    assert_eq!(next(&mut told).await, Some(titled()));
                    let listener = listen_again(&socket);
                    drop(holder);
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut unanswered = FakeHolder::new(stream);
                    if times_out {
                        // Read, and never answered, as by a holder too busy to.
                        drop(unanswered.request().await);
                    } else {
                        // Hung up on unanswered, as a holder serving all it can does.
                        drop(unanswered);
                    }
                    // A watch that gave up asks no more: what it told instead is what it saw.
                    let seen = match tokio::time::timeout(PATIENCE, answered(&listener)).await {
                        Ok(mut again) => {
                            again.send(&[exited(0)]).await;
                            next(&mut told).await
                        }
                        Err(_) => told.try_recv().ok(),
                    };
                    watches.shutdown().await;
                    std::fs::remove_file(&socket).unwrap();
                    seen
                })
            })
            .collect();
        assert_eq!(seen, vec![Some(told_exit(0)); 4]);
    }

    #[test]
    fn tells_a_holder_lost_once_it_wont_answer_and_no_longer_runs() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        block_on(async {
            let runs = running();
            let (watches, mut told, holder, terminal) =
                watching_with(watches(Duration::from_secs(5), &runs), &socket, |_| {}).await;
            assert_eq!(next(&mut told).await, Some(titled()));
            let listener = listen_again(&socket);
            runs.store(false, Ordering::Relaxed);
            drop(holder);
            let (stream, _) = listener.accept().await.unwrap();
            drop(stream);
            assert_eq!(next(&mut told).await, Some(RuntimeEvent::Lost { terminal }));
            watches.shutdown().await;
        });
    }

    #[test]
    fn asks_a_holder_that_keeps_hanging_up_ever_more_slowly_telling_nothing_it_told() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        block_on(async {
            let (watches, mut told, holder, _) = watching(&socket, |_| {}).await;
            assert_eq!(next(&mut told).await, Some(titled()));
            let listener = listen_again(&socket);
            drop(holder);
            let mut asked = Vec::new();
            for _ in 0..3 {
                let dropped = answered(&listener).await;
                asked.push(Instant::now());
                drop(dropped);
            }
            let mut steady = answered(&listener).await;
            asked.push(Instant::now());
            steady.send(&[exited(0)]).await;
            // Its title unchanged, no hello again tells it.
            assert_eq!(next(&mut told).await, Some(told_exit(0)));
            let gaps: Vec<_> = asked.windows(2).map(|w| w[1] - w[0]).collect();
            let waits = [FIRST_WAIT, FIRST_WAIT * 2, FIRST_WAIT * 4];
            assert!(
                gaps.iter().zip(waits).all(|(gap, wait)| *gap >= wait),
                "asked again after {gaps:?}, sooner than {waits:?}"
            );
            watches.shutdown().await;
        });
    }

    #[test]
    fn tells_no_respawn_exit_or_title_twice_across_a_hello_again_to_the_same_holder() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        block_on(async {
            let (watches, mut told, mut holder, terminal) = watching(&socket, |_| {}).await;
            holder
                .send(&[
                    title("vim"),
                    exited(0),
                    Reply::Respawned(respawned()),
                    exited(1),
                ])
                .await;
            let mut seen = Vec::new();
            for _ in 0..5 {
                seen.push(next(&mut told).await);
            }
            let listener = listen_again(&socket);
            drop(holder);
            let (stream, _) = listener.accept().await.unwrap();
            let mut again = FakeHolder::new(stream);
            again
                .answer_hello_with(|h| {
                    named(h);
                    h.generation = respawned().generation;
                    h.child_pid = respawned().child_pid;
                    h.child_start = respawned().child_start;
                    h.exit = Some(ExitStatus::Unknown);
                    "vim".clone_into(&mut h.title);
                })
                .await;
            // Told only once the hello again has told whatever it would: an exit, not a title,
            // so a title told again by the hello comes before it, and is seen.
            again.send(&[exited(2)]).await;
            seen.push(next(&mut told).await);
            let respawn = RuntimeEvent::Respawned {
                terminal: after(&terminal, respawned()),
            };
            assert_eq!(
                seen,
                [
                    Some(titled()),
                    Some(titled()),
                    Some(told_exit(0)),
                    Some(respawn),
                    Some(told_exit(1)),
                    Some(told_exit(2))
                ]
            );
            watches.shutdown().await;
        });
    }

    #[test]
    fn tells_nothing_more_of_a_terminal_being_closed_and_hangs_up_on_its_holder() {
        let dir = TempDir::new();
        block_on(async {
            let (watches, mut told, mut holder, terminal) =
                watching(&dir.path().join("t.sock"), |_| {}).await;
            assert_eq!(next(&mut told).await, Some(titled()));
            let closing = watches.closing(&terminal);
            assert_eq!(
                tokio::time::timeout(PATIENCE, holder.until_eof())
                    .await
                    .ok(),
                Some(vec![])
            );
            drop(closing);
            watches.shutdown().await;
            assert!(matches!(
                told.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
        });
    }

    #[test]
    fn watches_no_holder_being_closed_nor_once_closed_but_one_whose_close_failed() {
        let dir = TempDir::new();
        let socket = dir.path().join("t.sock");
        // Whether the close has ended, and whether it closed the holder, as an inventory that
        // reached the holder before it adopts it.
        let watched = [(false, false), (true, false), (true, true)].map(|(ended, closed)| {
            block_on(async {
                let watches = watches(Duration::from_secs(5), &running());
                let mut told = watches.subscribe();
                let (client, events, _holder) = FakeHolder::client_at(&socket, named).await;
                let terminal = HolderRef {
                    terminal_id: terminal_id(),
                    locator: HolderLocator::of(socket.clone(), client.hello()),
                };
                let closing = watches.closing(&terminal);
                let under_way = match (ended, closed) {
                    (false, _) => Some(closing),
                    (true, true) => {
                        closing.closed();
                        None
                    }
                    (true, false) => {
                        drop(closing);
                        None
                    }
                };
                watches.adopt(terminal, client, events);
                drop(under_way);
                // A watch tells the title as it opens, before shutdown can end it.
                watches.shutdown().await;
                std::fs::remove_file(&socket).unwrap();
                told.try_recv().ok()
            })
        });
        assert_eq!(watched, [None, Some(titled()), None]);
    }
}
