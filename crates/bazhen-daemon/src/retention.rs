//! Events are kept 30 days, projections for good: old events are retired when the daemon starts
//! and hourly after, a batch per writer job so writes aren't held behind a long first pass.

use std::future::Future;
use std::num::NonZeroU32;
use std::time::Duration;

use jiff::{SignedDuration, Timestamp};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use crate::writer::Writer;

const KEPT: SignedDuration = SignedDuration::from_hours(30 * 24);
const EVERY: Duration = Duration::from_hours(1);
const BATCH: NonZeroU32 = NonZeroU32::new(1000).unwrap();

/// Runs `prune` now and every hour after until `stop`.
pub(crate) async fn every_hour<F: Future<Output = ()>>(
    stop: CancellationToken,
    mut prune: impl FnMut() -> F,
) {
    let mut hourly = tokio::time::interval(EVERY);
    hourly.set_missed_tick_behavior(MissedTickBehavior::Delay);
    while stop.run_until_cancelled(hourly.tick()).await.is_some() {
        stop.run_until_cancelled(prune()).await;
    }
}

/// Retires every event older than 30 days at `now`, a batch at a time, stopping between batches
/// once `stop` is cancelled so the store can close under it.
pub(crate) async fn prune(writer: &Writer, now: Timestamp, stop: &CancellationToken) {
    let cutoff = now - KEPT;
    while !stop.is_cancelled() {
        match writer
            .run(move |store| store.prune_batch(cutoff, BATCH))
            .await
        {
            Ok(Ok(true)) => tokio::task::yield_now().await,
            Ok(Ok(false)) | Err(_) => return,
            Ok(Err(err)) => {
                tracing::error!("event retention failed: {err}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use bazhen_store::Store;

    use super::*;
    use crate::testing::{TempDir, paused, runtime};
    use crate::writer;

    #[test]
    fn retires_at_start_then_hourly_and_not_once_stopped() {
        let runs = Arc::new(AtomicU32::new(0));
        let stop = CancellationToken::new();
        let counted = Arc::clone(&runs);
        paused().block_on(async {
            let looping = every_hour(stop.clone(), move || {
                counted.fetch_add(1, Ordering::Relaxed);
                std::future::ready(())
            });
            let mut looping = std::pin::pin!(looping);
            let at = |after: Duration| tokio::time::sleep(after);
            tokio::select! { () = &mut looping => panic!("stopped unasked"), () = at(Duration::from_secs(1)) => {} }
            assert_eq!(runs.load(Ordering::Relaxed), 1);
            tokio::select! { () = &mut looping => panic!("stopped unasked"), () = at(EVERY.checked_sub(Duration::from_secs(2)).unwrap()) => {} }
            assert_eq!(runs.load(Ordering::Relaxed), 1);
            tokio::select! { () = &mut looping => panic!("stopped unasked"), () = at(Duration::from_secs(2)) => {} }
            assert_eq!(runs.load(Ordering::Relaxed), 2);
            stop.cancel();
            looping.await;
        });
        assert_eq!(runs.load(Ordering::Relaxed), 2);
    }

    /// A store with `old` events older than 30 days, then one young, each from a visit no
    /// projection points at.
    fn aged(dir: &TempDir, old: u32) -> (writer::Writer, writer::Thread) {
        let path = dir.path().join("bazhen.db");
        drop(Store::open(&path).unwrap());
        let db = rusqlite::Connection::open(&path).unwrap();
        let insert =
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
             VALUES ((SELECT id FROM host), ?, 'attachment.ended', 'attachment', 'att_1', 'system',
               '{\"reason\":\"client_closed\"}')";
        let long_ago = format!(
            "{:.3}",
            Timestamp::now() - KEPT - SignedDuration::from_secs(60)
        );
        for _ in 0..old {
            db.execute(insert, [&long_ago]).unwrap();
        }
        db.execute(insert, [format!("{:.3}", Timestamp::now())])
            .unwrap();
        drop(db);
        writer::start(Store::open(&path).unwrap(), &path).unwrap()
    }

    fn remaining(writer: &writer::Writer) -> usize {
        writer
            .reader()
            .unwrap()
            .reads()
            .events(0, 5000)
            .unwrap()
            .len()
    }

    #[test]
    fn retires_every_event_past_30_days_across_batches_and_none_younger() {
        let dir = TempDir::new("retire");
        let (writer, thread) = aged(&dir, 2 * BATCH.get() + 1);
        let runtime = runtime();
        runtime.block_on(prune(
            &writer,
            Timestamp::now() - SignedDuration::from_hours(1),
            &CancellationToken::new(),
        ));
        assert_eq!(
            remaining(&writer),
            usize::try_from(2 * BATCH.get() + 2).unwrap()
        );
        runtime.block_on(prune(&writer, Timestamp::now(), &CancellationToken::new()));
        assert_eq!(remaining(&writer), 1);
        thread.finish();
    }

    #[test]
    fn retires_nothing_once_stopped() {
        let dir = TempDir::new("retire-stopped");
        let (writer, thread) = aged(&dir, 3);
        let stop = CancellationToken::new();
        stop.cancel();
        runtime().block_on(prune(&writer, Timestamp::now(), &stop));
        assert_eq!(remaining(&writer), 4);
        thread.finish();
    }
}
