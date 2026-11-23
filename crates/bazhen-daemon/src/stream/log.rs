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
            .run(move |store| store.reads().shell(id.as_str()))
            .await;
        match read {
            Ok(Ok(row)) => row.is_some_and(|row| {
                matches!(row.state, TerminalState::Closing | TerminalState::Closed)
            }),
            Ok(Err(err)) => {
                tracing::warn!("bazhen: can't read whether terminal {terminal} is closing: {err}");
                false
            }
            Err(_) => false,
        }
    }

    /// An agent's lifecycle hears its exit on the TypeScript daemon; this one runs shells only,
    /// which hear theirs from the runtime's own events.
    fn exited(
        &self,
        _: &TerminalId,
        _: &Exited,
    ) -> impl Future<Output = Result<(), LogError>> + Send {
        std::future::ready(Ok(()))
    }
}
