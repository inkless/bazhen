//! What the state's agents are described with that the store doesn't hold (`snapshotView` in
//! `main.ts`): each harness's answer, asked of the harness served under the agent's id, so
//! nothing here names one.

use std::sync::Arc;

use bazhen_harness::Harness;
use bazhen_protocol::agents::HarnessId;
use bazhen_protocol::names::Role;
use bazhen_protocol::shells::TuiTheme;
use bazhen_store::{AgentView, Evidence, Listener};

use super::Agents;
use super::prompts::{FLEET, compose};
use crate::roles::RolesNow;

/// The agents' harnesses, and the roles as they read when the state was asked for.
#[derive(Debug)]
pub(crate) struct AgentsView {
    agents: Arc<Agents>,
    roles: Arc<RolesNow>,
}

impl AgentsView {
    pub(super) fn new(agents: Arc<Agents>, roles: Arc<RolesNow>) -> Self {
        Self { agents, roles }
    }

    fn harness(&self, id: HarnessId) -> Option<&dyn Harness> {
        self.agents.harnesses().get(id)
    }
}

impl AgentView for AgentsView {
    /// A session resumes only once its harness has named it, and as the harness judges what it
    /// reported of the session; a harness this daemon doesn't serve resumes nothing.
    fn resumes(&self, evidence: &Evidence<'_>) -> bool {
        evidence.external_ref.is_some()
            && self.harness(evidence.harness).is_some_and(|harness| {
                harness.can_resume(&bazhen_harness::Evidence {
                    transcript: evidence.transcript,
                })
            })
    }

    fn themes(&self, harness: HarnessId) -> Vec<TuiTheme> {
        self.harness(harness)
            .map_or_else(Vec::new, |harness| harness.themes().to_vec())
    }

    /// Nothing in this daemon holds a hook's wait, so no mail reaches an agent unprompted.
    fn listening(&self, _agent: &Listener<'_>) -> bool {
        false
    }

    fn prompt_hash(&self, role: Option<&Role>) -> String {
        compose(FLEET, &self.roles.book, role).hash
    }
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
    use bazhen_protocol::ids::{AgentId, EnvironmentId};
    use bazhen_store::SnapshotView;

    use super::*;
    use crate::agents::tests::{Fixture, Setup, request, setup_with, stubbed};
    use crate::testing::runtime;
    use crate::testing::stub_harness::{StubHarness, pull};

    fn session() -> ExternalRef {
        ExternalRef {
            environment_id: EnvironmentId::parse("env_0190a1b2c3d47abc8def0123456789a1").unwrap(),
            kind: ExternalRefKind::ClaudeSession,
            id: "s-1".to_owned(),
        }
    }

    fn evidence(harness: HarnessId, session: Option<&ExternalRef>) -> Evidence<'_> {
        Evidence {
            harness,
            external_ref: session,
            transcript: None,
        }
    }

    #[test]
    fn resumes_a_named_session_as_its_harness_says_and_nothing_on_a_harness_not_served() {
        let session = session();
        let resuming = stubbed(&StubHarness::new(pull()).resuming());
        let not = stubbed(&StubHarness::new(pull()));
        let [resuming, not] = [&resuming, &not].map(|f: &Fixture| f.agents.view());
        assert_eq!(
            [
                resuming.resumes(&evidence(HarnessId::ClaudeCode, Some(&session))),
                resuming.resumes(&evidence(HarnessId::ClaudeCode, None)),
                resuming.resumes(&evidence(HarnessId::Codex, Some(&session))),
                not.resumes(&evidence(HarnessId::ClaudeCode, Some(&session))),
            ],
            [true, false, false, false]
        );
    }

    #[test]
    fn gives_the_themes_of_the_harness_served_and_none_for_one_not_served() {
        let f = stubbed(&StubHarness::new(pull()));
        let view = f.agents.view();
        assert_eq!(
            [
                view.themes(HarnessId::ClaudeCode),
                view.themes(HarnessId::Codex)
            ],
            [vec![TuiTheme::Dark], vec![]]
        );
    }

    #[test]
    fn says_no_agent_is_listening() {
        let f = stubbed(&StubHarness::new(pull()));
        let id = AgentId::parse("agent_0190a1b2c3d47abc8def0123456789a1").unwrap();
        assert!(!f.agents.view().listening(&Listener {
            id: &id,
            harness: HarnessId::ClaudeCode,
            activity: None,
        }));
    }

    #[test]
    fn hashes_the_prompt_a_launch_in_the_role_would_start_with_now() {
        let f = stubbed(&StubHarness::new(pull()));
        let view = f.agents.view();
        let book = crate::roles::Roles::new(None).current().book.clone();
        let role = book.roles().first().map(|r| r.key.clone()).unwrap();
        assert_eq!(
            [view.prompt_hash(None), view.prompt_hash(Some(&role))],
            [
                compose(FLEET, &book, None).hash,
                compose(FLEET, &book, Some(&role)).hash
            ]
        );
        assert_ne!(view.prompt_hash(None), view.prompt_hash(Some(&role)));
    }

    /// The stub, served as each harness in turn, is described in the state as it says, whichever
    /// harness it is served as.
    #[test]
    fn describes_a_launched_agent_as_its_harness_says_whichever_harness_it_is_served_as() {
        let runs: Vec<_> = HarnessId::ALL
            .into_iter()
            .flat_map(|id| [false, true].map(move |resumes| (id, resumes)))
            .map(|(id, resumes)| {
                let stub = StubHarness::new(pull());
                let stub = if resumes { stub.resuming() } else { stub };
                let f = setup_with(Setup {
                    harnesses: stub.served_as(id),
                    ..Setup::default()
                });
                runtime()
                    .block_on(f.launch(bazhen_protocol::agents::LaunchAgentRequest {
                        harness: id,
                        ..request("k-1")
                    }))
                    .unwrap();
                let view = SnapshotView {
                    host: "host".to_owned(),
                    restart_holders: std::collections::HashMap::new(),
                    shells_report: false,
                };
                let snapshot = f
                    .store
                    .reader()
                    .unwrap()
                    .reads()
                    .snapshot_with_agents(&view, &f.agents.view(), None)
                    .unwrap();
                let [agent] = snapshot.agents.as_slice() else {
                    panic!("{:?}", snapshot.agents);
                };
                (resumes, agent.themes.clone(), agent.resumable)
            })
            .collect();
        for run in &runs {
            assert_eq!(*run, (run.0, vec![TuiTheme::Dark], run.0), "{runs:?}");
        }
    }
}
