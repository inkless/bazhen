//! What the runtime hears of its holders without asking: one connection to each live holder,
//! never subscribed, so its holder sends it only what it pushes to every connection, `exited`,
//! `respawned` and `title`, and its holder's death hangs it up. Nothing polls. A connection that
//! ends gets one `hello` again, which tells a holder that dropped it, as one serving all the
//! connections it can drops one, from a holder that has gone.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bazhen_holder_proto::body::{ExitStatus, Generation, HelloReply, Pid, StartTime};
use bazhen_host_guard::holder::StartedHolder;
use bazhen_protocol::ids::TerminalId;
use futures_util::future::{Either, select};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::client::{ClientOptions, HolderClient, HolderEvent, HolderEvents, connect};
use crate::locator::HolderRef;

/// How many events wait for a subscriber that is slow to take them, past which it is told it
/// missed some, and reads the inventory again.
pub const EVENTS_KEPT: usize = 1024;

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
    /// The terminal's title may have changed, for `title` to read: as its watch opens, and each
    /// time its program sets one. The title itself isn't told, as one told could be read after a
    /// respawn it predates.
    Title { terminal_id: TerminalId },
    /// The holder hung up and no holder of the terminal answers again: it has gone, or its
    /// socket has, which `gone` and `health` tell apart.
    Lost { terminal: HolderRef },
}

/// One watch, of one holder of a terminal.
#[derive(Debug)]
struct Watching {
    holder: (Pid, StartTime),
    token: CancellationToken,
    id: u64,
}

/// Every watch, and the holders the runtime started, which it reaps.
#[derive(Debug)]
pub(crate) struct Watches {
    hello: Duration,
    events: broadcast::Sender<RuntimeEvent>,
    watching: Mutex<HashMap<TerminalId, Watching>>,
    next: AtomicU64,
    /// Cancelled at shutdown: every watch and every connection of the runtime ends.
    pub(crate) token: CancellationToken,
    pub(crate) tasks: TaskTracker,
}

impl Watches {
    pub(crate) fn new(hello: Duration) -> Self {
        Self {
            hello,
            events: broadcast::Sender::new(EVENTS_KEPT),
            watching: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
            token: CancellationToken::new(),
            tasks: TaskTracker::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<TerminalId, Watching>> {
        // Each change under the lock is one insert or remove, which a panic leaves whole.
        self.watching.lock().unwrap_or_else(PoisonError::into_inner)
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
    /// holder is watched already; a watch of another holder of the terminal ends.
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
            let mut watching = self.lock();
            if let Some(current) = watching.get(&terminal.terminal_id) {
                if current.holder == holder {
                    return;
                }
                current.token.cancel();
            }
            watching.insert(
                terminal.terminal_id.clone(),
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

    /// Ends the terminal's watch, telling nothing more of it.
    pub(crate) fn forget(&self, terminal_id: &TerminalId) {
        if let Some(watching) = self.lock().remove(terminal_id) {
            watching.token.cancel();
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
        let mut exited = None;
        self.caught_up(&mut terminal, client.hello(), &mut exited);
        while let Some(event) = next(&token, &mut events).await {
            match event {
                Some(HolderEvent::Exited(exit)) => {
                    self.exited(&terminal, exit.generation, exit.status, &mut exited);
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
                Some(HolderEvent::Title(_)) => self.tell(RuntimeEvent::Title {
                    terminal_id: terminal.terminal_id.clone(),
                }),
                Some(HolderEvent::Ended(_)) | None => {
                    let Some((again, more)) = self.again(&terminal, &token).await else {
                        if !token.is_cancelled() {
                            self.tell(RuntimeEvent::Lost {
                                terminal: terminal.clone(),
                            });
                        }
                        break;
                    };
                    self.caught_up(&mut terminal, again.hello(), &mut exited);
                    (client, events) = (again, more);
                }
                Some(_) => {}
            }
        }
        drop(client);
        let mut watching = self.lock();
        if watching
            .get(&terminal.terminal_id)
            .is_some_and(|w| w.id == id)
        {
            watching.remove(&terminal.terminal_id);
        }
    }

    /// One `hello` again at the terminal's socket: a connection to the same holder, or `None`
    /// for none, or another.
    async fn again(
        &self,
        terminal: &HolderRef,
        token: &CancellationToken,
    ) -> Option<(HolderClient, HolderEvents)> {
        let socket: PathBuf = terminal.locator.socket.clone();
        let options = self.client_options(token);
        let connecting = pin!(connect(&socket, &options));
        let Either::Right((connected, _)) = select(pin!(token.cancelled()), connecting).await
        else {
            return None;
        };
        let (client, events) = connected.ok()?;
        let hello = client.hello();
        let same = hello.terminal_id.as_str() == terminal.terminal_id.as_str()
            && terminal.locator.is_holder_of(hello);
        same.then_some((client, events))
    }

    /// Tells what `hello` shows that this watch hasn't told: a process it hasn't seen, an exit,
    /// and that the title may have changed.
    fn caught_up(
        &self,
        terminal: &mut HolderRef,
        hello: &HelloReply,
        exited: &mut Option<Generation>,
    ) {
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
            self.exited(terminal, hello.generation, status.clone(), exited);
        }
        self.tell(RuntimeEvent::Title {
            terminal_id: terminal.terminal_id.clone(),
        });
    }

    /// Tells an exit, once for each generation.
    fn exited(
        &self,
        terminal: &HolderRef,
        generation: Generation,
        status: ExitStatus,
        exited: &mut Option<Generation>,
    ) {
        if *exited == Some(generation) {
            return;
        }
        *exited = Some(generation);
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
    use crate::locator::HolderLocator;
    use crate::test_support::{TempDir, block_on};

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

    /// The watch of a fake holder at `socket`, whose hello `edit` changes.
    async fn watching(
        socket: &Path,
        edit: impl FnOnce(&mut HelloReply),
    ) -> (
        Arc<Watches>,
        broadcast::Receiver<RuntimeEvent>,
        FakeHolder,
        HolderRef,
    ) {
        let watches = Arc::new(Watches::new(Duration::from_secs(5)));
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

    async fn next(told: &mut broadcast::Receiver<RuntimeEvent>) -> RuntimeEvent {
        told.recv().await.unwrap()
    }

    #[test]
    fn tells_each_title_respawn_and_exit_its_holder_pushes_each_exit_once() {
        let dir = TempDir::new();
        block_on(async {
            let (watches, mut told, mut holder, terminal) =
                watching(&dir.path().join("t.sock"), |_| {}).await;
            assert_eq!(next(&mut told).await, titled());
            let respawned = Respawned {
                generation: generation(1),
                child_pid: Pid::new(4300).unwrap(),
                child_start: StartTime::new(1_700_000_100).unwrap(),
            };
            let title = Title {
                offset: Offset::new(0).unwrap(),
                text: "vim".to_owned(),
            };
            holder
                .send(&[
                    Reply::Title(title),
                    exited(0),
                    exited(0),
                    Reply::Respawned(respawned),
                    exited(1),
                ])
                .await;
            let mut after = terminal.clone();
            after.locator.child_pid = respawned.child_pid;
            after.locator.child_start = respawned.child_start;
            after.locator.generation = Some(generation(1));
            let mut seen = Vec::new();
            for _ in 0..4 {
                seen.push(next(&mut told).await);
            }
            assert_eq!(
                seen,
                [
                    titled(),
                    told_exit(0),
                    RuntimeEvent::Respawned { terminal: after },
                    told_exit(1)
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
                [told_exit(0), titled()]
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
            assert_eq!(next(&mut told).await, titled());
            std::fs::remove_file(&socket).unwrap();
            drop(holder);
            assert_eq!(next(&mut told).await, RuntimeEvent::Lost { terminal });
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
                    assert_eq!(next(&mut told).await, titled());
                    std::fs::remove_file(&socket).unwrap();
                    let listener = UnixListener::bind(&socket).unwrap();
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
                    let seen = if first == titled() {
                        vec![first, next(&mut told).await]
                    } else {
                        // Not its holder: hung up on, nothing it says told.
                        assert_eq!(again.until_eof().await, []);
                        vec![first]
                    };
                    std::fs::remove_file(&socket).unwrap();
                    watches.shutdown().await;
                    (seen, terminal)
                })
            })
            .collect();
        let lost = RuntimeEvent::Lost {
            terminal: told[1].1.clone(),
        };
        let seen: Vec<_> = told.into_iter().map(|(seen, _)| seen).collect();
        assert_eq!(seen, [vec![titled(), told_exit(0)], vec![lost]]);
    }

    #[test]
    fn tells_nothing_more_of_a_terminal_forgotten_and_hangs_up_on_its_holder() {
        let dir = TempDir::new();
        block_on(async {
            let (watches, mut told, mut holder, terminal) =
                watching(&dir.path().join("t.sock"), |_| {}).await;
            assert_eq!(next(&mut told).await, titled());
            watches.forget(&terminal.terminal_id);
            assert_eq!(holder.until_eof().await, []);
            watches.shutdown().await;
            assert!(matches!(
                told.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
        });
    }
}
