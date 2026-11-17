//! The verbs that run an agent's life: launch one, close it, start it again, and signal it. Each
//! is one call to the daemon, which decides whether the caller may make it and whether the agent
//! is in a state that takes it.

use bazhen_protocol::agents::{
    Agent, AgentCommandResponse, CloseAgentRequest, HarnessId, LaunchAgentRequest,
    LaunchAgentResponse, RelaunchAgentRequest, RespawnAgentRequest, Signal, SignalAgentRequest,
    StateSnapshot,
};
use bazhen_protocol::names::Role;
use serde::Serialize;

use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::{encode_uri_component, printable};
use crate::out::Out;
use crate::tasks::{Step, Stop, agent_ref, key, need, new_name, start_dir, usage};
use crate::{Exit, LIFECYCLE_USAGE};

/// The options each verb takes beside `--json`; `--home` and `--port` are every verb's.
fn options(verb: &str) -> &'static [&'static str] {
    match verb {
        "launch" => &["dir", "name", "role"],
        "close" => &["confirm-busy", "force"],
        "relaunch" => &["fresh"],
        _ => &[],
    }
}

/// Runs the lifecycle verb the command line names, and says how it went.
pub(crate) fn run(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    answer(verb(p, daemon), LIFECYCLE_USAGE, out)
}

/// Prints what a verb answered, or why it stopped, with `usage_text` under a usage mistake.
pub(crate) fn answer(
    step: Result<String, Stop>,
    usage_text: &str,
    out: &mut Out,
) -> Result<Exit, Failed> {
    match step {
        Ok(text) => {
            out.line(&text);
            Ok(Exit::Done)
        }
        Err(Stop::Usage(message)) => {
            out.err(&format!("{message}\n{usage_text}"));
            Ok(Exit::Usage)
        }
        Err(Stop::NotHere(message)) => {
            out.err(&message);
            Ok(Exit::Usage)
        }
        Err(Stop::Unreadable(message) | Stop::Refused(message)) => {
            out.err(&message);
            Ok(Exit::Failed)
        }
        Err(Stop::Call(failed)) => Err(failed),
    }
}

/// A command on an agent that runs, as the command line gives it.
#[derive(Debug, Clone, Copy)]
enum Command {
    Close { force: bool, confirm_busy: bool },
    Respawn,
    Relaunch { fresh: bool },
    Signal(Signal),
}

impl Command {
    fn parse(p: &Parsed, name: &str) -> Step<Self> {
        Ok(match name {
            "close" => Self::Close {
                force: p.has("force"),
                confirm_busy: p.has("confirm-busy"),
            },
            "respawn" => Self::Respawn,
            "relaunch" => Self::Relaunch {
                fresh: p.has("fresh"),
            },
            "signal" => Self::Signal(signal_named(need(p.word(2), "the signal")?)?),
            other => return usage(format!("unknown verb {other}")),
        })
    }

    /// Sends the command for the agent `id`, at `generation`.
    fn send(self, daemon: &Daemon, id: &str, generation: u64) -> Step<AgentCommandResponse> {
        let path = |action: &str| format!("/v1/agents/{}/{action}", encode_uri_component(id));
        let idempotency_key = key()?;
        let sent = match self {
            Self::Close {
                force,
                confirm_busy,
            } => daemon.post(
                &path("close"),
                &CloseAgentRequest {
                    idempotency_key,
                    generation,
                    force: force.then_some(true),
                    keep_shells: None,
                    confirm_busy: confirm_busy.then_some(true),
                    confirmed_busy: None,
                },
                CALL,
            ),
            Self::Respawn => daemon.post(
                &path("respawn"),
                &RespawnAgentRequest {
                    idempotency_key,
                    generation,
                    theme: None,
                },
                CALL,
            ),
            Self::Relaunch { fresh } => daemon.post(
                &path("relaunch"),
                &RelaunchAgentRequest {
                    idempotency_key,
                    generation,
                    theme: None,
                    fresh: fresh.then_some(true),
                },
                CALL,
            ),
            Self::Signal(signal) => daemon.post(
                &path("signal"),
                &SignalAgentRequest {
                    idempotency_key,
                    generation,
                    signal,
                },
                CALL,
            ),
        };
        Ok(sent?)
    }

    /// What the command did, said of the agent `label`.
    fn done(self, label: &str) -> String {
        match self {
            Self::Close { .. } => format!("closed {label}"),
            Self::Respawn => format!("respawned {label}"),
            Self::Relaunch { .. } => format!("relaunched {label}"),
            Self::Signal(signal) => format!("sent {} to {label}", signal.as_str()),
        }
    }
}

fn verb(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let name = p.word(0).unwrap_or_default();
    let own = options(name);
    if let Some(other) = p
        .given()
        .find(|o| !own.contains(o) && !["json", "home", "port"].contains(o))
    {
        return usage(format!("{name} takes no --{other}"));
    }
    let words = if name == "signal" { 3 } else { 2 };
    if let Some(extra) = p.word(words) {
        return usage(format!("{name} takes no {extra}"));
    }
    if name == "launch" {
        return launch(p, daemon);
    }
    let given = agent_ref(p.word(1), "the agent")?;
    let command = Command::parse(p, name)?;
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let agent = find(&state, given.as_str())?;
    let label = label(agent);
    let Some(generation) = agent.generation else {
        return Err(Stop::Refused(format!("{label} has no terminal yet")));
    };
    let r = command
        .send(daemon, agent.id.as_str(), generation)
        .map_err(|stop| match command {
            Command::Close { confirm_busy, .. } => how_to_close_busy(stop, confirm_busy),
            _ => stop,
        })?;
    if p.has("json") {
        return pretty(&r);
    }
    Ok(if r.event_ids.is_empty() {
        format!("{label}: nothing to do")
    } else {
        command.done(&label)
    })
}

fn launch(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let given = need(p.word(1), "the harness")?;
    let Some(harness) = HarnessId::parse(given) else {
        let all: Vec<&str> = HarnessId::ALL.iter().map(|h| h.as_str()).collect();
        return usage(format!("the harness is {}, not {given}", all.join(" or ")));
    };
    let name = p.value("name").map(new_name).transpose()?;
    let role = p
        .value("role")
        .map(|r| {
            Role::parse(r).map_or_else(
                || usage(format!("--role is a role bazhen roles lists, not {r}")),
                Ok,
            )
        })
        .transpose()?;
    let r: LaunchAgentResponse = daemon.post(
        "/v1/agents",
        &LaunchAgentRequest {
            idempotency_key: key()?,
            harness,
            cwd: start_dir(p.value("dir").unwrap_or(".")),
            project: None,
            theme: None,
            name: name.clone(),
            role,
        },
        CALL,
    )?;
    if p.has("json") {
        return pretty(&r);
    }
    Ok(match name {
        Some(name) => format!("launched {} ({})", printable(name.as_str()), r.agent_id),
        None => format!("launched {}", r.agent_id),
    })
}

/// A close refused as `busy` names what runs; unless it `confirmed` that, say how to end it.
pub(crate) fn how_to_close_busy(stop: Stop, confirmed: bool) -> Stop {
    match stop {
        Stop::Call(Failed::Rejected(rejection)) if !confirmed && rejection.busy() => Stop::Refused(
            format!("{rejection}\nclose again with --confirm-busy to end what runs"),
        ),
        other => other,
    }
}

/// The signal `given` names, as `kill` takes one: with or without `SIG`, in either case.
fn signal_named(given: &str) -> Step<Signal> {
    Signal::ALL
        .into_iter()
        .find(|s| {
            let full = s.as_str();
            given.eq_ignore_ascii_case(full)
                || full
                    .strip_prefix("SIG")
                    .is_some_and(|short| given.eq_ignore_ascii_case(short))
        })
        .map_or_else(
            || usage(format!("the signal is INT, TERM, HUP or KILL, not {given}")),
            Ok,
        )
}

/// The agent `given` names: by its id, else by the name of one not ended, as a name an ended
/// agent had may be another's now. A name is matched as the daemon matches one, ignoring ASCII
/// case.
pub(crate) fn find<'s>(state: &'s StateSnapshot, given: &str) -> Step<&'s Agent> {
    state
        .agents
        .iter()
        .find(|a| a.id.as_str() == given)
        .or_else(|| {
            state
                .agents
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(given) && !a.state.ended())
        })
        .ok_or_else(|| Stop::Refused(format!("the daemon has no agent {}", printable(given))))
}

/// An agent as the person knows it: its name and id, or its id alone when it has no name.
pub(crate) fn label(agent: &Agent) -> String {
    if agent.name.is_empty() {
        agent.id.to_string()
    } else {
        format!("{} ({})", printable(&agent.name), agent.id)
    }
}

pub(crate) fn pretty(value: &impl Serialize) -> Step<String> {
    serde_json::to_string_pretty(value).map_err(|e| Stop::Unreadable(e.to_string()))
}
