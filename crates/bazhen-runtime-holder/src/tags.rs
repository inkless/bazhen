//! A terminal's tags as a holder keeps them, as `tags.ts` writes and reads them: flat names, each
//! written only when it has a value.

use std::collections::BTreeMap;

use bazhen_holder_proto::body::{Invalid, TagName, TagValue, Tags};
use bazhen_protocol::ids::AgentId;

const KIND: &str = "kind";
const AGENT_ID: &str = "agentId";
const HARNESS_SESSION: &str = "harnessSession";
const LINKED_AGENT_ID: &str = "linkedAgentId";

/// What a terminal is to Bazhen: an agent's, or a shell, which may be linked to an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalTags {
    Agent {
        agent_id: AgentId,
        harness_session: Option<String>,
    },
    Shell {
        linked_agent_id: Option<AgentId>,
    },
}

/// `tags` as a holder keeps them. An empty harness session is left out, as none is.
///
/// # Errors
///
/// When the harness session is longer than a tag's value may be.
pub fn encode_tags(tags: &TerminalTags) -> Result<Tags, Invalid> {
    let mut out = BTreeMap::new();
    let mut put = |name: &str, value: &str| -> Result<(), Invalid> {
        out.insert(TagName::new(name)?, TagValue::new(value)?);
        Ok(())
    };
    match tags {
        TerminalTags::Agent {
            agent_id,
            harness_session,
        } => {
            put(KIND, "agent")?;
            put(AGENT_ID, agent_id.as_str())?;
            if let Some(session) = harness_session.as_deref().filter(|s| !s.is_empty()) {
                put(HARNESS_SESSION, session)?;
            }
        }
        TerminalTags::Shell { linked_agent_id } => {
            put(KIND, "shell")?;
            if let Some(agent) = linked_agent_id {
                put(LINKED_AGENT_ID, agent.as_str())?;
            }
        }
    }
    Tags::new(out)
}

/// The tags `encode_tags` wrote, or `None` for a holder whose tags Bazhen didn't write.
pub fn decode_tags(tags: &Tags) -> Option<TerminalTags> {
    let get = |name: &str| {
        tags.as_map()
            .iter()
            .find(|(n, _)| n.as_str() == name)
            .map(|(_, v)| v.as_str())
    };
    match get(KIND) {
        Some("agent") => Some(TerminalTags::Agent {
            agent_id: AgentId::parse(get(AGENT_ID)?)?,
            harness_session: get(HARNESS_SESSION)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        }),
        Some("shell") => Some(TerminalTags::Shell {
            linked_agent_id: get(LINKED_AGENT_ID).and_then(AgentId::parse),
        }),
        _ => None,
    }
}

/// The same tags without a shell's agent link, as `unlink` leaves them.
///
/// # Errors
///
/// None for tags a `Tags` holds: taking a name away leaves no reserved one.
pub fn unlinked(tags: &Tags) -> Result<Tags, Invalid> {
    let mut kept: BTreeMap<TagName, TagValue> = tags.clone().into();
    kept.retain(|name, _| name.as_str() != LINKED_AGENT_ID);
    Tags::new(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentId {
        AgentId::mint(1_700_000_000_000, [7; 16])
    }

    fn tags(pairs: &[(&str, &str)]) -> Tags {
        Tags::new(
            pairs
                .iter()
                .map(|(n, v)| (TagName::new(*n).unwrap(), TagValue::new(*v).unwrap()))
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn round_trips_every_kind_of_terminal_s_tags() {
        let all = [
            TerminalTags::Agent {
                agent_id: agent(),
                harness_session: None,
            },
            TerminalTags::Agent {
                agent_id: agent(),
                harness_session: Some("sess-1".to_owned()),
            },
            TerminalTags::Shell {
                linked_agent_id: None,
            },
            TerminalTags::Shell {
                linked_agent_id: Some(agent()),
            },
        ];
        let back: Vec<_> = all
            .iter()
            .map(|t| decode_tags(&encode_tags(t).unwrap()))
            .collect();
        assert_eq!(back, all.map(Some));
    }

    #[test]
    fn writes_a_tag_only_when_it_has_a_value() {
        let id = agent();
        let encoded = encode_tags(&TerminalTags::Agent {
            agent_id: id.clone(),
            harness_session: Some(String::new()),
        })
        .unwrap();
        assert_eq!(
            encoded,
            tags(&[("kind", "agent"), ("agentId", id.as_str())])
        );
    }

    #[test]
    fn reads_tags_bazhen_didn_t_write_as_none_of_its_terminals() {
        let foreign = [
            tags(&[]),
            tags(&[("kind", "agent")]),
            tags(&[("kind", "agent"), ("agentId", "a1")]),
            tags(&[("kind", "pane")]),
        ];
        assert_eq!(foreign.map(|t| decode_tags(&t)), [None, None, None, None]);
    }

    #[test]
    fn drops_only_a_shell_s_agent_link_when_unlinked() {
        let id = agent();
        let linked = tags(&[
            ("kind", "shell"),
            ("linkedAgentId", id.as_str()),
            ("other", "kept"),
        ]);
        let left = unlinked(&linked).unwrap();
        assert_eq!(
            decode_tags(&left),
            Some(TerminalTags::Shell {
                linked_agent_id: None
            })
        );
        assert_eq!(left, tags(&[("kind", "shell"), ("other", "kept")]));
    }
}
