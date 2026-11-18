//! Waiting for an agent, a shell or a task to reach a condition, or for a reply: the daemon judges
//! it (`POST /v1/waits`), holding each call up to `WAIT_MAX_MS`. The CLI calls again while the
//! answer is pending and time is left, and when the daemon goes away it tries again, waiting
//! longer each time it still isn't there. However long that takes, it exits once.

use std::thread;
use std::time::{Duration, Instant};

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::ids::{MessageId, TaskId};
use bazhen_protocol::mail::MESSAGE_WAIT_MAX_MS;
use bazhen_protocol::waits::{
    AgentCondition, ShellCondition, TaskCondition, WaitCondition, WaitRequest, WaitResponse,
    WaitVerdict,
};

use crate::args::Parsed;
use crate::call::{Daemon, Failed};
use crate::events::{self, FIRST_RETRY};
use crate::fmt::printable;
use crate::lifecycle::{self, answer, pretty};
use crate::out::Out;
use crate::shells;
use crate::tasks::{Step, Stop, need, usage};
use crate::{AGENTS_USAGE, Exit, SHELLS_USAGE, TASKS_USAGE};

const DEFAULT_WAIT: Duration = Duration::from_secs(60);
/// How long before the deadline the daemon is asked to answer, so its answer arrives in time: at
/// most this, and a quarter of a short wait.
const GRACE: Duration = Duration::from_secs(1);

/// When a wait of `timeout` started now ends, whatever else the command does first.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Deadline {
    timeout: Duration,
    at: Instant,
}

impl Deadline {
    pub(crate) fn start(timeout: Duration) -> Self {
        Self {
            timeout,
            at: Instant::now() + timeout,
        }
    }

    pub(crate) fn timeout(self) -> Duration {
        self.timeout
    }

    fn left(self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    fn passed(self) -> bool {
        self.left().is_zero()
    }

    /// What is left of the time the daemon has to answer in.
    fn left_to_ask(self) -> Duration {
        self.left().saturating_sub(GRACE.min(self.timeout / 4))
    }

    /// What is left, capped at `most`: one call may take no longer than the wait has.
    pub(crate) fn within(self, most: Duration) -> Duration {
        most.min(self.left())
    }
}

/// The daemon answered no call before the wait ran out, though one took the call.
fn unanswered(deadline: Deadline, out: &mut Out) -> Exit {
    out.err(&format!(
        "the daemon didn't answer the wait within {} s",
        deadline.timeout.as_secs()
    ));
    Exit::TimedOut
}

/// What a wait is on, as the command line names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Noun {
    Agent,
    Shell,
    Task,
}

impl Noun {
    fn usage(self) -> &'static str {
        match self {
            Self::Agent => AGENTS_USAGE,
            Self::Shell => SHELLS_USAGE,
            Self::Task => TASKS_USAGE,
        }
    }
}

/// Runs `agents wait`, `shells wait` or `tasks wait`, and says how it went.
pub(crate) fn run(p: &Parsed, noun: Noun, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    match wait(p, noun, daemon, out) {
        Ok(exit) => Ok(exit),
        Err(stop) => answer(Err(stop), noun.usage(), out),
    }
}

/// `--timeout`, in whole seconds and at least 1; `DEFAULT_WAIT` when not given.
pub(crate) fn timeout(p: &Parsed) -> Step<Duration> {
    let Some(given) = p.value("timeout") else {
        return Ok(DEFAULT_WAIT);
    };
    let secs = (!given.is_empty() && given.bytes().all(|b| b.is_ascii_digit()))
        .then(|| given.parse::<u64>().ok())
        .flatten();
    match secs {
        Some(0) => usage("--timeout is at least 1 s"),
        Some(secs)
            if Instant::now()
                .checked_add(Duration::from_secs(secs))
                .is_some() =>
        {
            Ok(Duration::from_secs(secs))
        }
        Some(secs) => usage(format!("--timeout is too long: {secs} s")),
        None => usage(format!("--timeout is whole seconds, not {given}")),
    }
}

fn wait(p: &Parsed, noun: Noun, daemon: &Daemon, out: &mut Out) -> Step<Exit> {
    let verb = match noun {
        Noun::Agent => "agents wait",
        Noun::Shell => "shells wait",
        Noun::Task => "tasks wait",
    };
    if let Some(other) = p
        .given()
        .find(|o| !["timeout", "json", "home", "port"].contains(o))
    {
        return usage(format!("{verb} takes no --{other}"));
    }
    if let Some(extra) = p.word(3) {
        return usage(format!("{verb} takes no {extra}"));
    }
    let given = need(p.word(1), &format!("the {}", noun_word(noun)))?;
    let until = need(p.word(2), "what to wait for")?;
    let deadline = Deadline::start(timeout(p)?);
    let json = p.has("json");
    let condition = match noun {
        Noun::Agent => {
            let Some(until) = AgentCondition::parse(until) else {
                return usage(format!(
                    "an agent is waited on to be {}; not {until}",
                    words(AgentCondition::ALL.map(AgentCondition::as_str))
                ));
            };
            let Some(state) = read_state(daemon, deadline)? else {
                return Ok(unanswered(deadline, out));
            };
            let agent_id = lifecycle::find(&state, given)?.id.clone();
            WaitCondition::Agent { agent_id, until }
        }
        Noun::Shell => {
            let Some(until) = ShellCondition::parse(until) else {
                return usage(format!(
                    "a shell is waited on to be {}; not {until}",
                    words(ShellCondition::ALL.map(ShellCondition::as_str))
                ));
            };
            let Some(state) = read_state(daemon, deadline)? else {
                return Ok(unanswered(deadline, out));
            };
            let shell_id = shells::shell_named(&state, given)?.id.clone();
            WaitCondition::Shell { shell_id, until }
        }
        Noun::Task => {
            if until != "done" {
                return usage(format!("a task is waited on to be done; not {until}"));
            }
            let Some(task_id) = TaskId::parse(given) else {
                return usage(format!("<task> is a task's id, not {given}"));
            };
            WaitCondition::Task {
                task_id,
                until: TaskCondition::Done,
            }
        }
    };
    // Names were read from a daemon that answered; a task's wait is its first call.
    hold(daemon, &condition, deadline, noun != Noun::Task, json, out)
}

/// The daemon's state, to find a name in; none when it took the call but answered too late.
fn read_state(daemon: &Daemon, deadline: Deadline) -> Step<Option<StateSnapshot>> {
    match daemon.get("/v1/state", deadline.left()) {
        Ok(state) => Ok(Some(state)),
        Err(Failed::NotRunning) if deadline.passed() => Ok(None),
        Err(failed) => Err(failed.into()),
    }
}

fn noun_word(noun: Noun) -> &'static str {
    match noun {
        Noun::Agent => "agent",
        Noun::Shell => "shell",
        Noun::Task => "task",
    }
}

/// `a, b, or c`.
fn words<const N: usize>(all: [&str; N]) -> String {
    match all.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{}, or {last}", rest.join(", ")),
        _ => all.join(""),
    }
}

/// Waits until `deadline` for the reply to `message_id`, sent by this caller.
pub(crate) fn reply(
    daemon: &Daemon,
    message_id: MessageId,
    deadline: Deadline,
    json: bool,
    out: &mut Out,
) -> Step<Exit> {
    hold(
        daemon,
        &WaitCondition::Reply { message_id },
        deadline,
        true,
        json,
        out,
    )
}

/// Asks the daemon to judge `condition` until it answers otherwise than pending, or `deadline`
/// passes, then says where it stands and exits as it does. A daemon gone away is tried again
/// once one answered (`answered`); before that, it is not running. One that takes a call and
/// answers too late ran out the wait.
fn hold(
    daemon: &Daemon,
    condition: &WaitCondition,
    deadline: Deadline,
    mut answered: bool,
    json: bool,
    out: &mut Out,
) -> Step<Exit> {
    let mut retry = FIRST_RETRY;
    let mut latest: Option<WaitResponse> = None;
    loop {
        let ms = u64::try_from(deadline.left_to_ask().as_millis())
            .unwrap_or(u64::MAX)
            .min(MESSAGE_WAIT_MAX_MS);
        if ms == 0 {
            break;
        }
        let request = WaitRequest {
            condition: condition.clone(),
            timeout_ms: ms,
            resumed: latest.is_some().then_some(true),
        };
        match daemon.post::<WaitResponse>("/v1/waits", &request, deadline.left()) {
            Ok(r) if r.verdict == WaitVerdict::Pending => {
                answered = true;
                retry = FIRST_RETRY;
                latest = Some(r);
            }
            Ok(r) => return say(&r, deadline.timeout, json, out),
            Err(Failed::NotRunning) if answered || deadline.passed() => {
                answered = true;
                thread::sleep(retry.min(deadline.left()));
                retry = events::next(retry);
            }
            Err(failed) => return Err(failed.into()),
        }
    }
    match latest {
        Some(r) => say(&r, deadline.timeout, json, out),
        None if answered => Ok(unanswered(deadline, out)),
        None => Err(Stop::Call(Failed::NotRunning)),
    }
}

/// Prints where the wait stands: met on stdout, anything else on stderr, or the whole answer on
/// stdout with `json`; and exits as it stands.
fn say(r: &WaitResponse, timeout: Duration, json: bool, out: &mut Out) -> Step<Exit> {
    let exit = match r.verdict {
        WaitVerdict::Met => Exit::Done,
        WaitVerdict::Never => Exit::Failed,
        WaitVerdict::Bounced => Exit::Bounced,
        WaitVerdict::Pending => Exit::TimedOut,
    };
    if json {
        out.line(&pretty(r)?);
        return Ok(exit);
    }
    let said = printable(&r.said);
    match r.verdict {
        WaitVerdict::Met => match &r.reply_id {
            Some(id) => out.line(&format!("{said}: {id}")),
            None => out.line(&said),
        },
        WaitVerdict::Pending => {
            out.err(&format!("{said} still, after {} s", timeout.as_secs()));
        }
        WaitVerdict::Never | WaitVerdict::Bounced => out.err(&said),
    }
    Ok(exit)
}
