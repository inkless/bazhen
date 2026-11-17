//! The daemon's events as they happen, and waiting on them for an agent or a shell to reach a
//! state. Both read `/v1/state` for a cursor and follow `/v1/events` from it; when the daemon goes
//! away they try again, waiting longer each time it still isn't there.

use std::io::ErrorKind;
use std::os::fd::BorrowedFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::events::{Event, EventFrame, ResetReason};
use bazhen_protocol::wire;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::io::Errno;
use tungstenite::{Message, WebSocket};

use crate::args::Parsed;
use crate::attach::tty::Stops;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::{encode_uri_component, printable};
use crate::lifecycle::{self, answer, pretty};
use crate::out::Out;
use crate::shells;
use crate::tasks::{Step, Stop, need, usage};
use crate::{EVENTS_USAGE, Exit};

/// The first wait before trying a daemon that has gone away again; each failure doubles it.
const FIRST_RETRY: Duration = Duration::from_millis(500);
const LAST_RETRY: Duration = Duration::from_secs(30);
const DEFAULT_WAIT: Duration = Duration::from_secs(60);

const AGENT_STATES: [&str; 8] = [
    "starting", "running", "exited", "unknown", "lost", "closing", "closed", "failed",
];
const SHELL_STATES: [&str; 8] = [
    "creating", "running", "exited", "unknown", "lost", "closing", "closed", "failed",
];

/// Runs `events` or `wait`, and says how it went.
pub(crate) fn run(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    let ran = if p.word(0) == Some("events") {
        events(p, daemon, out)
    } else {
        wait(p, daemon, out)
    };
    match ran {
        Ok(exit) => Ok(exit),
        Err(stop) => answer(Err(stop), EVENTS_USAGE, out),
    }
}

/// Refuses an option `own` doesn't hold, and a word after the first `words`.
fn only(p: &Parsed, verb: &str, own: &[&str], words: usize) -> Step<()> {
    if let Some(other) = p
        .given()
        .find(|o| !own.contains(o) && !["json", "home", "port"].contains(o))
    {
        return usage(format!("{verb} takes no --{other}"));
    }
    if let Some(extra) = p.word(words) {
        return usage(format!("{verb} takes no {extra}"));
    }
    Ok(())
}

fn events(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Step<Exit> {
    only(p, "events", &["follow", "after"], 1)?;
    if !p.has("follow") {
        return usage("events takes --follow: the daemon keeps no history to list");
    }
    let after = p
        .value("after")
        .map(|given| {
            whole(given).map_or_else(
                || usage(format!("--after is an event's id, not {given}")),
                Ok,
            )
        })
        .transpose()?;
    let json = p.has("json");
    let stops = Stops::watch().map_err(|e| Stop::Refused(e.to_string()))?;
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let mut cursor = Cursor::of(&state);
    if let Some(after) = after {
        cursor.after = after;
    }
    let ended = follow(daemon, cursor, Some(stops.fd()), None, |seen| {
        match seen {
            Seen::Events(events) => {
                for event in events {
                    if json {
                        out.line(&serde_json::to_string(event).map_err(|e| unwritable(&e))?);
                    } else {
                        out.line(&line(event));
                    }
                }
            }
            Seen::Reset(reason, _) => {
                if json {
                    out.line(&format!(
                        r#"{{"type":"reset","reason":"{}"}}"#,
                        reason.as_str()
                    ));
                } else {
                    out.err(&format!(
                        "events were missed ({}); following on from the daemon's state now",
                        reason.as_str()
                    ));
                }
            }
            Seen::Lost => out.err("the daemon isn't answering; trying again"),
        }
        // No one reads on, as when `head` has had its lines: the following is over.
        Ok(if out.closed() {
            Flow::Done(())
        } else {
            Flow::On
        })
    })?;
    match ended {
        Ended::Stopped | Ended::TimedOut | Ended::Done(()) => Ok(Exit::Done),
    }
}

/// An event as one line: its id, time, type, entity and actor.
fn line(e: &Event) -> String {
    format!(
        "{} {} {} {} {} {}",
        e.id,
        printable(&e.ts),
        printable(&e.kind),
        printable(&e.entity_type),
        printable(&e.entity_id),
        printable(&e.actor)
    )
}

fn unwritable(e: &serde_json::Error) -> Stop {
    Stop::Unreadable(e.to_string())
}

fn whole(given: &str) -> Option<u64> {
    (!given.is_empty() && given.bytes().all(|b| b.is_ascii_digit()))
        .then(|| given.parse().ok())
        .flatten()
}

/// What a wait is on: an agent or a shell, by id, as it was named once at the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Agent,
    Shell,
}

/// How the target stands against the condition.
enum Verdict {
    Met(String),
    Never(String),
    NotYet(String),
}

fn wait(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Step<Exit> {
    only(p, "wait", &["timeout"], 3)?;
    let given = need(p.word(1), "the agent or shell")?;
    let condition = need(p.word(2), "the state")?;
    let timeout = match p.value("timeout") {
        None => DEFAULT_WAIT,
        Some(t) => whole(t)
            .map(Duration::from_secs)
            .map_or_else(|| usage(format!("--timeout is whole seconds, not {t}")), Ok)?,
    };
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        return usage(format!("--timeout is too long: {} s", timeout.as_secs()));
    };
    let json = p.has("json");
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let (kind, id) = target(&state, given)?;
    let states = match kind {
        Kind::Agent => &AGENT_STATES,
        Kind::Shell => &SHELL_STATES,
    };
    if condition != "ended" && !states.contains(&condition) {
        let whose = if kind == Kind::Agent {
            "an agent's"
        } else {
            "a shell's"
        };
        return usage(format!(
            "{whose} state is {}, or ended; not {condition}",
            states.join(", ")
        ));
    }
    let judge = |state: &StateSnapshot| judge(state, kind, &id, condition, json);
    let mut latest = match judge(&state)? {
        Verdict::Met(said) => return Ok(met(&said, out)),
        Verdict::Never(said) => return Err(Stop::Refused(said)),
        Verdict::NotYet(said) => said,
    };
    let ended = follow(daemon, Cursor::of(&state), None, Some(deadline), |seen| {
        let verdict = match seen {
            Seen::Events(_) => match daemon.get::<StateSnapshot>("/v1/state", CALL) {
                Ok(state) => judge(&state)?,
                // The stream finds out it's gone, and tries again.
                Err(Failed::NotRunning) => return Ok(Flow::On),
                Err(failed) => return Err(failed.into()),
            },
            Seen::Reset(_, state) => judge(state)?,
            Seen::Lost => return Ok(Flow::On),
        };
        Ok(match verdict {
            Verdict::NotYet(said) => {
                latest = said;
                Flow::On
            }
            done => Flow::Done(done),
        })
    })?;
    match ended {
        Ended::Done(Verdict::Met(said)) => Ok(met(&said, out)),
        Ended::Done(Verdict::Never(said)) => Err(Stop::Refused(said)),
        Ended::Done(Verdict::NotYet(_)) | Ended::Stopped | Ended::TimedOut => {
            out.err(&format!("{latest} still, after {} s", timeout.as_secs()));
            Ok(Exit::TimedOut)
        }
    }
}

fn met(said: &str, out: &mut Out) -> Exit {
    out.line(said);
    Exit::Done
}

/// The agent or shell `given` names: an agent by its id or a name one not ended has, else a
/// shell by its id or a name one open shell has.
fn target(state: &StateSnapshot, given: &str) -> Step<(Kind, String)> {
    let an_agent = state.agents.iter().any(|a| {
        a.id.as_str() == given || (!a.state.ended() && a.name.eq_ignore_ascii_case(given))
    });
    if an_agent {
        return lifecycle::find(state, given).map(|a| (Kind::Agent, a.id.to_string()));
    }
    let a_shell = state.shells.iter().any(|s| {
        s.id.as_str() == given
            || (!s.state.ended()
                && s.name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(given)))
    });
    if a_shell {
        return shells::shell_named(state, given).map(|s| (Kind::Shell, s.id.to_string()));
    }
    Err(Stop::Refused(format!(
        "the daemon has no agent or open shell {}",
        printable(given)
    )))
}

/// Whether the agent or shell `id` is in `condition`, can't be now, or may yet be; each says
/// where it stands, as `--json` or a line.
fn judge(
    state: &StateSnapshot,
    kind: Kind,
    id: &str,
    condition: &str,
    json: bool,
) -> Step<Verdict> {
    let (label, now, ended, record) = match kind {
        Kind::Agent => {
            let Some(agent) = state.agents.iter().find(|a| a.id.as_str() == id) else {
                return Ok(Verdict::Never(format!("{id} is gone")));
            };
            let record = if json { pretty(agent)? } else { String::new() };
            (
                lifecycle::label(agent),
                agent.state.as_str(),
                agent.state.ended(),
                record,
            )
        }
        Kind::Shell => {
            let Some(shell) = state.shells.iter().find(|s| s.id.as_str() == id) else {
                return Ok(Verdict::Never(format!("{id} is gone")));
            };
            let label = match shell.name.as_deref() {
                Some(name) if !name.is_empty() => format!("{} ({id})", printable(name)),
                _ => id.to_owned(),
            };
            let record = if json { pretty(shell)? } else { String::new() };
            (label, shell.state.as_str(), shell.state.ended(), record)
        }
    };
    let met = if condition == "ended" {
        ended
    } else {
        now == condition
    };
    Ok(if met {
        Verdict::Met(if json {
            record
        } else {
            format!("{label} is {now}")
        })
    } else if ended {
        Verdict::Never(format!("{label} is {now}, and can't be {condition} now"))
    } else {
        Verdict::NotYet(format!("{label} is {now}"))
    })
}

/// Where the stream resumes: after the event `after`, in the store `epoch` names.
struct Cursor {
    epoch: String,
    after: u64,
}

impl Cursor {
    fn of(state: &StateSnapshot) -> Self {
        Self {
            epoch: state.epoch.clone(),
            after: state.event_id,
        }
    }

    fn path(&self) -> String {
        format!(
            "/v1/events?epoch={}&after={}",
            encode_uri_component(&self.epoch),
            self.after
        )
    }
}

/// What the stream brought since it was last asked.
enum Seen<'a> {
    /// The events read at once, in order.
    Events(&'a [Event]),
    /// Events were missed; the stream resumes from this state's cursor.
    Reset(ResetReason, &'a StateSnapshot),
    /// The daemon stopped answering; said once each time it goes.
    Lost,
}

enum Flow<T> {
    On,
    Done(T),
}

enum Ended<T> {
    Done(T),
    /// The person asked it to stop.
    Stopped,
    TimedOut,
}

/// Follows the stream from `cursor`, giving `on` what it brings, until `on` is done with it, a
/// wake-up comes on `stop`, or `deadline` passes. A stream that drops is opened again after the
/// last event seen: at once after one that brought something, else after a wait that doubles
/// from `FIRST_RETRY` to `LAST_RETRY`.
fn follow<T>(
    daemon: &Daemon,
    mut cursor: Cursor,
    stop: Option<BorrowedFd<'_>>,
    deadline: Option<Instant>,
    mut on: impl FnMut(Seen<'_>) -> Step<Flow<T>>,
) -> Step<Ended<T>> {
    let mut retry = Duration::ZERO;
    let mut lost = false;
    loop {
        if !retry.is_zero() {
            let until = Instant::now() + retry;
            match ready(None, stop, Some(deadline.map_or(until, |d| d.min(until))))? {
                Woke::Stop => return Ok(Ended::Stopped),
                Woke::Time if deadline.is_some_and(|d| Instant::now() >= d) => {
                    return Ok(Ended::TimedOut);
                }
                Woke::Time | Woke::Stream => {}
            }
        }
        let mut ws = match daemon.upgrade(&cursor.path(), "the daemon refused the event stream") {
            Ok(ws) => ws,
            Err(Failed::NotRunning) => {
                // A stop that came mid-handshake cut it short: the daemon isn't gone.
                if let Woke::Stop = ready(None, stop, Some(Instant::now()))? {
                    return Ok(Ended::Stopped);
                }
                if !lost {
                    lost = true;
                    if let Flow::Done(done) = on(Seen::Lost)? {
                        return Ok(Ended::Done(done));
                    }
                }
                retry = next(retry);
                continue;
            }
            Err(failed) => return Err(failed.into()),
        };
        lost = false;
        ws.get_ref()
            .set_read_timeout(None)
            .and_then(|()| ws.get_ref().set_write_timeout(None))
            .and_then(|()| ws.get_ref().set_nonblocking(true))
            .map_err(|_| Failed::NotRunning)?;
        let mut heard = false;
        // Frames that came with the handshake's answer wait in tungstenite, not on the socket: read
        // them before waiting on it.
        let mut waited = false;
        loop {
            if waited {
                match ready(Some(ws.get_ref()), stop, deadline)? {
                    Woke::Stop => return Ok(Ended::Stopped),
                    Woke::Time => return Ok(Ended::TimedOut),
                    Woke::Stream => {}
                }
            }
            waited = true;
            let mut events = Vec::new();
            let mut reset = None;
            let closed = drain(&mut ws, &mut events, &mut reset)?;
            if let Some(last) = events.last() {
                heard = true;
                cursor.after = last.id;
                if let Flow::Done(done) = on(Seen::Events(&events))? {
                    return Ok(Ended::Done(done));
                }
            }
            if let Some(reason) = reset {
                heard = true;
                let state: StateSnapshot = match daemon.get("/v1/state", CALL) {
                    Ok(state) => state,
                    Err(Failed::NotRunning) => break,
                    Err(failed) => return Err(failed.into()),
                };
                cursor = Cursor::of(&state);
                if let Flow::Done(done) = on(Seen::Reset(reason, &state))? {
                    return Ok(Ended::Done(done));
                }
                break;
            }
            if closed {
                break;
            }
        }
        retry = if heard { Duration::ZERO } else { next(retry) };
    }
}

fn next(retry: Duration) -> Duration {
    if retry.is_zero() {
        FIRST_RETRY
    } else {
        (retry * 2).min(LAST_RETRY)
    }
}

enum Woke {
    Stream,
    Stop,
    Time,
}

/// Waits until `stream` has something to read, a wake-up comes on `stop`, or `until` passes.
fn ready(
    stream: Option<&UnixStream>,
    stop: Option<BorrowedFd<'_>>,
    until: Option<Instant>,
) -> Step<Woke> {
    loop {
        let left = until
            .map(|at| Timespec::try_from(at.saturating_duration_since(Instant::now())))
            .transpose()
            .map_err(|e| Stop::Refused(e.to_string()))?;
        let mut fds = Vec::with_capacity(2);
        if let Some(stop) = stop {
            fds.push(PollFd::from_borrowed_fd(stop, PollFlags::IN));
        }
        if let Some(stream) = stream {
            fds.push(PollFd::new(stream, PollFlags::IN));
        }
        let woken = match poll(&mut fds, left.as_ref()) {
            Ok(n) => n,
            Err(Errno::INTR) => continue,
            Err(e) => return Err(Stop::Refused(e.to_string())),
        };
        if woken == 0 {
            return Ok(Woke::Time);
        }
        if stop.is_some() && fds.first().is_some_and(|fd| !fd.revents().is_empty()) {
            return Ok(Woke::Stop);
        }
        return Ok(Woke::Stream);
    }
}

/// Reads all the daemon has sent so far into `events`, and a reset into `reset`. True once the
/// stream is closed.
fn drain(
    ws: &mut WebSocket<UnixStream>,
    events: &mut Vec<Event>,
    reset: &mut Option<ResetReason>,
) -> Step<bool> {
    let closed = loop {
        match ws.read() {
            Ok(Message::Text(text)) => match wire::from_slice::<EventFrame>(text.as_bytes()) {
                Ok(EventFrame::Event { event }) => events.push(event),
                Ok(EventFrame::Reset { reason }) => *reset = Some(reason),
                Err(e) => {
                    return Err(Stop::Unreadable(format!(
                        "the daemon sent an event this build can't read: {e}"
                    )));
                }
            },
            Ok(Message::Close(_)) => break true,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break false,
            Err(_) => break true,
        }
    };
    // A pong the read queued goes out now, or with the next read.
    match ws.flush() {
        Ok(()) => Ok(closed),
        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => Ok(closed),
        Err(_) => Ok(true),
    }
}
