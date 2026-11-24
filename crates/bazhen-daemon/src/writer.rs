//! The store's one writing connection, on a thread of its own: routes send it work and await the
//! answer, and every commit that adds an event wakes whoever waits for new ones. Reads open
//! connections of their own, so none waits behind a write.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;

use bazhen_store::{Reader, Store};
use tokio::sync::{oneshot, watch};

/// A job, which answers what to send whoever asked once the commit it made is announced.
type Job = Box<dyn FnOnce(&mut Store) -> Reply + Send>;
type Reply = Box<dyn FnOnce() + Send>;

enum Work {
    Job(Job),
    Close,
}

/// The store has closed: the daemon is stopping.
#[derive(Debug, thiserror::Error)]
#[error("the store has closed")]
pub(crate) struct Closed;

/// A handle on the writer thread, cloned into whatever writes.
#[derive(Debug, Clone)]
pub(crate) struct Writer {
    work: mpsc::Sender<Work>,
    committed: watch::Receiver<u64>,
    path: PathBuf,
}

/// The writer thread, joined once the daemon has stopped serving.
#[derive(Debug)]
pub(crate) struct Thread {
    work: mpsc::Sender<Work>,
    thread: JoinHandle<()>,
}

impl std::fmt::Debug for Work {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Job(_) => "Job",
            Self::Close => "Close",
        })
    }
}

/// Moves `store`, opened at `path`, onto a thread of its own.
///
/// # Errors
///
/// The OS's, when it can't start a thread, or `SQLite`'s reading the newest event.
pub(crate) fn start(store: Store, path: &Path) -> std::io::Result<(Writer, Thread)> {
    let newest = store
        .reads()
        .latest_event_id()
        .map_err(std::io::Error::other)?;
    let (committed_tx, committed) = watch::channel(newest);
    let (work, jobs) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("store-writer".to_owned())
        .spawn(move || own(store, &jobs, &committed_tx))?;
    Ok((
        Writer {
            work: work.clone(),
            committed,
            path: path.to_owned(),
        },
        Thread { work, thread },
    ))
}

/// Runs each job in turn, then says what was committed, before the job's answer goes out, so
/// whoever is answered can't see the newest id behind its own event. The id moves only when a
/// job's transaction added an event and committed it.
fn own(mut store: Store, jobs: &mpsc::Receiver<Work>, committed: &watch::Sender<u64>) {
    for work in jobs {
        let Work::Job(job) = work else { return };
        let reply = job(&mut store);
        match store.reads().latest_event_id() {
            Ok(id) => {
                committed.send_if_modified(|seen| std::mem::replace(seen, id) != id);
            }
            Err(err) => tracing::error!("bazhen: can't read the newest event: {err}"),
        }
        reply();
    }
}

impl Writer {
    /// Runs `job` on the writing connection and answers what it answered.
    ///
    /// # Errors
    ///
    /// [`Closed`] once the daemon has closed the store.
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut Store) -> T + Send + 'static,
    ) -> Result<T, Closed> {
        let (answer, answered) = oneshot::channel();
        let job: Job = Box::new(move |store| {
            let out = job(store);
            Box::new(move || {
                // Whoever asked may have gone; the job ran all the same.
                let _ = answer.send(out);
            })
        });
        self.work.send(Work::Job(job)).map_err(|_| Closed)?;
        answered.await.map_err(|_| Closed)
    }

    /// Queues `job` on the writing connection at once, without waiting for it, so what is
    /// queued from code that can't wait runs in the order it was queued, ahead of anything
    /// queued after it.
    ///
    /// # Errors
    ///
    /// [`Closed`] once the daemon has closed the store.
    pub(crate) fn queue(
        &self,
        job: impl FnOnce(&mut Store) + Send + 'static,
    ) -> Result<(), Closed> {
        let job: Job = Box::new(move |store| {
            job(store);
            Box::new(|| {})
        });
        self.work.send(Work::Job(job)).map_err(|_| Closed)
    }

    /// The id of the newest event committed, changing as each commit adds one.
    pub(crate) fn committed(&self) -> watch::Receiver<u64> {
        self.committed.clone()
    }

    /// A read-only connection of its own.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub(crate) fn reader(&self) -> rusqlite::Result<Reader> {
        Reader::open(&self.path)
    }
}

#[cfg(test)]
impl Writer {
    /// A writer whose store has already closed, for routes that never reach it.
    pub(crate) fn closed() -> Self {
        let (work, _) = mpsc::channel();
        Self {
            work,
            committed: watch::channel(0).1,
            path: PathBuf::from("/nonexistent/bazhen.db"),
        }
    }
}

impl Thread {
    /// Closes the store once the work sent before this is done, and waits for that. Work sent
    /// after is refused as [`Closed`].
    pub(crate) fn finish(self) {
        let _ = self.work.send(Work::Close);
        if self.thread.join().is_err() {
            tracing::error!("bazhen: the store's writer panicked");
        }
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::events::TaskCreated;
    use bazhen_protocol::ids::TaskId;
    use bazhen_protocol::nullable::Nullable;
    use bazhen_store::{AppendError, NewEvent};

    use super::*;
    use crate::testing::{TempDir, runtime};

    fn created(n: u8) -> NewEvent {
        NewEvent::TaskCreated {
            task: TaskId::mint(1, [n; 16]),
            actor: "human".to_owned(),
            payload: TaskCreated {
                title: "Ship".to_owned(),
                brief: "b".to_owned(),
                owner_agent_id: None,
                parent_task_id: None,
                delegated_from: Nullable::Null,
            },
        }
    }

    fn open(dir: &TempDir) -> (Writer, Thread) {
        let path = dir.path().join("bazhen.db");
        start(Store::open(&path).unwrap(), &path).unwrap()
    }

    #[test]
    fn wakes_watchers_on_a_commit_that_adds_an_event_and_on_nothing_else() {
        let dir = TempDir::new("writer-commits");
        let (writer, thread) = open(&dir);
        runtime().block_on(async {
            let mut committed = writer.committed();
            let failed: Result<u64, AppendError> = writer
                .run(|store| {
                    store.write(|w| {
                        w.append(&created(1))?;
                        Err(AppendError::NoHost)
                    })
                })
                .await
                .unwrap();
            assert!(failed.is_err());
            writer.run(|_| ()).await.unwrap();
            assert!(!committed.has_changed().unwrap());
            let id = writer
                .run(|store| store.write(|w| w.append(&created(2))))
                .await
                .unwrap()
                .unwrap();
            assert!(committed.has_changed().unwrap());
            assert_eq!(*committed.borrow_and_update(), id);
        });
        thread.finish();
    }

    #[test]
    fn reads_what_was_committed_on_a_connection_of_its_own() {
        let dir = TempDir::new("writer-reader");
        let (writer, thread) = open(&dir);
        let id = runtime()
            .block_on(writer.run(|store| store.write(|w| w.append(&created(1)))))
            .unwrap()
            .unwrap();
        assert_eq!(
            writer.reader().unwrap().reads().latest_event_id().unwrap(),
            id
        );
        thread.finish();
    }

    #[test]
    fn finishes_the_work_sent_before_it_closes_and_refuses_what_comes_after() {
        let dir = TempDir::new("writer-close");
        let (writer, thread) = open(&dir);
        let runtime = runtime();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let mut held = std::pin::pin!(writer.run(move |_| gate.recv().is_ok()));
        let mut before = std::pin::pin!(writer.run(|store| store.write(|w| w.append(&created(1)))));
        // Polled once, each job is queued, the first holding the writer until it is released, so
        // the second can't have been answered; then the store is closed behind them.
        runtime.block_on(async {
            tokio::select! {
                biased;
                _ = &mut held => panic!("released before it was let go"),
                _ = &mut before => panic!("answered before the writer was asked to close"),
                () = std::future::ready(()) => {}
            }
        });
        release.send(()).unwrap();
        thread.finish();
        assert!(matches!(runtime.block_on(held), Ok(true)));
        assert!(matches!(runtime.block_on(before), Ok(Ok(1))));
        assert!(runtime.block_on(writer.run(|_| ())).is_err());
    }
}
