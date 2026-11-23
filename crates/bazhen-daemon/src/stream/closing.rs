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
