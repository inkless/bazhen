//! Commands that must not overlap, each waiting its turn by what it acts on: a shell's by its
//! terminal, an agent's by the agent (`AgentQueue` in `agents/queue.ts`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

/// Commands on one terminal or agent, one at a time, each waiting its turn by its id.
#[derive(Debug, Default)]
pub(crate) struct Turns(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

/// One turn, given back as it drops.
#[derive(Debug)]
pub(crate) struct Turn<'a> {
    turns: &'a Turns,
    id: String,
    held: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Turns {
    pub(crate) async fn take(&self, id: &str) -> Turn<'_> {
        let lock = {
            let mut turns = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(turns.entry(id.to_owned()).or_default())
        };
        Turn {
            turns: self,
            id: id.to_owned(),
            held: Some(lock.lock_owned().await),
        }
    }

    /// `id`'s turn, if no command holds it now: for what would rather come back later than wait.
    pub(crate) fn try_take(&self, id: &str) -> Option<Turn<'_>> {
        let lock = {
            let mut turns = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(turns.entry(id.to_owned()).or_default())
        };
        let held = lock.try_lock_owned().ok();
        // Built even when refused, so its drop forgets an entry no one else holds or waits for.
        let turn = Turn {
            turns: self,
            id: id.to_owned(),
            held,
        };
        turn.held.is_some().then_some(turn)
    }
}

#[cfg(test)]
impl Turns {
    /// Whether a command waits for `id`'s turn behind the one holding it.
    pub(crate) fn waiting(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            // The map's, the holder's guard's, and the waiter's.
            .is_some_and(|lock| Arc::strong_count(lock) > 2)
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        drop(self.held.take());
        let mut turns = self.turns.0.lock().unwrap_or_else(PoisonError::into_inner);
        // Forgotten once no other command holds or waits for it.
        if turns
            .get(&self.id)
            .is_some_and(|lock| Arc::strong_count(lock) == 1)
        {
            turns.remove(&self.id);
        }
    }
}
