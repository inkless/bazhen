//! The shells: list them, open one beside an agent or in a directory, and close one. Each is one
//! call to the daemon, which decides whether the caller may make it.

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::shells::{CloseShellRequest, OpenShellRequest, Shell, ShellCommandResponse};

use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::{encode_uri_component, printable};
use crate::lifecycle::{answer, find, how_to_close_busy, label, pretty};
use crate::out::Out;
use crate::tasks::{Step, Stop, key, need, start_dir, usage};
use crate::{Exit, SHELLS_USAGE};

/// Runs the shells verb the command line names, and says how it went.
pub(crate) fn run(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    answer(verb(p, daemon), SHELLS_USAGE, out)
}

fn verb(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let sub = p.word(1).unwrap_or("list");
    let (own, words): (&[&str], usize) = match sub {
        "open" => (&["dir"], 3),
        "close" => (&["confirm-busy", "force"], 3),
        _ => (&["all"], 2),
    };
    if let Some(other) = p
        .given()
        .find(|o| !own.contains(o) && !["json", "home", "port"].contains(o))
    {
        return usage(format!("shells {sub} takes no --{other}"));
    }
    if let Some(extra) = p.word(words) {
        return usage(format!("shells {sub} takes no {extra}"));
    }
    match sub {
        "list" => list(p, daemon),
        "open" => open(p, daemon),
        _ => close(p, daemon),
    }
}

fn list(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let shown: Vec<&Shell> = state
        .shells
        .iter()
        .filter(|s| p.has("all") || !s.state.ended())
        .collect();
    if p.has("json") {
        return pretty(&shown);
    }
    if shown.is_empty() {
        return Ok("no shells".to_owned());
    }
    let lines: Vec<String> = shown.into_iter().map(|s| line(&state, s)).collect();
    Ok(lines.join("\n"))
}

/// A shell on one line: its name, id and state, the agent it's beside, what runs in it, where.
fn line(state: &StateSnapshot, shell: &Shell) -> String {
    let beside = shell.linked_agent_id.as_ref().map(|id| {
        let named = state
            .agents
            .iter()
            .find(|a| &a.id == id && !a.name.is_empty());
        let name = named.map_or(id.as_str(), |a| a.name.as_str());
        format!("beside {}", printable(name))
    });
    let fields = [
        shell.name.as_deref().map(printable),
        Some(shell.id.to_string()),
        Some(shell.state.as_str().to_owned()),
        beside,
        shell.foreground.as_ref().map(|f| printable(&f.command)),
        Some(printable(&shell.cwd)),
    ];
    let given: Vec<String> = fields
        .into_iter()
        .flatten()
        .filter(|f| !f.is_empty())
        .collect();
    given.join("  ")
}

fn open(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let (linked, cwd) = match (p.word(2), p.value("dir")) {
        (Some(_), Some(_)) => {
            return usage("a shell beside an agent opens in its directory, so takes no --dir");
        }
        (Some(given), None) => {
            let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
            let agent = find(&state, given)?;
            (Some((agent.id.clone(), label(agent))), None)
        }
        (None, dir) => (None, Some(start_dir(dir.unwrap_or(".")))),
    };
    let r: ShellCommandResponse = daemon.post(
        "/v1/shells",
        &OpenShellRequest {
            idempotency_key: key()?,
            linked_agent_id: linked.as_ref().map(|(id, _)| id.clone()),
            cwd,
            theme: None,
        },
        CALL,
    )?;
    if p.has("json") {
        return pretty(&r);
    }
    Ok(match linked {
        Some((_, agent)) => format!("opened {} beside {agent}", r.terminal_id),
        None => format!("opened {}", r.terminal_id),
    })
}

fn close(p: &Parsed, daemon: &Daemon) -> Step<String> {
    let given = need(p.word(2), "the shell")?;
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let shell = shell_named(&state, given)?;
    let label = match &shell.name {
        Some(name) => format!("{} ({})", printable(name), shell.id),
        None => shell.id.to_string(),
    };
    let r: ShellCommandResponse = daemon
        .post(
            &format!(
                "/v1/shells/{}/close",
                encode_uri_component(shell.id.as_str())
            ),
            &CloseShellRequest {
                idempotency_key: key()?,
                generation: shell.generation,
                confirm_busy: p.has("confirm-busy").then_some(true),
                confirmed_program: None,
                force: p.has("force").then_some(true),
            },
            CALL,
        )
        .map_err(|failed| how_to_close_busy(failed.into(), p.has("confirm-busy")))?;
    if p.has("json") {
        return pretty(&r);
    }
    Ok(if r.event_ids.is_empty() {
        format!("{label}: nothing to do")
    } else {
        format!("closed {label}")
    })
}

/// The shell `given` names: by its id, else by a name only one open shell has, ignoring ASCII case
/// as an agent's name is matched, since shells' names needn't differ.
pub(crate) fn shell_named<'s>(state: &'s StateSnapshot, given: &str) -> Step<&'s Shell> {
    if let Some(shell) = state.shells.iter().find(|s| s.id.as_str() == given) {
        return Ok(shell);
    }
    let named: Vec<&Shell> = state
        .shells
        .iter()
        .filter(|s| {
            !s.state.ended()
                && s.name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(given))
        })
        .collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => Err(Stop::Refused(format!(
            "the daemon has no open shell {}",
            printable(given)
        ))),
        many => {
            let ids: Vec<&str> = many.iter().map(|s| s.id.as_str()).collect();
            Err(Stop::Refused(format!(
                "{} open shells are named {}: name one by its id, {}",
                many.len(),
                printable(given),
                ids.join(" or ")
            )))
        }
    }
}
