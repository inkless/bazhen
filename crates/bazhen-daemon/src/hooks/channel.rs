//! What a harness's own server tells of the agents it serves, applied as their hooks' facts are:
//! each in its agent's turn, through the same appliers.

use bazhen_harness::{HarnessId, Key, Keyed, Origin, SessionKey};
use bazhen_protocol::ids::AgentId;

use super::{Hooks, Passes};
use crate::routes::Shared;

/// What a server's report passes: none of a hook's gates, which tell an agent's own session from
/// another that ran its hook. A server names the session it speaks of.
const SERVED: Passes = Passes {
    in_session: false,
    owner: false,
    started_here: false,
};

/// The one agent `harness`'s server serves on `session`, none where there is none or two.
///
/// # Errors
///
/// The store's.
pub(crate) async fn served_on(
    shared: &Shared,
    harness: HarnessId,
    session: &SessionKey,
) -> Result<Option<AgentId>, String> {
    let session = session.0.clone();
    let id = shared
        .store
        .run(move |store| store.reads().served_on(harness, &session))
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())?;
    Ok(id.as_deref().and_then(AgentId::parse))
}

impl Hooks {
    /// Applies what one report from `harness`'s server says, in order: each fact of a session to
    /// the agent served on it, and none to no agent's, nor the account's. An approval a fact asks
    /// opens an item that holds nothing, as the harness's own TUI answers it.
    ///
    /// # Errors
    ///
    /// The store's, or an applier's; the facts before it are applied.
    pub(crate) async fn channel(
        &self,
        shared: &Shared,
        harness: HarnessId,
        observed: Vec<Keyed>,
    ) -> Result<(), String> {
        let origin = Origin {
            session: None,
            transcript: None,
            subagent: None,
        };
        for keyed in observed {
            let agent = match &keyed.key {
                Key::Account => continue,
                Key::Session(session) => served_on(shared, harness, session).await?,
                Key::Agent(agent) => Some(agent.clone()),
            };
            let Some(agent) = agent else {
                continue;
            };
            let one = Keyed {
                key: Key::Agent(agent.clone()),
                ..keyed
            };
            let turn = self.turn_of(&agent);
            let applied = {
                let _held = turn.lock().await;
                self.apply(shared, &agent, None, &origin, (SERVED, None), &[one])
                    .await
            };
            self.release(&agent, turn);
            applied?;
        }
        Ok(())
    }
}
