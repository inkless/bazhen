//! What the hub records of its views, in the store, as `storeLog` in
//! `apps/daemon/src/stream/log.ts` does, with the hook `main.ts` adds to it: a view opening on a
//! shell reads what runs in it now.

use std::sync::Arc;

use bazhen_holder_proto::body::Exited;
use bazhen_protocol::events::{
    AttachmentEndReason, AttachmentEnded, AttachmentStarted, LeaseGranted,
};
use bazhen_protocol::ids::{AttachmentId, TerminalId};
use bazhen_protocol::shells::TerminalState;
use bazhen_protocol::stream::AttachmentMode;
use bazhen_store::{AppendError, NewEvent};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::hub::AttachmentLog;
use super::lease::Epoch;
use crate::shells::Shells;
use crate::writer::{Closed, Writer};

/// The store, and the shells whose foregrounds a view opening is to see.
#[derive(Debug, Clone)]
pub(crate) struct StoreLog {
    store: Writer,
    shells: Arc<Shells>,
    tasks: TaskTracker,
    stop: CancellationToken,
}

impl StoreLog {
    /// Reads of foregrounds run on `tasks`, and end at `stop`.
    pub(crate) fn new(
        store: Writer,
        shells: Arc<Shells>,
        tasks: TaskTracker,
        stop: CancellationToken,
    ) -> Self {
        Self {
            store,
            shells,
            tasks,
            stop,
        }
    }

    /// Appends `event` behind whatever was queued before it, saying why if it can't.
    fn append(&self, event: NewEvent) {
        let queued = self.store.queue(move |store| {
            if let Err(err) = store.write(|w| -> Result<u64, AppendError> { w.append(&event) }) {
                tracing::error!("bazhen: can't record a view of a terminal: {err}");
            }
        });
        if queued.is_err() {
            tracing::warn!("bazhen: a view of a terminal went unrecorded: the store has closed");
        }
    }
}

/// Why what the log reads couldn't be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LogError {
    #[error(transparent)]
    Closed(#[from] Closed),
    #[error(transparent)]
    Store(#[from] rusqlite::Error),
    #[error(transparent)]
    Append(#[from] AppendError),
}

impl AttachmentLog for StoreLog {
    type Error = LogError;

    fn started(&self, attachment: &AttachmentId, terminal: &TerminalId, mode: AttachmentMode) {
        self.append(NewEvent::AttachmentStarted {
            attachment: attachment.clone(),
            payload: AttachmentStarted {
                terminal_id: terminal.clone(),
                mode,
            },
        });
        let (store, shells, id) = (
            self.store.clone(),
            Arc::clone(&self.shells),
            terminal.clone(),
        );
        self.tasks
            .spawn(self.stop.clone().run_until_cancelled_owned(async move {
                let shell = store
                    .run(move |store| store.reads().shell(id.as_str()))
                    .await;
                if matches!(shell, Ok(Ok(Some(_)))) {
                    shells.refresh_foregrounds().await;
                }
            }));
    }

    fn ended(&self, attachment: &AttachmentId, reason: AttachmentEndReason) {
        self.append(NewEvent::AttachmentEnded {
            attachment: attachment.clone(),
            payload: AttachmentEnded { reason },
        });
    }

    fn granted(&self, terminal: &TerminalId, attachment: &AttachmentId, epoch: Epoch) {
        self.append(NewEvent::LeaseGranted {
            terminal: terminal.clone(),
            payload: LeaseGranted {
                attachment_id: attachment.clone(),
                epoch: epoch.get(),
            },
        });
    }

    async fn epoch(&self, terminal: &TerminalId) -> Result<Epoch, LogError> {
        let id = terminal.clone();
        let epoch = self
            .store
            .run(move |store| store.reads().lease_epoch(&id))
            .await??;
        Ok(Epoch::new(epoch))
    }

    async fn closing(&self, terminal: &TerminalId) -> bool {
        let id = terminal.clone();
        let read = self
            .store
            .run(move |store| store.reads().terminal_state(id.as_str()))
            .await;
        match read {
            Ok(Ok(state)) => matches!(state, Some(TerminalState::Closing | TerminalState::Closed)),
            Ok(Err(err)) => {
                tracing::warn!("bazhen: can't read whether terminal {terminal} is closing: {err}");
                false
            }
            Err(_) => false,
        }
    }

    /// An agent's exit is its lifecycle's to record (`told`); a shell hears its own from the
    /// runtime's events.
    async fn exited(&self, terminal: &TerminalId, exit: &Exited) -> Result<(), LogError> {
        let (terminal, exit) = (terminal.clone(), exit.clone());
        self.store
            .run(move |store| store.write(|w| crate::agents::lifecycle::told(w, &terminal, &exit)))
            .await??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use bazhen_holder_proto::body::{ExitCode, ExitStatus, Generation};
    use tokio_util::sync::CancellationToken;
    use tokio_util::task::TaskTracker;

    use super::*;
    use crate::shells::tests::{Harness, agent, setup};
    use crate::testing::runtime;

    fn log(h: &Harness) -> StoreLog {
        StoreLog::new(
            h.store.clone(),
            Arc::clone(&h.shells),
            TaskTracker::new(),
            CancellationToken::new(),
        )
    }

    /// Runs `sql` on the store, as no command would, to set a terminal up.
    async fn rewrite(h: &Harness, sql: String) {
        h.store
            .run(move |store| {
                store.write(|w| -> rusqlite::Result<()> { w.connection().execute_batch(&sql) })
            })
            .await
            .unwrap()
            .unwrap();
    }

    fn exit(generation: u64, code: i64) -> Exited {
        Exited {
            generation: Generation::new(generation).unwrap(),
            status: ExitStatus::Exited {
                code: ExitCode::new(code).unwrap(),
            },
        }
    }

    #[test]
    fn records_an_agent_s_exit_told_at_its_generation_once_and_no_other() {
        let h = setup(100);
        runtime().block_on(async {
            let live = agent(1);
            h.launched(&live, "/repo/live").await;
            let current = h.open("a").await.unwrap();
            let shell = h.open("b").await.unwrap();
            rewrite(
                &h,
                format!(
                    "UPDATE terminals SET kind = 'agent', agent_session_id = '{live}',
                       generation = 2 WHERE id = '{current}';
                     UPDATE agent_sessions SET terminal_id = '{current}' WHERE id = '{live}';"
                ),
            )
            .await;
            let log = log(&h);
            let id = |id: &str| TerminalId::parse(id).unwrap();
            let told = [
                log.exited(&id(&current), &exit(1, 9)).await,
                log.exited(&id(&shell), &exit(0, 9)).await,
                log.exited(&id(&current), &exit(2, 3)).await,
                log.exited(&id(&current), &exit(2, 4)).await,
            ]
            .map(|told| told.is_ok());
            let (exits, state) = h
                .store
                .run(move |store| {
                    let reads = store.reads();
                    let exits: Vec<String> = reads
                        .events(0, 100)
                        .unwrap()
                        .into_iter()
                        .filter(|e| e.kind == "agent.exited")
                        .map(|e| e.entity_id + " " + &e.actor + " " + &e.payload)
                        .collect();
                    (exits, reads.agent_state(live.as_str()).unwrap())
                })
                .await
                .unwrap();
            assert_eq!(
                (told, exits, state, h.state_of(&shell)),
                (
                    [true; 4],
                    vec![format!(
                        r#"{} system {{"exit":{{"type":"exited","code":3}}}}"#,
                        agent(1)
                    )],
                    Some("exited".to_owned()),
                    Some(TerminalState::Running)
                )
            );
        });
    }

    #[test]
    fn reads_an_agent_s_terminal_closing_as_it_reads_a_shell_s() {
        let h = setup(100);
        runtime().block_on(async {
            let closing = h.open("a").await.unwrap();
            let running = h.open("b").await.unwrap();
            let agent = |id: &str, state: &str| {
                format!("UPDATE terminals SET kind = 'agent', state = '{state}' WHERE id = '{id}';")
            };
            let sql = agent(&closing, "closing") + &agent(&running, "running");
            rewrite(&h, sql).await;
            let log = log(&h);
            let read = |id: &str| TerminalId::parse(id).unwrap();
            assert_eq!(
                [
                    log.closing(&read(&closing)).await,
                    log.closing(&read(&running)).await,
                    log.closing(&TerminalId::mint(1, [9; 16])).await,
                ],
                [true, false, false]
            );
        });
    }
}
