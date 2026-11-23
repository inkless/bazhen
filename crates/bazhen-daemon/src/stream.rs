//! A terminal's live views, as `apps/daemon/src/stream` keeps them: one stream from the terminal's
//! holder shared by every view on it, each view opened on a snapshot seamed to the output that
//! follows, the lease over who drives, and the size the driver's window sets.

pub(crate) mod closing;
pub(crate) mod holder;
pub(crate) mod hub;
pub(crate) mod lease;
pub(crate) mod log;
pub(crate) mod route;
pub(crate) mod screen;
pub(crate) mod seam;
pub(crate) mod view;

use std::sync::Arc;

use bazhen_runtime_holder::HolderRuntime;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::shells::Shells;
use crate::writer::Writer;

/// The views of terminals on `runtime`, if there is one, recorded in `store`, each socket served
/// on `tracker`; what they do ends at `stop`.
pub(crate) fn on_holders(
    store: &Writer,
    runtime: Option<Arc<HolderRuntime>>,
    shells: &Arc<Shells>,
    tracker: &TaskTracker,
    stop: &CancellationToken,
) -> Option<route::Streams> {
    let log = log::StoreLog::new(
        store.clone(),
        Arc::clone(shells),
        tracker.clone(),
        stop.clone(),
    );
    let streams = holder::HolderStreams::new(store.clone(), runtime?);
    // The hub's own work, which outlasts the sockets it serves until it is closed.
    let hub = TaskTracker::new();
    let views = hub::Hub::new(streams, log, hub::HubOptions::default(), hub.clone());
    let reads = store.clone();
    Some(route::Streams {
        views: Arc::new(views),
        running: Arc::new(move |terminal| {
            let store = reads.clone();
            Box::pin(async move {
                holder::recorded(&store, &terminal)
                    .await
                    .map(|found| found.is_some())
            })
        }),
        protocol_id: Arc::from(bazhen_protocol::id::PROTOCOL_ID),
        closing: closing::ClosingBudget::new(closing::MAX_CLOSING_BYTES),
        tasks: tracker.clone(),
        hub,
    })
}
