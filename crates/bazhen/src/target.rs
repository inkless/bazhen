//! The terminal a command line names: an agent's or a shell's, by its name or id, or a terminal
//! by its own id.

use bazhen_protocol::agents::StateSnapshot;

/// What a target names, as the daemon's state shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Named {
    /// Its terminal's id; none while the runtime holds no terminal for it.
    pub(crate) terminal: Option<String>,
    /// Whether a client can attach to that terminal now.
    pub(crate) attachable: bool,
    /// It runs on a holder this build can't speak to.
    pub(crate) unserved: bool,
}

/// What `target` names in `state`; none when no agent, shell or terminal has that name or id.
pub(crate) fn named(state: &StateSnapshot, target: &str) -> Option<Named> {
    let agent = state.agents.iter().find(|a| {
        a.id.as_str() == target
            || a.name.eq_ignore_ascii_case(target)
            || a.terminal_id.as_ref().is_some_and(|t| t.as_str() == target)
    });
    agent
        .map(|a| Named {
            terminal: a.terminal_id.as_ref().map(|t| t.as_str().to_owned()),
            attachable: a.attach_command.is_some(),
            unserved: a.needs_restart.as_ref().is_some_and(|r| !r.served),
        })
        .or_else(|| {
            state
                .shells
                .iter()
                .find(|s| s.id.as_str() == target || s.name.as_deref() == Some(target))
                .map(|s| Named {
                    terminal: Some(s.id.as_str().to_owned()),
                    attachable: s.attach_command.is_some(),
                    unserved: s.needs_restart.as_ref().is_some_and(|r| !r.served),
                })
        })
}

/// Said of a target that names nothing.
pub(crate) fn unknown(target: &str) -> String {
    format!("no agent, shell or terminal is named {target}")
}
