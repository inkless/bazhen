//! Codex, reached through its app-server (foundation-design §5.8). The daemon keeps one connection
//! to the server; every Codex agent's TUI is a client of the same server, on its own thread, and
//! the thread's notifications say what the agent is doing.

mod mail;
mod signals;
#[cfg(test)]
mod tests;
mod threads;
mod wire;

use crate::js::Js;
use crate::{
    ActivitySource, AgentRef, Answer, BoxFuture, Capabilities, ChannelPort, Delivery, Evidence,
    Gate, Harness, HarnessActivity, HarnessDoctor, IngestContext, Ingested, Key, Keyed,
    LaunchError, LaunchRequest, LaunchSpec, LimitStop, Listen, MailRefusal, Observed, Outgoing,
    Pending, PushPort, Pushed, Report, Resolution, RunPort, Session, SessionKey,
};
use bazhen_protocol::agent_events::{CompactedSign, ReadySign};
use bazhen_protocol::agents::{ActivityValue, ExternalRef};
use bazhen_protocol::shells::TuiTheme;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};

const THEMES: [TuiTheme; 2] = [TuiTheme::Light, TuiTheme::Dark];

/// The detail of a turn a new server continued by itself after a restart or update.
pub(crate) const AUTO_CONTINUED: &str = "auto-continued after a Codex restart";
/// The detail of a thread whose turn a server's restart ended, until a turn starts on it.
pub(crate) const INTERRUPTED: &str = "interrupted by a Codex restart";

/// What Bazhen holds of each thread with an agent on it, on the current connection and across one
/// that ends. A thread no running agent is bound to any more is forgotten, so it stays bounded.
#[derive(Debug, Default)]
struct Threads {
    /// Each thread's latest activity on the current connection.
    activity: HashMap<String, ActivityValue>,
    /// Threads whose last turn failed on this connection, so the idle after it doesn't hide it.
    failed: HashSet<String>,
    /// Interrupted threads whose new turn hasn't shown its first item yet. Codex announces a turn
    /// before its items, so whether it is the new server's own waits for the first one.
    first_item: HashSet<String>,
    labels: HashMap<String, &'static str>,
}

impl Threads {
    fn forget(&mut self, thread: &str) {
        self.activity.remove(thread);
        self.failed.remove(thread);
        self.first_item.remove(thread);
        self.labels.remove(thread);
    }

    /// The thread's activity as a fact, with the error a failed turn names or the thread's label.
    fn signal(
        &mut self,
        thread: &str,
        value: ActivityValue,
        failure: Option<(Option<String>, Option<LimitStop>)>,
    ) -> Keyed {
        self.activity.insert(thread.to_owned(), value);
        let (error, limit) = failure.unwrap_or_default();
        let detail = error.or_else(|| self.labels.get(thread).map(|l| (*l).to_owned()));
        on(
            thread,
            Observed::Activity(HarnessActivity {
                value,
                detail,
                limit,
            }),
        )
    }
}

/// A fact about a thread. The server sends each thread's notifications only to its subscribers,
/// so one names the session it came from, whichever agent's it is, and the daemon finds the agent
/// by the session alone: nothing is gated. [`Gate::InSession`] and [`Gate::Owner`] tell an agent's
/// own session from another that ran its hook, and Codex has no hooks.
fn on(thread: &str, fact: Observed) -> Keyed {
    Keyed {
        key: Key::Session(SessionKey(thread.to_owned())),
        gate: Gate::None,
        fact,
    }
}

fn account(fact: Observed) -> Keyed {
    Keyed {
        key: Key::Account,
        gate: Gate::None,
        fact,
    }
}

fn facts(observed: Vec<Keyed>) -> Ingested {
    Ingested {
        observed,
        ..Ingested::nothing()
    }
}

/// Codex's adapter.
pub(crate) struct Codex {
    threads: Mutex<Threads>,
}

impl fmt::Debug for Codex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Codex").finish_non_exhaustive()
    }
}

impl Codex {
    pub(crate) fn new() -> Self {
        Self {
            threads: Mutex::default(),
        }
    }

    /// The state, never held across an await. A panic while it was held left it as it was.
    fn threads(&self) -> MutexGuard<'_, Threads> {
        self.threads.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn notification(&self, method: &str, params: &Js, bound: bool) -> Vec<Keyed> {
        if let Some(limits) = signals::read_rate_limits(method, params) {
            // The account's, which every thread on this Codex home shares.
            return vec![account(Observed::AccountLimits(limits))];
        }
        if let Some(thread) = threads::read_thread_started(method, params) {
            return vec![account(Observed::SessionAnnounced {
                session: SessionKey(thread),
            })];
        }
        let mut t = self.threads();
        let Some(thread) = thread_of(params) else {
            return Vec::new();
        };
        // On any thread: the daemon confirms a message by the message, not by the thread, so one
        // that Codex held for a thread no agent is on any more is still taken there.
        let mut out: Vec<Keyed> = mail::read_user_message(method, params)
            .and_then(|m| m.message_id)
            .map(|message_id| on(&thread, Observed::MailTaken { message_id }))
            .into_iter()
            .collect();
        if !bound {
            t.forget(&thread);
            return out;
        }
        if signals::read_compaction(method, params).is_some() {
            out.push(on(
                &thread,
                Observed::Compacted {
                    sign: CompactedSign::CodexItem,
                },
            ));
        } else if let Some(status) = signals::read_thread_status(method, params) {
            if status.not_loaded {
                out.push(t.signal(&thread, ActivityValue::Unknown, None));
                out.push(on(&thread, Observed::Unloaded));
            } else if !(status.activity == ActivityValue::Idle && t.failed.contains(&thread)) {
                out.push(t.signal(&thread, status.activity, None));
            }
        } else if let Some(turn) = signals::read_turn(method, params) {
            if turn.started {
                t.failed.remove(&thread);
                if t.labels.get(&thread) == Some(&INTERRUPTED) {
                    t.labels.remove(&thread);
                    t.first_item.insert(thread.clone());
                }
                out.push(on(&thread, Observed::TurnStarted));
                out.push(t.signal(&thread, ActivityValue::Working, None));
            } else {
                t.first_item.remove(&thread);
                if t.labels.get(&thread) == Some(&AUTO_CONTINUED) {
                    t.labels.remove(&thread);
                }
                match turn.ended.as_deref() {
                    Some("failed") => {
                        t.failed.insert(thread.clone());
                        out.push(on(
                            &thread,
                            Observed::TurnFailed {
                                prompt_id: None,
                                error: turn.error.clone(),
                            },
                        ));
                        let failure = Some((turn.error, turn.limit));
                        out.push(t.signal(&thread, ActivityValue::Failed, failure));
                    }
                    // One that doesn't say how it ended is left to the thread's status.
                    Some(_) => out.push(t.signal(&thread, ActivityValue::Idle, None)),
                    None => {}
                }
            }
        } else {
            let item = signals::read_item_started(method, params);
            if let Some(item) = item.filter(|i| t.first_item.remove(&thread) && !i.user_input) {
                // Nothing but the new server starts a turn on an interrupted thread with no input.
                t.labels.insert(item.thread_id, AUTO_CONTINUED);
                let value = t
                    .activity
                    .get(&thread)
                    .copied()
                    .unwrap_or(ActivityValue::Working);
                out.push(t.signal(&thread, value, None));
            }
        }
        out
    }
}

/// The thread a notification is about, when it names one: those about the account, or a thread
/// the server announces, are read before it.
fn thread_of(params: &Js) -> Option<String> {
    wire::string(params, "threadId").map(str::to_owned)
}

/// What a terminal's title says of its agent: up, on the thread it is bound to; moving, to the
/// thread it names; or, blank as the TUI leaves it when it exits, nothing held any longer.
///
/// A title that names no thread, as the user's own title config makes, is its own candidate:
/// [`Session::follow`](crate::Session::follow) reads no thread in it and leaves the agent where it
/// was, untracked, settling any move the title had started.
fn title(title: &str, context: &IngestContext<'_>) -> Ingested {
    let Some(agent) = context.agent else {
        return Ingested::nothing();
    };
    let fact = match threads::title_prefix(title) {
        None if title.trim_matches(threads::js_space).is_empty() => Observed::Release,
        None => Observed::TitleNames {
            candidate: title.to_owned(),
        },
        Some(prefix) => match context.session {
            Some(session) if session.id.starts_with(prefix) => Observed::Ready {
                sign: ReadySign::CodexTitle,
            },
            _ => Observed::TitleNames {
                candidate: prefix.to_owned(),
            },
        },
    };
    facts(vec![Keyed::agent(agent, Gate::None, fact)])
}

/// Not yet: the next change starts and resumes Codex's TUI, and pushes its mail.
fn not_yet<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
    Box::pin(std::future::ready(value))
}

impl Harness for Codex {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            delivery: Delivery::Push,
            approvals: true,
            activity: ActivitySource::Channel,
        }
    }

    fn themes(&self) -> &'static [TuiTheme] {
        &THEMES
    }

    fn launch<'a>(
        &'a self,
        _request: &'a LaunchRequest,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> BoxFuture<'a, Result<LaunchSpec, LaunchError>> {
        not_yet(Err(LaunchError::Unavailable(
            "Codex agents can't be started yet".to_owned(),
        )))
    }

    fn resume<'a>(
        &'a self,
        _request: &'a LaunchRequest,
        _session: &'a ExternalRef,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, LaunchError>>> {
        None
    }

    fn can_resume(&self, _evidence: &Evidence<'_>) -> bool {
        false
    }

    fn ingest(&self, report: Report<'_>, context: &IngestContext<'_>) -> Ingested {
        let bound = context.agent.is_some();
        match report {
            Report::Notification { method, params } => Js::parse(params)
                .map_or_else(Ingested::nothing, |params| {
                    facts(self.notification(method, &params, bound))
                }),
            Report::TerminalTitle { title: text } => title(text, context),
            // A request for the human is the next change's: until then the TUI answers it.
            Report::ServerRequest { .. } | Report::Hook { .. } => Ingested::nothing(),
        }
    }

    fn listening(&self, _agent: &Listen) -> bool {
        false
    }

    fn not_ready_hint(&self) -> Option<&'static str> {
        None
    }

    fn accepts_mail(&self, _agent: &AgentRef<'_>) -> Result<(), MailRefusal> {
        Err(MailRefusal {
            reason: "Codex agents can't take mail yet".to_owned(),
        })
    }

    fn push<'a>(
        &'a self,
        _mail: &'a Outgoing<'a>,
        _port: &'a dyn PushPort,
    ) -> BoxFuture<'a, Pushed> {
        not_yet(Pushed::NotNow)
    }

    fn answer(&self, _to: &Pending<'_>, _with: Resolution<'_>) -> Answer {
        Answer::Unavailable
    }

    fn session(&self) -> Option<Box<dyn Session>> {
        None
    }

    fn doctor<'a>(
        &'a self,
        _channel: Option<&'a dyn ChannelPort>,
        _run: &'a dyn RunPort,
    ) -> BoxFuture<'a, Option<HarnessDoctor>> {
        not_yet(None)
    }
}
