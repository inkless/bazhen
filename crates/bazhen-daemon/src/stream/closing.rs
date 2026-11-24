//! The output closing streams may still hold, all of them together, as `ClosingBudget` in
//! `apps/daemon/src/http/closing.ts` bounds it: past the budget, the oldest are ended without
//! waiting for what they hold to be sent.

use std::sync::{Arc, Mutex, PoisonError};

use tokio_util::sync::CancellationToken;

use super::view::Unsent;

/// 128 MiB across every closing stream.
pub(crate) const MAX_CLOSING_BYTES: usize = 128 << 20;

/// Every closing stream, oldest first.
#[derive(Debug)]
pub(crate) struct ClosingBudget {
    most: usize,
    held: Mutex<Held>,
}

#[derive(Debug, Default)]
struct Held {
    next: u64,
    closing: Vec<Closing>,
}

#[derive(Debug)]
struct Closing {
    id: u64,
    unsent: Unsent,
    /// What it held as it closed: what it holds counts for no more, since a stream closing
    /// queues nothing new.
    at_close: usize,
    ended: CancellationToken,
}

impl Closing {
    fn held(&self) -> usize {
        self.unsent.get().min(self.at_close)
    }
}

/// A stream's place in the budget while it closes, which it gives up when dropped.
#[derive(Debug)]
pub(crate) struct Place {
    budget: Arc<ClosingBudget>,
    id: u64,
    ended: CancellationToken,
}

impl Place {
    /// Cancelled once the budget has ended the stream, which is to stop sending at once.
    pub(crate) fn ended(&self) -> &CancellationToken {
        &self.ended
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        self.budget
            .lock()
            .closing
            .retain(|closing| closing.id != self.id);
    }
}

impl ClosingBudget {
    pub(crate) fn new(most: usize) -> Arc<Self> {
        Arc::new(Self {
            most,
            held: Mutex::new(Held::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A stream begins to close holding `unsent`. Past the budget, the oldest others are ended,
    /// but never the one closing now.
    pub(crate) fn close(self: &Arc<Self>, unsent: Unsent) -> Place {
        let ended = CancellationToken::new();
        let mut held = self.lock();
        let id = held.next;
        held.next = held.next.wrapping_add(1);
        held.closing.push(Closing {
            id,
            at_close: unsent.get(),
            unsent,
            ended: ended.clone(),
        });
        let mut bytes: usize = held.closing.iter().map(Closing::held).sum();
        while bytes > self.most
            && let Some(oldest) = held.closing.first()
            && oldest.id != id
        {
            bytes = bytes.saturating_sub(oldest.held());
            oldest.ended.cancel();
            held.closing.remove(0);
        }
        Place {
            budget: Arc::clone(self),
            id,
            ended,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::view::{Inbox, Outbox, queue};

    /// A view's queue, holding `bytes` unsent.
    fn holding(bytes: usize) -> (Outbox, Inbox) {
        let (outbox, inbox) = queue(usize::MAX);
        outbox.send(vec![b'x'; bytes]).unwrap();
        (outbox, inbox)
    }

    // Sandbox-only by name alone: it calls ClosingBudget::close, which the signal scan can't tell
    // from a holder stream's close; it only counts bytes, and signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn ends_the_oldest_closing_streams_past_the_budget_but_never_the_one_closing_now() {
        bazhen_test_signal::require_sandbox().unwrap();
        let budget = ClosingBudget::new(10);
        let views = [holding(6), holding(4), holding(3), holding(50)];
        let [first, second] = [0, 1].map(|n| budget.close(views[n].1.unsent()));
        let within = (first.ended().is_cancelled(), second.ended().is_cancelled());
        let [third, fourth] = [2, 3].map(|n| budget.close(views[n].1.unsent()));
        assert_eq!(
            (
                within,
                [&first, &second, &third, &fourth].map(|place| place.ended().is_cancelled())
            ),
            ((false, false), [true, true, true, false])
        );
    }

    // Sandbox-only by name alone: it calls ClosingBudget::close, which the signal scan can't tell
    // from a holder stream's close; it only counts bytes, and signals nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn counts_a_closing_stream_only_for_what_it_still_holds_and_forgets_one_once_it_has_closed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let budget = ClosingBudget::new(10);
        let (outbox, inbox) = queue(usize::MAX);
        outbox.send(vec![b'x'; 8]).unwrap();
        let first = budget.close(inbox.unsent());
        // Sent: what the writer took and finished sending is no longer held.
        drop(inbox);
        let (_b, b) = holding(9);
        drop(budget.close(b.unsent()));
        let (_c, c) = holding(9);
        let third = budget.close(c.unsent());
        assert_eq!(
            (first.ended().is_cancelled(), third.ended().is_cancelled()),
            (false, false)
        );
    }
}
