//! Whether a hook came from the agent's session, and from the TUI its terminal runs
//! (`binding.ts`).

use bazhen_harness::{Origin, SessionRef};
use bazhen_peer::Peer;
use bazhen_store::AgentBinding;

/// The processes a shell is, by the name its process gives, past any path and a login shell's
/// leading `-`.
const SHELLS: [&str; 7] = ["sh", "bash", "dash", "zsh", "fish", "ksh", "ash"];

/// How many processes the climb from the hook's parent to the terminal's root may take.
const MAX_HOPS: usize = 4;

fn is_shell(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    SHELLS.contains(&base.strip_prefix('-').unwrap_or(base))
}

/// Whether the hook's caller ran from the terminal's root process `root`, through shells alone:
/// the TUI the terminal started, not one a nested session started under it. The climb starts at
/// the hook client's parent, which runs the hook, and takes the kernel's word for each process.
pub(crate) fn ran_by_pane(peer: &Peer, root: i32) -> bool {
    peer.ancestors
        .iter()
        .zip(&peer.names)
        .take(MAX_HOPS)
        .find_map(|(pid, name)| {
            if pid.as_raw_pid() == root {
                Some(true)
            } else {
                (!is_shell(name)).then_some(false)
            }
        })
        .unwrap_or(false)
}

/// Whether `origin` is the session the agent is bound to.
pub(crate) fn in_session(binding: &AgentBinding, origin: &Origin) -> bool {
    let bound = binding.session.as_ref().map(|session| SessionRef {
        kind: session.kind,
        id: session.id.clone(),
    });
    origin.session.is_some() && origin.session == bound
}

/// Whether the agent's start is still being recorded: a hook from it may come before its
/// terminal says it runs.
pub(crate) fn starting(binding: &AgentBinding) -> bool {
    binding.state == "starting" && binding.terminal_state.as_deref() != Some("running")
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::agents::{ExternalRef, ExternalRefKind};
    use bazhen_protocol::ids::EnvironmentId;
    use rustix::process::Pid;

    use super::*;

    fn peer(line: &[(i32, &str)]) -> Peer {
        Peer {
            pid: Pid::from_raw(2).unwrap(),
            session: None,
            codex_server: None,
            environment_withheld: false,
            ancestors: line
                .iter()
                .filter_map(|(pid, _)| Pid::from_raw(*pid))
                .collect(),
            names: line.iter().map(|(_, name)| (*name).to_owned()).collect(),
        }
    }

    #[test]
    fn takes_a_hook_whose_parent_is_the_root_or_under_it_through_shells_alone() {
        assert_eq!(
            [
                ran_by_pane(&peer(&[(50, "claude")]), 50),
                ran_by_pane(&peer(&[(51, "sh"), (52, "-zsh"), (50, "claude")]), 50),
                ran_by_pane(&peer(&[(51, "/bin/bash"), (50, "x")]), 50),
                ran_by_pane(&peer(&[(60, "claude"), (61, "zsh"), (50, "claude")]), 50),
                ran_by_pane(
                    &peer(&[(51, "sh"), (52, "sh"), (53, "sh"), (54, "sh"), (50, "c")]),
                    50
                ),
                ran_by_pane(&peer(&[(51, "sh"), (52, "sh")]), 50),
                ran_by_pane(&peer(&[(51, "shell"), (50, "claude")]), 50),
            ],
            [true, true, true, false, false, false, false]
        );
    }

    fn binding(state: &str, terminal: Option<&str>, session: Option<&str>) -> AgentBinding {
        AgentBinding {
            state: state.to_owned(),
            harness: "claude-code".to_owned(),
            environment: None,
            session: session.map(|id| ExternalRef {
                environment_id: EnvironmentId::parse("env_01900000000070008000000000000009")
                    .unwrap(),
                kind: ExternalRefKind::ClaudeSession,
                id: id.to_owned(),
            }),
            transcript: None,
            terminal_state: terminal.map(str::to_owned),
            locator: None,
        }
    }

    fn origin(session: Option<&str>) -> Origin {
        Origin {
            session: session.map(|id| SessionRef {
                kind: ExternalRefKind::ClaudeSession,
                id: id.to_owned(),
            }),
            transcript: None,
            subagent: None,
        }
    }

    #[test]
    fn counts_a_hook_in_the_session_only_when_both_name_the_same_one() {
        let bound = binding("running", Some("running"), Some("s-1"));
        let unbound = binding("running", Some("running"), None);
        assert_eq!(
            [
                in_session(&bound, &origin(Some("s-1"))),
                in_session(&bound, &origin(Some("s-2"))),
                in_session(&bound, &origin(None)),
                in_session(&unbound, &origin(None)),
            ],
            [true, false, false, false]
        );
    }

    #[test]
    fn waits_on_a_start_only_while_its_agent_starts_and_its_terminal_doesnt_run() {
        assert_eq!(
            [
                starting(&binding("starting", Some("starting"), None)),
                starting(&binding("starting", None, None)),
                starting(&binding("starting", Some("running"), None)),
                starting(&binding("running", Some("starting"), None)),
            ],
            [true, true, false, false]
        );
    }
}
