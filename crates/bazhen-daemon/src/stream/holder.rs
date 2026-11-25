//! The hub's runtime: a terminal's stream from the holder the store records it on, as the
//! TypeScript daemon's `HolderRuntime.attach` opens one.

use std::sync::Arc;

use bazhen_holder_proto::body::Size;
use bazhen_protocol::ids::TerminalId;
use bazhen_runtime_holder::{
    self as holder, HolderLocator, HolderRef, HolderRuntime, HolderStream, RuntimeError,
    StreamError, StreamEvents,
};

use super::hub::{Opened, Runtime, StreamEnd, StreamEvent, TerminalEvents, TerminalStream};
use super::screen::Snapshot;
use super::seam::Position;
use crate::shells::RUNTIME;
use crate::writer::Writer;

/// Streams from each terminal's holder.
#[derive(Debug, Clone)]
pub(crate) struct HolderStreams {
    store: Writer,
    runtime: Arc<HolderRuntime>,
}

impl HolderStreams {
    pub(crate) fn new(store: Writer, runtime: Arc<HolderRuntime>) -> Self {
        Self { store, runtime }
    }
}

/// Why a terminal's stream didn't open.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OpenError {
    #[error("no running terminal {0}")]
    NotRunning(TerminalId),
    /// It runs on a runtime this daemon doesn't run, as a terminal on tmux does.
    #[error("terminal {0}: no {1} runtime here")]
    UnknownRuntime(TerminalId, String),
    #[error("terminal {0}: its holder's locator can't be read: {1}")]
    Locator(TerminalId, String),
    #[error("bazhen can't read the terminal: {0}")]
    Store(String),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
}

/// The runtime and locator of the incarnation `terminal` runs in, as the store records it, or
/// `None` for one that isn't running in any: `runtimeRef` in the TypeScript store.
///
/// # Errors
///
/// When the store can't be read.
pub(crate) async fn recorded(
    store: &Writer,
    terminal: &TerminalId,
) -> Result<Option<(String, String)>, String> {
    let id = terminal.clone();
    let row = store
        .run(move |store| store.reads().runtime_row(id.as_str()))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    Ok(row.and_then(|row| Some((row.runtime, row.locator?))))
}

impl Runtime for HolderStreams {
    type Stream = HolderStream;
    type Events = StreamEvents;
    type Error = OpenError;

    async fn attach(
        &self,
        terminal: &TerminalId,
        size: Option<Size>,
    ) -> Result<Opened<HolderStream, StreamEvents>, OpenError> {
        let (runtime, locator) = recorded(&self.store, terminal)
            .await
            .map_err(OpenError::Store)?
            .ok_or_else(|| OpenError::NotRunning(terminal.clone()))?;
        if runtime != RUNTIME {
            return Err(OpenError::UnknownRuntime(terminal.clone(), runtime));
        }
        let locator = HolderLocator::decode(&locator)
            .map_err(|err| OpenError::Locator(terminal.clone(), err.to_string()))?;
        let found = HolderRef {
            terminal_id: terminal.clone(),
            locator,
        };
        let attached = self.runtime.attach(&found, size).await?;
        Ok(Opened {
            snapshot: Snapshot::new(
                attached.vt().to_vec(),
                Position {
                    generation: attached.generation.get(),
                    offset: attached.offset.get(),
                },
            ),
            size: attached.stream.size(),
            history_lines: attached.history_lines.get(),
            stream: attached.stream,
            events: attached.events,
        })
    }
}

impl TerminalStream for HolderStream {
    type Error = StreamError;

    fn size(&self) -> Size {
        HolderStream::size(self)
    }

    fn write(&self, input: &[u8]) {
        HolderStream::write(self, input);
    }

    async fn resize(&self, size: Size) -> Result<(), StreamError> {
        HolderStream::resize(self, size).await
    }

    async fn snapshot(&self) -> Result<Snapshot, StreamError> {
        let taken = HolderStream::snapshot(self).await?;
        let at = Position {
            generation: taken.generation.get(),
            offset: taken.offset.get(),
        };
        Ok(Snapshot::new(taken.bytes, at))
    }

    fn close(&self) {
        HolderStream::close(self);
    }
}

impl TerminalEvents for StreamEvents {
    async fn recv(&mut self) -> Option<StreamEvent> {
        StreamEvents::recv(self).await.map(told)
    }
}

/// A holder stream's event, as the hub takes it.
fn told(event: holder::StreamEvent) -> StreamEvent {
    match event {
        holder::StreamEvent::Data { at, bytes } => StreamEvent::Data {
            at: Position {
                generation: at.generation.get(),
                offset: at.offset.get(),
            },
            output: bytes,
        },
        holder::StreamEvent::Respawned { generation } => StreamEvent::Respawned {
            generation: generation.get(),
        },
        holder::StreamEvent::Exited(exit) => StreamEvent::Exited(exit),
        holder::StreamEvent::Resized(size) => StreamEvent::Resized(size),
        holder::StreamEvent::Failed(failure) => StreamEvent::Failed {
            what: failure.what,
            message: failure.cause.to_string(),
        },
        holder::StreamEvent::Closed(holder::StreamEnd::Ended) => {
            StreamEvent::Closed(StreamEnd::Ended)
        }
        holder::StreamEvent::Closed(holder::StreamEnd::Behind) => {
            StreamEvent::Closed(StreamEnd::Behind)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tests::{request, stubbed};
    use crate::testing::runtime;
    use crate::testing::stub_harness::{StubHarness, pull};

    #[test]
    fn finds_an_agents_terminal_where_its_runtime_keeps_it_as_it_does_a_shells() {
        let f = stubbed(&StubHarness::new(pull()));
        let launched = runtime().block_on(f.launch(request("k-1"))).unwrap();
        let terminal = launched.terminal_id.clone().unwrap();
        let row = f
            .store
            .reader()
            .unwrap()
            .reads()
            .runtime_row(terminal.as_str())
            .unwrap()
            .unwrap();
        let missing = TerminalId::parse("term_0190a1b2c3d47abc8def0123456789a1").unwrap();
        assert_eq!(
            runtime().block_on(async {
                (
                    recorded(&f.store, &terminal).await.unwrap(),
                    recorded(&f.store, &missing).await.unwrap(),
                )
            }),
            (Some((row.runtime, row.locator.unwrap())), None)
        );
    }
}
