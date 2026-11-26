//! Codex, reached through its app-server (foundation-design §5.8). The daemon keeps one connection
//! to the server; every Codex agent's TUI is a client of the same server, on its own thread, and
//! the thread's notifications say what the agent is doing.

mod approvals;
mod launch;
mod mail;
mod session;
mod signals;
#[cfg(test)]
mod tests;
mod threads;
mod wire;

use crate::js::Js;
use crate::{
    ActivitySource, AgentId, AgentRef, Answer, BoxFuture, Capabilities, ChannelPort, Delivery,
    Evidence, Gate, Harness, HarnessActivity, HarnessDeps, HarnessDoctor, Held, IngestContext,
    Ingested, Key, Keyed, LaunchError, LaunchRequest, LaunchSpec, LimitStop, Listen, MailRefusal,
    Observed, Outgoing, Pending, PushPort, Pushed, Reply, Report, Resolution, RunPort, Session,
    SessionKey, Settled, ToolKey,
};
use bazhen_protocol::agent_events::{CompactedSign, ReadySign};
use bazhen_protocol::agents::{ActivityValue, ExternalRef};
use bazhen_protocol::shells::TuiTheme;
use session::{CodexSession, Home, Move};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

const THEMES: [TuiTheme; 2] = [TuiTheme::Light, TuiTheme::Dark];

/// The detail of a turn a new server continued by itself after a restart or update.
pub(crate) const AUTO_CONTINUED: &str = "auto-continued after a Codex restart";
/// The detail of a thread whose turn a server's restart ended, until a turn starts on it.
pub(crate) const INTERRUPTED: &str = "interrupted by a Codex restart";
/// How many new threads are kept to find a title's thread in before the server is asked; the
/// oldest go first.
const SEEN: usize = 2000;
/// How long `bazhen doctor` waits on `codex --version`.
const CLI_TIMEOUT: Duration = Duration::from_secs(1);

/// What Bazhen holds of each thread with an agent on it, on the current connection and across one
/// that ends. A thread no running agent is bound to any more is forgotten, so it stays bounded.
#[derive(Debug, Default)]
struct Threads {
    /// Each thread's latest activity on the current connection.
    activity: HashMap<String, ActivityValue>,
    /// Threads whose last turn failed on this connection, so the idle after it doesn't hide it.
    failed: HashSet<String>,
    /// Threads busy when the last connection ended, until they are resumed.
    cut_off: HashSet<String>,
    /// Interrupted threads whose new turn hasn't shown its first item yet. Codex announces a turn
    /// before its items, so whether it is the new server's own waits for the first one.
    first_item: HashSet<String>,
    labels: HashMap<String, &'static str>,
    /// The server's requests no one has answered, by id as JSON text, to the thread and tool call
    /// each is for.
    requests: HashMap<String, (String, ToolKey)>,
    /// The question a text answer to a request goes to, by the request's key, and its thread.
    questions: HashMap<String, (String, String)>,
    /// The threads the server announced, oldest first, where a title's thread is looked for
    /// before the server is asked.
    seen: VecDeque<String>,
    /// Each agent's move its title asked for that has bound no thread yet, until a follow binds
    /// it or gives up, its title settles on a blank or its own thread, or the agent goes.
    moves: HashMap<AgentId, Move>,
    /// The version the last handshake named, or none, which stands across a connection that ends.
    version: Option<String>,
}

impl Threads {
    fn forget(&mut self, thread: &str) {
        self.activity.remove(thread);
        self.failed.remove(thread);
        self.cut_off.remove(thread);
        self.first_item.remove(thread);
        self.labels.remove(thread);
        self.requests.retain(|_, (on, _)| on != thread);
        self.questions.retain(|_, (on, _)| on != thread);
    }

    /// A thread the server announced, kept newest last.
    fn saw(&mut self, thread: &str) {
        self.seen.retain(|seen| seen != thread);
        self.seen.push_back(thread.to_owned());
        if self.seen.len() > SEEN {
            self.seen.pop_front();
        }
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

/// The state, never held across an await. A panic while it was held left it as it was.
fn lock(threads: &Mutex<Threads>) -> MutexGuard<'_, Threads> {
    threads.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Codex's adapter.
pub(crate) struct Codex {
    starts: launch::Starts,
    home: Home,
    /// Shared with its session, which picks each thread up again on every connection.
    threads: Arc<Mutex<Threads>>,
}

impl fmt::Debug for Codex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Codex").finish_non_exhaustive()
    }
}

impl Codex {
    /// Codex in the user's own Codex home, `CODEX_HOME` or `~/.codex`, on the app-server it manages
    /// there. Its threads reach the daemon on its socket.
    pub(crate) fn new(deps: &HarnessDeps) -> Self {
        // An empty `CODEX_HOME` is taken as it is, as the CLI the agents run takes it.
        let codex_home =
            (deps.user_env)("CODEX_HOME").unwrap_or_else(|| format!("{}/.codex", deps.home));
        let starts = launch::Starts {
            remote: launch::app_server_address(&codex_home),
            socket: Some(deps.daemon_socket.clone()),
        };
        Self::on(starts, Home::new(codex_home, Arc::clone(&deps.real_path)))
    }

    fn on(starts: launch::Starts, home: Home) -> Self {
        Self {
            starts,
            home,
            threads: Arc::default(),
        }
    }

    fn threads(&self) -> MutexGuard<'_, Threads> {
        lock(&self.threads)
    }

    fn notification(&self, method: &str, params: &Js, bound: bool) -> Vec<Keyed> {
        if let Some(limits) = signals::read_rate_limits(method, params) {
            // The account's, which every thread on this Codex home shares.
            return vec![account(Observed::AccountLimits(limits))];
        }
        if let Some(thread) = threads::read_thread_started(method, params) {
            self.threads().saw(&thread);
            return vec![account(Observed::SessionAnnounced {
                session: SessionKey(thread),
            })];
        }
        let mut t = self.threads();
        if let Some(id) = approvals::read_resolved(method, params) {
            let Some((thread, key)) = t.requests.remove(&request_key(&id)) else {
                return Vec::new();
            };
            t.questions.remove(&key.key);
            return vec![on(
                &thread,
                Observed::ApprovalSettled {
                    key,
                    how: Settled::AnsweredInTui,
                },
            )];
        }
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

    fn request(&self, method: &str, params: &Js, id: &str, bound: bool) -> Ingested {
        let approval = approvals::read_approval(method, params);
        let question = match approval {
            None => approvals::read_question(method, params),
            Some(_) => None,
        };
        // Not an approval or a question: the TUI answers it.
        let (thread, tool, summary) = match (&approval, &question) {
            (Some(a), _) => (&a.thread_id, &a.item_id, &a.summary),
            (None, Some(q)) => (&q.thread_id, &q.key, &q.summary),
            (None, None) => return Ingested::nothing(),
        };
        let key = ToolKey {
            key: Js::Array(vec![Js::String(thread.clone()), Js::String(tool.clone())]).stringify(),
            caller: None,
            prompt_id: None,
        };
        let answers = question.as_ref().and_then(|q| q.answers.clone());
        let fact = match (&approval, &answers) {
            (None, None) => Observed::QuestionAsked {
                key: key.clone(),
                summary: summary.clone(),
            },
            (_, answers) => Observed::ApprovalAsked {
                key: key.clone(),
                summary: summary.clone(),
                question: answers.is_some(),
            },
        };
        let mut t = self.threads();
        if !bound {
            // Left to the TUI, with nothing of the thread kept, but still told under its key: one
            // asked again of an item an agent had on the thread holds nothing of what it held.
            t.forget(thread);
            return Ingested {
                observed: vec![on(thread, fact)],
                origin: None,
                reply: Reply::Quiet,
                reply_gate: Gate::None,
            };
        }
        // As serverRequest/resolved names it, so the same id matches however it was written. One
        // that isn't JSON could never be matched, and is left to the TUI.
        let Some(id) = Js::parse(id.as_bytes()).map(|id| id.stringify()) else {
            return Ingested::nothing();
        };
        t.requests.insert(id, (thread.clone(), key.clone()));
        let reply = match (&fact, answers) {
            (Observed::QuestionAsked { .. }, _) => Reply::Quiet,
            (_, answers) => {
                if let Some(answers) = answers {
                    t.questions
                        .insert(key.key.clone(), (thread.clone(), answers));
                }
                // No deadline: the TUI asks the same request, and the first answer wins.
                Reply::Hold(Held::Approval { key, wait_ms: None })
            }
        };
        Ingested {
            observed: vec![on(thread, fact)],
            origin: None,
            reply,
            reply_gate: Gate::None,
        }
    }
}

/// The request id a `serverRequest/resolved` names, as JSON text, as the daemon reports a request's.
fn request_key(id: &approvals::RequestId) -> String {
    match id {
        approvals::RequestId::Number(n) => Js::Number(*n).stringify(),
        approvals::RequestId::Text(s) => Js::String(s.clone()).stringify(),
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

/// What to tell the user when a Codex agent's TUI never titles its terminal with its thread.
pub(crate) const NOT_READY_HINT: &str = "If Codex is up with no dialog, Bazhen didn't see it title its terminal with its thread: check that this Codex honours tui.terminal_title.";

/// The app-server's channel, or why there is none.
fn connected(channel: Option<&dyn ChannelPort>) -> Result<&dyn ChannelPort, LaunchError> {
    channel.ok_or_else(|| LaunchError::Unavailable("Codex's app-server isn't connected".to_owned()))
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
        request: &'a LaunchRequest,
        channel: Option<&'a dyn ChannelPort>,
    ) -> BoxFuture<'a, Result<LaunchSpec, LaunchError>> {
        Box::pin(async move { self.starts.launch(request, connected(channel)?).await })
    }

    fn resume<'a>(
        &'a self,
        request: &'a LaunchRequest,
        session: &'a ExternalRef,
        channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, LaunchError>>> {
        Some(Box::pin(async move {
            self.starts
                .resume(request, &session.id, connected(channel)?)
                .await
        }))
    }

    /// The server keeps every thread, so any the agent was bound to can be resumed.
    fn can_resume(&self, _evidence: &Evidence<'_>) -> bool {
        true
    }

    /// A thread's turns go to whichever TUI the server last saw on it.
    fn session_held_alone(&self) -> bool {
        true
    }

    /// The thread a notification or a request names.
    fn route(&self, report: &Report<'_>) -> Option<SessionKey> {
        let (Report::Notification { params, .. } | Report::ServerRequest { params, .. }) = report
        else {
            return None;
        };
        thread_of(&Js::parse(params)?).map(SessionKey)
    }

    fn ingest(&self, report: Report<'_>, context: &IngestContext<'_>) -> Ingested {
        let bound = context.agent.is_some();
        match report {
            Report::Notification { method, params } => Js::parse(params)
                .map_or_else(Ingested::nothing, |params| {
                    facts(self.notification(method, &params, bound))
                }),
            Report::ServerRequest { method, params, id } => Js::parse(params)
                .map_or_else(Ingested::nothing, |params| {
                    self.request(method, &params, id, bound)
                }),
            Report::TerminalTitle { title: text } => {
                let ingested = title(text, context);
                // Back on its own thread, or the TUI gone: no move waits any longer.
                if let (Some(agent), [fact]) = (context.agent, ingested.observed.as_slice())
                    && matches!(fact.fact, Observed::Release | Observed::Ready { .. })
                {
                    self.threads().moves.remove(agent);
                }
                ingested
            }
            Report::Hook { .. } => Ingested::nothing(),
        }
    }

    /// The server wakes an idle thread for mail and holds it for a busy one's next turn, so it
    /// reaches an agent bound to a thread, unless the agent's mail is held.
    fn listening(&self, agent: &Listen) -> bool {
        agent.bound && !agent.held
    }

    /// Codex's one sign it is up is the title, and a build that ignores the setting never gives it.
    fn not_ready_hint(&self) -> Option<&'static str> {
        Some(NOT_READY_HINT)
    }

    /// A Codex agent with no thread has nowhere to take mail, and the sender hears so now. The
    /// reason qualifies "no agent <id>", as the TypeScript daemon's refusal did.
    fn accepts_mail(&self, agent: &AgentRef<'_>) -> Result<(), MailRefusal> {
        match agent.session {
            Some(_) => Ok(()),
            None => Err(MailRefusal {
                reason: "bound to a Codex thread".to_owned(),
            }),
        }
    }

    fn push<'a>(&'a self, mail: &'a Outgoing<'a>, port: &'a dyn PushPort) -> BoxFuture<'a, Pushed> {
        Box::pin(self.starts.push(mail, port))
    }

    fn answer(&self, to: &Pending<'_>, with: Resolution<'_>) -> Answer {
        let Pending::ServerRequest { method, key } = to else {
            return Answer::Unavailable;
        };
        let result = match with {
            Resolution::Decision(decision) if approvals::takes_decision(method) => {
                approvals::approval_result(decision)
            }
            Resolution::Text(text) => {
                let Some((_, question)) = self.threads().questions.remove(&key.key) else {
                    return Answer::Unavailable;
                };
                approvals::question_result(&question, text)
            }
            Resolution::Decision(_) | Resolution::Mail(_) | Resolution::Nothing => {
                return Answer::Unavailable;
            }
        };
        // The inbox answered it, so the server saying it was resolved settles nothing more.
        self.threads()
            .requests
            .retain(|_, (_, asked)| asked.key != key.key);
        Answer::Rpc(result.to_string())
    }

    fn session(&self) -> Option<Box<dyn Session>> {
        Some(Box::new(CodexSession::new(
            self.home.clone(),
            self.starts.socket.clone(),
            Arc::clone(&self.threads),
        )))
    }

    /// The version the last handshake named, and the CLI's on the agents' `PATH`, if it answers
    /// within a second, as `bazhen doctor` waits on it. The daemon reads its own peer reader.
    fn doctor<'a>(
        &'a self,
        _channel: Option<&'a dyn ChannelPort>,
        run: &'a dyn RunPort,
    ) -> BoxFuture<'a, Option<HarnessDoctor>> {
        Box::pin(async move {
            let argv = ["codex", "--version"].map(str::to_owned);
            let cli = match run.run(&argv, CLI_TIMEOUT).await {
                Ok(output) if output.code == Some(0) => session::cli_version(&output.stdout),
                Ok(_) | Err(_) => None,
            };
            Some(HarnessDoctor {
                server: self.threads().version.clone(),
                cli,
                tool_calls: None,
            })
        })
    }
}
