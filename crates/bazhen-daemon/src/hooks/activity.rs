//! What an agent is doing, from its own session and its subagents together (`activity.ts`).

use std::collections::{BTreeMap, HashMap};

use bazhen_harness::HarnessActivity;
use bazhen_protocol::agents::ActivityValue;
use bazhen_protocol::ids::AgentId;

/// What an agent is doing while one of its subagents works and its own session doesn't.
const SUBAGENT_RUNNING: &str = "subagent running";

/// One thing a hook from the agent's session says of what it is doing.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Change {
    Doing(HarnessActivity),
    SubagentStarted(String),
    SubagentStopped(String),
}

/// What each agent's own session last said it was doing, and each of its open subagents.
#[derive(Debug, Default)]
pub(crate) struct Tracker {
    main: HashMap<AgentId, HarnessActivity>,
    subagents: HashMap<AgentId, BTreeMap<String, HarnessActivity>>,
}

impl Tracker {
    /// Takes `change`, from the subagent `subagent` or, with none, the agent's own session, and
    /// answers what the agent is now doing, or none while nothing has said.
    pub(crate) fn observe(
        &mut self,
        agent: &AgentId,
        subagent: Option<&str>,
        change: Change,
    ) -> Option<HarnessActivity> {
        let open = self.subagents.entry(agent.clone()).or_default();
        match (change, subagent) {
            (Change::SubagentStarted(id), _) => {
                open.insert(id, doing(ActivityValue::Working, None));
            }
            (Change::SubagentStopped(id), _) => {
                open.remove(&id);
            }
            (Change::Doing(doing), Some(subagent)) => {
                open.insert(subagent.to_owned(), doing);
            }
            (Change::Doing(doing), None) => {
                self.main.insert(agent.clone(), doing);
            }
        }
        self.effective(agent)
    }

    /// The agent's session started over: the subagents of the one before are gone with it.
    pub(crate) fn session_started(&mut self, agent: &AgentId) {
        self.subagents.remove(agent);
    }

    /// A request for approval anywhere holds the agent; else its own session working, else any
    /// subagent working, else what its own session last said.
    fn effective(&self, agent: &AgentId) -> Option<HarnessActivity> {
        let main = self.main.get(agent);
        let open = self.subagents.get(agent);
        let asks = |d: &HarnessActivity| d.value == ActivityValue::NeedsApproval;
        if main.is_some_and(asks) || open.is_some_and(|open| open.values().any(asks)) {
            return Some(doing(ActivityValue::NeedsApproval, None));
        }
        if let Some(main) = main.filter(|d| d.value == ActivityValue::Working) {
            return Some(main.clone());
        }
        if open.is_some_and(|open| !open.is_empty()) {
            return Some(doing(ActivityValue::Working, Some(SUBAGENT_RUNNING)));
        }
        main.cloned()
    }
}

fn doing(value: ActivityValue, detail: Option<&str>) -> HarnessActivity {
    HarnessActivity {
        value,
        detail: detail.map(str::to_owned),
        limit: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "agent_01900000000070008000000000000001";

    fn agent() -> AgentId {
        AgentId::parse(AGENT).unwrap()
    }

    fn value_of(doing: Option<HarnessActivity>) -> Option<(ActivityValue, Option<String>)> {
        doing.map(|d| (d.value, d.detail))
    }

    #[test]
    fn reports_the_agent_working_while_a_subagent_works_and_its_own_session_idles() {
        let mut tracker = Tracker::default();
        let mut observe =
            |subagent: Option<&str>, change| value_of(tracker.observe(&agent(), subagent, change));
        let idle = Change::Doing(doing(ActivityValue::Idle, None));
        let running = Some((ActivityValue::Working, Some(SUBAGENT_RUNNING.to_owned())));
        assert_eq!(
            [
                observe(None, idle.clone()),
                observe(None, Change::SubagentStarted("s1".to_owned())),
                observe(Some("s1"), idle.clone()),
                observe(
                    None,
                    Change::Doing(doing(ActivityValue::Working, Some("own")))
                ),
                observe(None, idle),
                observe(None, Change::SubagentStopped("s1".to_owned())),
            ],
            [
                Some((ActivityValue::Idle, None)),
                running.clone(),
                running,
                Some((ActivityValue::Working, Some("own".to_owned()))),
                Some((ActivityValue::Working, Some(SUBAGENT_RUNNING.to_owned()))),
                Some((ActivityValue::Idle, None)),
            ]
        );
    }

    #[test]
    fn holds_the_agent_on_an_approval_any_subagent_asks_until_it_stops() {
        let mut tracker = Tracker::default();
        let asks = Change::Doing(doing(ActivityValue::NeedsApproval, None));
        let working = Change::Doing(doing(ActivityValue::Working, None));
        let mut observe =
            |subagent: Option<&str>, change| value_of(tracker.observe(&agent(), subagent, change));
        assert_eq!(
            [
                observe(Some("s1"), asks),
                observe(None, working),
                observe(None, Change::SubagentStopped("s1".to_owned())),
            ],
            [
                Some((ActivityValue::NeedsApproval, None)),
                Some((ActivityValue::NeedsApproval, None)),
                Some((ActivityValue::Working, None)),
            ]
        );
    }

    #[test]
    fn forgets_the_subagents_of_a_session_that_started_over() {
        let mut tracker = Tracker::default();
        tracker.observe(&agent(), None, Change::SubagentStarted("s1".to_owned()));
        tracker.session_started(&agent());
        let idle = Change::Doing(doing(ActivityValue::Idle, None));
        assert_eq!(
            value_of(tracker.observe(&agent(), None, idle)),
            Some((ActivityValue::Idle, None))
        );
    }

    #[test]
    fn says_nothing_of_an_agent_only_a_stopped_subagent_spoke_for() {
        let mut tracker = Tracker::default();
        let stopped = Change::SubagentStopped("s1".to_owned());
        assert_eq!(tracker.observe(&agent(), Some("s1"), stopped), None);
    }
}
