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
use crate::{AGENTS_USAGE, EVENTS_USAGE, Exit, SHELLS_USAGE};

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

/// Runs `events follow`, and says how it went.
pub(crate) fn run_follow(p: &Parsed, daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    match events(p, daemon, out) {
        Ok(exit) => Ok(exit),
        Err(stop) => answer(Err(stop), EVENTS_USAGE, out),
    }
}

/// Runs `agents wait` or `shells wait`, for `kind`, and says how it went.
pub(crate) fn run_wait(
    p: &Parsed,
    kind: Kind,
    daemon: &Daemon,
    out: &mut Out,
) -> Result<Exit, Failed> {
    match wait(p, kind, daemon, out) {
        Ok(exit) => Ok(exit),
        Err(stop) => answer(Err(stop), kind.usage(), out),
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
    if p.word(1) != Some("follow") {
        return usage("events takes follow: the daemon keeps no history to list");
    }
    only(p, "events follow", &["after"], 2)?;
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
            Seen::Opened => {}
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
pub(crate) enum Kind {
    Agent,
    Shell,
}

impl Kind {
    fn noun(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Shell => "shell",
        }
    }

    fn whose(self) -> &'static str {
        match self {
            Self::Agent => "an agent's",
            Self::Shell => "a shell's",
        }
    }

    fn states(self) -> &'static [&'static str; 8] {
        match self {
            Self::Agent => &AGENT_STATES,
            Self::Shell => &SHELL_STATES,
        }
    }

    fn usage(self) -> &'static str {
        match self {
            Self::Agent => AGENTS_USAGE,
            Self::Shell => SHELLS_USAGE,
        }
    }
}

/// How the target stands against the condition.
enum Verdict {
    Met(String),
    Never(String),
    NotYet(String),
}

fn wait(p: &Parsed, kind: Kind, daemon: &Daemon, out: &mut Out) -> Step<Exit> {
    let noun = kind.noun();
    only(p, &format!("{noun}s wait"), &["timeout"], 3)?;
    let given = need(p.word(1), &format!("the {noun}"))?;
    let condition = need(p.word(2), "the state")?;
    if condition != "ended" && !kind.states().contains(&condition) {
        return usage(format!(
            "{} state is {}, or ended; not {condition}",
            kind.whose(),
            kind.states().join(", ")
        ));
    }
    let timeout = match p.value("timeout") {
        None => DEFAULT_WAIT,
        Some(t) => match whole(t) {
            Some(0) => return usage("--timeout is at least 1 s"),
            Some(secs) => Duration::from_secs(secs),
            None => return usage(format!("--timeout is whole seconds, not {t}")),
        },
    };
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        return usage(format!("--timeout is too long: {} s", timeout.as_secs()));
    };
    let json = p.has("json");
    let state: StateSnapshot = daemon.get("/v1/state", CALL.min(timeout))?;
    let id = target(&state, kind, given)?;
    let judge = |state: &StateSnapshot| judge(state, kind, &id, condition, json);
    let mut latest = match judge(&state)? {
        Verdict::Met(said) => return Ok(met(&said, out)),
        Verdict::Never(said) => return Err(Stop::Refused(said)),
        Verdict::NotYet(said) => said,
    };
    let mut watched = watching(&state, kind, &id);
    // The first stream opens from the state just judged; one opened again may have missed changes.
    let mut first = true;
    // A read of the state failed, so the next events are judged whatever they are on.
    let mut unsure = false;
    let ended = follow(daemon, Cursor::of(&state), None, Some(deadline), |seen| {
        let read;
        let state = match seen {
            Seen::Reset(_, state) => state,
            Seen::Events(events)
                if !unsure && !events.iter().any(|e| watched.contains(&e.entity_id)) =>
            {
                return Ok(Flow::On);
            }
            Seen::Opened if first => {
                first = false;
                return Ok(Flow::On);
            }
            Seen::Lost => return Ok(Flow::On),
            Seen::Events(_) | Seen::Opened => {
                let Some(within) = bound(Some(deadline)) else {
                    return Ok(Flow::On);
                };
                match daemon.get::<StateSnapshot>("/v1/state", within) {
                    Ok(state) => {
                        read = state;
                        &read
                    }
                    // The stream finds out it's gone, and tries again.
                    Err(Failed::NotRunning) => {
                        unsure = true;
                        return Ok(Flow::On);
                    }
                    Err(failed) => return Err(failed.into()),
                }
            }
        };
        unsure = false;
        watched = watching(state, kind, &id);
        Ok(match judge(state)? {
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

/// The entities whose events may move the target: itself, and an agent's terminal.
fn watching(state: &StateSnapshot, kind: Kind, id: &str) -> Vec<String> {
    let mut ids = vec![id.to_owned()];
    if kind == Kind::Agent
        && let Some(terminal) = state
            .agents
            .iter()
            .find(|a| a.id.as_str() == id)
            .and_then(|a| a.terminal_id.as_ref())
    {
        ids.push(terminal.as_str().to_owned());
    }
    ids
}

/// The agent or shell `given` names: an agent by its id or a name one not ended has, else a
/// shell by its id or a name one open shell has.
fn target(state: &StateSnapshot, kind: Kind, given: &str) -> Step<String> {
    match kind {
        Kind::Agent => lifecycle::find(state, given).map(|a| a.id.to_string()),
        Kind::Shell => shells::shell_named(state, given).map(|s| s.id.to_string()),
    }
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
    /// The stream is open, first or again; what it missed while closed comes after.
    Opened,
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
        let Some(within) = bound(deadline) else {
            return Ok(Ended::TimedOut);
        };
        let refused = "the daemon refused the event stream";
        let mut ws = match daemon.upgrade(&cursor.path(), refused, within) {
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
        if let Flow::Done(done) = on(Seen::Opened)? {
            return Ok(Ended::Done(done));
        }
        let mut heard = false;
        // Frames that came with the handshake's answer wait in tungstenite, not on the socket: read
        // them before waiting on it.
        let mut waited = false;
        loop {
            // A stream that is never quiet would keep the wait from timing out.
            if deadline.is_some_and(|d| Instant::now() >= d) {
                return Ok(Ended::TimedOut);
            }
            if waited {
                match ready(Some(ws.get_ref()), stop, deadline)? {
                    Woke::Stop => return Ok(Ended::Stopped),
                    Woke::Time => return Ok(Ended::TimedOut),
                    Woke::Stream => {}
                }
            }
            waited = true;
            let batch = drain(&mut ws, deadline);
            if let Some(last) = batch.events.last() {
                heard = true;
                cursor.after = last.id;
                if let Flow::Done(done) = on(Seen::Events(&batch.events))? {
                    return Ok(Ended::Done(done));
                }
            }
            if let Some(unreadable) = batch.unreadable {
                return Err(Stop::Unreadable(unreadable));
            }
            if let Some(reason) = batch.reset {
                heard = true;
                let Some(within) = bound(deadline) else {
                    return Ok(Ended::TimedOut);
                };
                let state: StateSnapshot = match daemon.get("/v1/state", within) {
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
            if batch.closed {
                break;
            }
        }
        retry = if heard { Duration::ZERO } else { next(retry) };
    }
}

/// How long a call may take: `CALL`, or less as `deadline` nears; None once it has passed.
fn bound(deadline: Option<Instant>) -> Option<Duration> {
    let Some(deadline) = deadline else {
        return Some(CALL);
    };
    let left = deadline.saturating_duration_since(Instant::now());
    (!left.is_zero()).then(|| left.min(CALL))
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

/// What one drain read: the events in order, a reset, whether the stream closed, and a frame this
/// build can't read, which ends the batch after the events before it.
#[derive(Default)]
struct Batch {
    events: Vec<Event>,
    reset: Option<ResetReason>,
    closed: bool,
    unreadable: Option<String>,
}

/// Reads all the daemon has sent so far, or all it sent before `deadline` passed.
fn drain(ws: &mut WebSocket<UnixStream>, deadline: Option<Instant>) -> Batch {
    let mut batch = Batch::default();
    while deadline.is_none_or(|d| Instant::now() < d) {
        match ws.read() {
            Ok(Message::Text(text)) => match wire::from_slice::<EventFrame>(text.as_bytes()) {
                Ok(EventFrame::Event { event }) => batch.events.push(event),
                Ok(EventFrame::Reset { reason }) => batch.reset = Some(reason),
                Err(e) => {
                    batch.unreadable = Some(format!(
                        "the daemon sent an event this build can't read: {e}"
                    ));
                    break;
                }
            },
            Ok(Message::Close(_)) => {
                batch.closed = true;
                break;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
            Err(_) => {
                batch.closed = true;
                break;
            }
        }
    }
    // A pong the read queued goes out now, or with the next read.
    match ws.flush() {
        Ok(()) => {}
        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
        Err(_) => batch.closed = true,
    }
    batch
}
