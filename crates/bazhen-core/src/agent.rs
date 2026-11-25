//! An agent session's lifecycle, and the commands it takes in each state, as packages/core's
//! agent.ts has them.

use bazhen_protocol::agents::{AgentCommand, AgentState};
use bazhen_protocol::shells::TerminalState;

use crate::machine::InvalidTransition;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentEvent {
    LaunchConfirmed,
    HarnessReady,
    LaunchRejected,
    ProcessExited,
    EnvironmentUnreachable,
    EnvironmentReconfirmed,
    TargetAbsent,
    ProcessAdopted,
    RespawnRequested,
    RespawnRejected,
    RelaunchRequested,
    RelaunchRejected,
    CloseRequested,
    CloseCompleted,
}

impl AgentEvent {
    pub const ALL: [Self; 14] = [
        Self::LaunchConfirmed,
        Self::HarnessReady,
        Self::LaunchRejected,
        Self::ProcessExited,
        Self::EnvironmentUnreachable,
        Self::EnvironmentReconfirmed,
        Self::TargetAbsent,
        Self::ProcessAdopted,
        Self::RespawnRequested,
        Self::RespawnRejected,
        Self::RelaunchRequested,
        Self::RelaunchRejected,
        Self::CloseRequested,
        Self::CloseCompleted,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::LaunchConfirmed => "launch.confirmed",
            Self::HarnessReady => "harness.ready",
            Self::LaunchRejected => "launch.rejected",
            Self::ProcessExited => "process.exited",
            Self::EnvironmentUnreachable => "environment.unreachable",
            Self::EnvironmentReconfirmed => "environment.reconfirmed",
            Self::TargetAbsent => "target.absent",
            Self::ProcessAdopted => "process.adopted",
            Self::RespawnRequested => "respawn.requested",
            Self::RespawnRejected => "respawn.rejected",
            Self::RelaunchRequested => "relaunch.requested",
            Self::RelaunchRejected => "relaunch.rejected",
            Self::CloseRequested => "close.requested",
            Self::CloseCompleted => "close.completed",
        }
    }
}

/// Where `event` takes an agent in `from`, or nothing when `from` doesn't take it.
///
/// While its environment is unreachable an agent is unknown, never lost: only a reachable
/// environment that positively lacks the target makes it lost. An agent is starting until its
/// harness shows a sign of life, not merely until its terminal runs, and unreachable is left out
/// of starting, since unknown returns to running on reconfirm, which would skip that sign. A
/// rejected respawn returns to exited and a rejected relaunch to lost, where the terminal still
/// is, so each stays closable. A process started in its terminal from outside the daemon is
/// adopted, and then waits on its harness's sign as after any start.
fn to(from: AgentState, event: AgentEvent) -> Option<AgentState> {
    use AgentEvent as E;
    use AgentState as S;
    Some(match (from, event) {
        (S::Starting, E::LaunchConfirmed | E::ProcessAdopted)
        | (S::Running | S::Exited, E::ProcessAdopted)
        | (S::Exited, E::RespawnRequested)
        | (S::Lost, E::RelaunchRequested) => S::Starting,
        (S::Starting, E::HarnessReady) | (S::Unknown, E::EnvironmentReconfirmed) => S::Running,
        (S::Starting, E::LaunchRejected) => S::Failed,
        (S::Starting, E::RespawnRejected)
        | (S::Starting | S::Running | S::Unknown, E::ProcessExited) => S::Exited,
        (S::Starting, E::RelaunchRejected)
        | (S::Starting | S::Running | S::Unknown | S::Exited, E::TargetAbsent) => S::Lost,
        (S::Running, E::EnvironmentUnreachable) => S::Unknown,
        (S::Starting | S::Running | S::Unknown | S::Exited | S::Lost, E::CloseRequested) => {
            S::Closing
        }
        (S::Closing, E::CloseCompleted) => S::Closed,
        _ => return None,
    })
}

/// The state `event` leads to.
///
/// # Errors
///
/// [`InvalidTransition`] when `from` doesn't take `event`.
pub fn next(from: AgentState, event: AgentEvent) -> Result<AgentState, InvalidTransition> {
    to(from, event).ok_or(InvalidTransition {
        machine: "agent session",
        from: from.as_str(),
        event: event.as_str(),
    })
}

/// Whether `from` takes `event`, for a caller deciding before it records anything.
pub fn accepts(from: AgentState, event: AgentEvent) -> bool {
    to(from, event).is_some()
}

/// A state that takes no event is final.
pub fn is_final(state: AgentState) -> bool {
    AgentEvent::ALL.iter().all(|&e| to(state, e).is_none())
}

/// The commands an agent takes, by its lifecycle and its terminal's. A closing agent takes close
/// again, which finishes what an unreachable environment stopped; a closed one answers it with
/// nothing to do, so it isn't offered. A starting agent takes close and signal only once its
/// terminal runs: before then its start holds it, and there is no process to end.
pub fn agent_commands(state: AgentState, terminal: Option<TerminalState>) -> Vec<AgentCommand> {
    if state == AgentState::Starting {
        return match terminal {
            Some(TerminalState::Running) => vec![AgentCommand::Close, AgentCommand::Signal],
            // A start that waits on its answer, which close ends through its holder, or once
            // none is proved to have started it.
            Some(TerminalState::Creating | TerminalState::Exited) => vec![AgentCommand::Close],
            _ => Vec::new(),
        };
    }
    let closes = accepts(state, AgentEvent::CloseRequested) || state == AgentState::Closing;
    [
        (closes, AgentCommand::Close),
        (
            accepts(state, AgentEvent::RespawnRequested),
            AgentCommand::Respawn,
        ),
        (state == AgentState::Running, AgentCommand::Signal),
        (
            accepts(state, AgentEvent::RelaunchRequested),
            AgentCommand::Relaunch,
        ),
    ]
    .into_iter()
    .filter_map(|(offered, command)| offered.then_some(command))
    .collect()
}

/// The commands the daemon would take on an agent now, as a client is offered them. Every
/// command names a generation, so an agent without one is offered none; respawn is offered only
/// when `resumes` says starting the agent again resumes its harness session, and `resumes` is
/// asked only then.
pub fn offered_commands(
    state: AgentState,
    terminal: Option<TerminalState>,
    generation: Option<u64>,
    resumes: impl FnOnce() -> bool,
) -> Vec<AgentCommand> {
    if generation.is_none() {
        return Vec::new();
    }
    let mut commands = agent_commands(state, terminal);
    if commands.contains(&AgentCommand::Respawn) && !resumes() {
        commands.retain(|&c| c != AgentCommand::Respawn);
    }
    commands
}
