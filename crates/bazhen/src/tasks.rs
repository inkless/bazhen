//! The verbs agents and humans run on tasks and on each other: each is a daemon call built from the
//! command line, and its answer printed as plain lines. A command line that doesn't say what to
//! do is refused before anything is sent, with why.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use bazhen_client::read_regular;

use bazhen_protocol::agents::{
    AgentCommandResponse, CallerResponse, HarnessId, RenameAgentRequest, StateSnapshot,
};
use bazhen_protocol::ids::{MessageId, is_id};
use bazhen_protocol::mail::{
    MESSAGE_WAIT_MAX_MS, MailboxState, SendMessageRequest, SendMessageResponse,
    WaitMessagesRequest, WaitMessagesResponse,
};
use bazhen_protocol::names::{AgentName, AgentRef, Role};
use bazhen_protocol::roles::RolesResponse;
use bazhen_protocol::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, BroadcastMessageResponse,
    CreateTaskRequest, CreateTaskResponse, DelegateTaskRequest, EscalateRequest, EscalateResponse,
    FinishTaskRequest, Grant, Launch, TaskCommandResponse, TaskDetail, TaskOutcome,
    UnassignTaskRequest,
};
use bazhen_protocol::text::task_note_text;

use crate::Exit;
use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed, WAIT_MARGIN};
use crate::fmt::{encode_uri_component, uuid};
use crate::out::Out;
use crate::paths::normalize;
use crate::printers::{active_for, fleet, list_agents, list_roles, list_tasks, show_task, whoami};
use crate::waits;

/// Why a task verb stopped before it was done.
#[derive(Debug)]
pub(crate) enum Stop {
    /// The command line doesn't say what to do; the message says why.
    Usage(String),
    /// The verb runs only somewhere else, as whoami inside an agent; the message says where.
    NotHere(String),
    /// A file the command line names can't be read.
    Unreadable(String),
    /// The daemon's state says the command can't be made, as for an agent it doesn't have.
    Refused(String),
    Call(Failed),
}

impl From<Failed> for Stop {
    fn from(f: Failed) -> Self {
        Self::Call(f)
    }
}

pub(crate) type Step<T> = Result<T, Stop>;

pub(crate) fn usage<T>(message: impl Into<String>) -> Step<T> {
    Err(Stop::Usage(message.into()))
}

/// What a verb prints, none when it printed its own already, and how it exits.
struct Answer {
    text: Option<String>,
    exit: Exit,
}

impl From<String> for Answer {
    fn from(text: String) -> Self {
        Self {
            text: Some(text),
            exit: Exit::Done,
        }
    }
}

/// The options `agents send` and `tasks send` take beside their text; `--home` and `--port` are
/// every verb's.
const SEND_OPTIONS: [&str; 6] = ["file", "wait", "reply", "timeout", "home", "port"];
const NOTE_OPTIONS: [&str; 3] = ["handoff", "home", "port"];
const DEFAULT_WAIT_S: u64 = 60;

/// Runs the verb the command line names, and says how it went, with `usage_text` under a usage
/// mistake.
pub(crate) fn run(
    p: &Parsed,
    daemon: &Daemon,
    now_ms: i64,
    usage_text: &str,
    out: &mut Out,
) -> Result<Exit, Failed> {
    let verb = Verb { p, daemon, now_ms };
    match verb.run(out) {
        Ok(answer) => {
            if let Some(text) = &answer.text {
                out.line(text);
            }
            Ok(answer.exit)
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

struct Verb<'a> {
    p: &'a Parsed,
    daemon: &'a Daemon,
    now_ms: i64,
}

/// `value`, refused as missing when absent or empty.
pub(crate) fn need<'v>(value: Option<&'v str>, what: &str) -> Step<&'v str> {
    match value {
        Some(v) if !v.is_empty() => Ok(v),
        _ => usage(format!("missing {what}")),
    }
}

/// An agent the command line names, by name or id.
pub(crate) fn agent_ref(value: Option<&str>, what: &str) -> Step<AgentRef> {
    let given = need(value, what)?;
    AgentRef::parse(given).or_else(|_| usage(format!("not an agent's name or id: {given}")))
}

/// A name the command line gives an agent, checked before the daemon is asked.
pub(crate) fn new_name(value: &str) -> Step<AgentName> {
    AgentName::parse(value).or_else(|e| usage(e.to_string()))
}

pub(crate) fn key() -> Step<String> {
    uuid().map_err(|e| Stop::Unreadable(format!("can't read the system's random source: {e}")))
}

/// The most of a file a brief or a message is read from: past any the daemon takes, so a file
/// it would refuse is still sent for it to say why, but never a device without an end.
const FILE_MAX: u64 = 1 << 20;

/// The text of a file a brief or a message comes from: a regular file, or `/dev/stdin`, each at
/// most `FILE_MAX` bytes. A FIFO, a device or anything else is refused, so `/dev/zero` can't run
/// the CLI out of memory, nor a FIFO with no writer hold it for ever.
fn read_file(path: &str) -> Step<String> {
    let unread = |why: String| Stop::Unreadable(format!("can't read {path}: {why}"));
    let bytes = if path == "/dev/stdin" {
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take(FILE_MAX + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| unread(e.to_string()))?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > FILE_MAX {
            return Err(unread(format!("more than {FILE_MAX} bytes")));
        }
        bytes
    } else {
        read_regular(Path::new(path), FILE_MAX).map_err(|e| unread(e.to_string()))?
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Where a message stands for a sender waiting on it: landed, bounced, or still on its way.
fn exit_for(state: MailboxState) -> Exit {
    if state == MailboxState::Undeliverable {
        Exit::Bounced
    } else if state.settled() {
        Exit::Done
    } else {
        Exit::Queued
    }
}

/// The exit of several sends: any bounced, else any still on its way, else landed.
fn worst(exits: &[Exit]) -> Exit {
    if exits.contains(&Exit::Bounced) {
        Exit::Bounced
    } else if exits.contains(&Exit::Queued) {
        Exit::Queued
    } else {
        Exit::Done
    }
}

impl Verb<'_> {
    fn word(&self, n: usize) -> Option<&str> {
        self.p.word(n)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.p.value(name)
    }

    fn has(&self, name: &str) -> bool {
        self.p.has(name)
    }

    fn state(&self) -> Step<StateSnapshot> {
        Ok(self.daemon.get("/v1/state", CALL)?)
    }

    /// The agent this command runs inside, as the daemon takes its calls to be that agent's. The
    /// environment can't say: a process the daemon attributes to an agent may carry no agent
    /// variable, and a Codex command's `BAZHEN_AGENT_ID` may be another agent's.
    fn me(&self) -> Step<Option<String>> {
        let r: CallerResponse = self.daemon.get("/v1/caller", CALL)?;
        Ok(r.agent_id.map(|id| id.to_string()))
    }

    /// The role `--role` names, else `fallback`.
    fn role(&self, fallback: &str) -> Step<Role> {
        let given = self.value("role");
        Role::parse(given.unwrap_or(fallback)).map_or_else(
            || {
                usage(format!(
                    "--role is a role bazhen roles lists, not {}",
                    given.unwrap_or("")
                ))
            },
            Ok,
        )
    }

    /// A brief, given as text or by a file, never both.
    fn brief(&self) -> Step<String> {
        if self.has("brief") && self.has("brief-file") {
            return usage("give --brief or --brief-file, not both");
        }
        match self.value("brief-file") {
            Some(file) => read_file(file),
            None => Ok(need(self.value("brief"), "--brief")?.to_owned()),
        }
    }

    /// Text given as words, refused when an option took some of it out unseen.
    fn words(&self, given: &[&str], allowed: &[&str]) -> Step<String> {
        let taken: Vec<&str> = self.p.given().filter(|o| !allowed.contains(o)).collect();
        if !taken.is_empty() {
            return usage(format!(
                "put the text in quotes: it holds --{}",
                taken.join(", --")
            ));
        }
        Ok(given.join(" "))
    }

    fn run(&self, out: &mut Out) -> Step<Answer> {
        let name = self.word(0).unwrap_or_default();
        let sub = self.word(1);
        let sends = name == "send" || (name == "tasks" && sub == Some("send"));
        if !sends && self.has("file") {
            return usage("--file is for agents send and tasks send; a brief takes --brief-file");
        }
        for (option, allowed, owner) in [
            ("wait", sends, "agents send and tasks send"),
            ("reply", name == "send", "agents send"),
            ("timeout", sends, "agents send and tasks send"),
            (
                "json",
                name == "agents" || (name == "send" && self.has("reply")),
                "agents list and agents send --reply",
            ),
            ("force", false, "agents close and shells close"),
            ("confirm-busy", false, "agents close and shells close"),
            ("fresh", false, "agents relaunch"),
        ] {
            if self.has(option) && !allowed {
                return usage(format!("--{option} is for {owner}"));
            }
        }
        if self.has("handoff") && !(name == "tasks" && sub == Some("note")) {
            return usage("--handoff is for tasks note");
        }
        let (verb, words) = match (name, sub) {
            ("agents" | "roles" | "tasks", Some("list")) => (format!("{name} list"), 2),
            ("agents" | "roles", _) => (name.to_owned(), 1),
            ("whoami", _) => ("agents whoami".to_owned(), 1),
            _ => (String::new(), usize::MAX),
        };
        if let Some(extra) = self.word(words) {
            return usage(format!("{verb} takes no {extra}"));
        }
        match name {
            "agents" => {
                let s = self.state()?;
                if self.has("json") {
                    let agents = fleet(&s, self.now_ms);
                    let text = serde_json::to_string_pretty(&agents)
                        .map_err(|e| Stop::Unreadable(e.to_string()))?;
                    return Ok(text.into());
                }
                Ok(list_agents(&s, self.now_ms).into())
            }
            "roles" => {
                let r: RolesResponse = self.daemon.get("/v1/roles", CALL)?;
                Ok(list_roles(&r).into())
            }
            "whoami" => {
                let Some(me) = self.me()? else {
                    return Err(Stop::NotHere(
                        "agents whoami runs inside an agent Bazhen launched".to_owned(),
                    ));
                };
                let s = self.state()?;
                whoami(&s, &me)
                    .map(Answer::from)
                    .or_else(|e| usage(format!("the daemon has no agent {}", e.0)))
            }
            "rename" => self.rename(),
            "escalate" => self.escalate(),
            "send" => self.send(out),
            "delegate" => self.delegate(),
            _ => self.task(out),
        }
    }

    fn rename(&self) -> Step<Answer> {
        let agent = agent_ref(self.word(1), "the agent to rename")?;
        let to = new_name(need(self.word(2), "the new name")?)?;
        let r: AgentCommandResponse = self.daemon.post(
            &format!("/v1/agents/{}/rename", encode_uri_component(agent.as_str())),
            &RenameAgentRequest {
                idempotency_key: key()?,
                name: to.clone(),
            },
            CALL,
        )?;
        Ok(if r.event_ids.is_empty() {
            format!("{agent} is already named {to}")
        } else {
            format!("renamed {agent} to {to}")
        }
        .into())
    }

    fn escalate(&self) -> Step<Answer> {
        let summary = self.p.words_from(1).join(" ");
        let summary = need(Some(&summary), "what to ask the human")?.to_owned();
        let r: EscalateResponse = self.daemon.post(
            "/v1/escalations",
            &EscalateRequest {
                idempotency_key: key()?,
                summary,
                task_id: self.value("task").map(str::to_owned),
            },
            CALL,
        )?;
        Ok(format!(
            "escalated as {}; the human answers in the inbox",
            r.attention_id
        )
        .into())
    }

    /// The milliseconds `--wait` waits, from `--timeout`; none without `--wait`.
    fn wait_ms(&self) -> Step<Option<u64>> {
        let timeout = self.value("timeout");
        if !self.has("wait") {
            if self.has("timeout") {
                return usage("--timeout is how long --wait waits; give --wait too");
            }
            return Ok(None);
        }
        let Some(given) = timeout else {
            return Ok(Some(DEFAULT_WAIT_S * 1000));
        };
        let ms = (!given.is_empty() && given.bytes().all(|b| b.is_ascii_digit()))
            .then(|| given.parse::<u64>().ok())
            .flatten()
            .and_then(|s| s.checked_mul(1000))
            .filter(|&ms| ms <= MESSAGE_WAIT_MAX_MS);
        ms.map_or_else(
            || {
                usage(format!(
                    "--timeout is whole seconds, at most {}, not {given}",
                    MESSAGE_WAIT_MAX_MS / 1000
                ))
            },
            |ms| Ok(Some(ms)),
        )
    }

    /// The text of a message: its words, or the file `--file` names, never both.
    fn body(&self, words: &[&str]) -> Step<String> {
        let text = self.words(words, &SEND_OPTIONS)?;
        if !text.is_empty() && self.has("file") {
            return usage("give the text or --file, not both");
        }
        match self.value("file") {
            Some(file) => read_file(file),
            None => Ok(need(Some(&text), "the text to send")?.to_owned()),
        }
    }

    fn send(&self, out: &mut Out) -> Step<Answer> {
        if self.has("task") {
            return usage(
                "agents send takes no --task: to send to a task's agents, use tasks send <task>; \
                 to send text that holds --task, put it in quotes",
            );
        }
        let agent = agent_ref(self.word(1), "the agent to send to")?;
        let body = self.body(&self.p.words_from(2))?;
        if self.has("reply") {
            return self.send_for_reply(&agent, body, out);
        }
        let wait = self.wait_ms()?;
        let request = SendMessageRequest {
            idempotency_key: key()?,
            body,
        };
        let r: SendMessageResponse = self.daemon.post(
            &format!(
                "/v1/agents/{}/messages",
                encode_uri_component(agent.as_str())
            ),
            &request,
            CALL,
        )?;
        match wait {
            None => Ok(format!("sent {} to {agent}", r.message_id).into()),
            Some(ms) => {
                let name = agent.to_string();
                self.wait_for(
                    &[(r.message_id.clone(), name.clone())],
                    ms,
                    &[],
                    |_| name.clone(),
                    out,
                )
            }
        }
    }

    /// Sends, then waits for the agent's reply. Only an agent can be replied to, so the human is
    /// refused before anything is sent.
    fn send_for_reply(&self, agent: &AgentRef, body: String, out: &mut Out) -> Step<Answer> {
        if self.has("wait") {
            return usage(
                "give --wait or --reply, not both: a reply comes after the message arrives",
            );
        }
        let deadline = waits::Deadline::start(waits::timeout(self.p)?);
        let caller: CallerResponse = self.daemon.get("/v1/caller", deadline.within(CALL))?;
        if caller.agent_id.is_none() {
            return Err(Stop::NotHere(
                "agents send --reply runs inside an agent Bazhen launched: only an agent can be \
                 replied to"
                    .to_owned(),
            ));
        }
        let r: SendMessageResponse = self.daemon.post(
            &format!(
                "/v1/agents/{}/messages",
                encode_uri_component(agent.as_str())
            ),
            &SendMessageRequest {
                idempotency_key: key()?,
                body,
            },
            deadline.within(CALL),
        )?;
        out.err(&format!(
            "sent {} to {agent}\nwaiting up to {} s for a reply",
            r.message_id,
            deadline.timeout().as_secs()
        ));
        let exit = waits::reply(self.daemon, r.message_id, deadline, self.has("json"), out)?;
        Ok(Answer { text: None, exit })
    }

    fn task_send(&self, out: &mut Out) -> Step<Answer> {
        let task = need(self.word(2), "the task to send to")?;
        let body = self.body(&self.p.words_from(3))?;
        let wait = self.wait_ms()?;
        let r: BroadcastMessageResponse = self.daemon.post(
            &format!("/v1/tasks/{}/messages", encode_uri_component(task)),
            &SendMessageRequest {
                idempotency_key: key()?,
                body,
            },
            CALL,
        )?;
        self.broadcast(&r, wait, out)
    }

    /// A task's broadcast: each message sent and each assignee skipped, waited on when asked. One
    /// that skipped anyone exits as bounced, so a script never takes it for having reached the
    /// whole task.
    fn broadcast(
        &self,
        r: &BroadcastMessageResponse,
        wait: Option<u64>,
        out: &mut Out,
    ) -> Step<Answer> {
        let skipped: Vec<String> = r
            .skipped
            .iter()
            .map(|s| format!("skipped {}: {}", s.agent_id, s.reason))
            .collect();
        let Some(ms) = wait else {
            let mut lines: Vec<String> = r
                .sent
                .iter()
                .map(|m| format!("sent {} to {}", m.message_id, m.agent_id))
                .collect();
            lines.extend(skipped.iter().cloned());
            let exit = if skipped.is_empty() {
                Exit::Done
            } else {
                Exit::Bounced
            };
            return Ok(Answer {
                text: Some(lines.join("\n")),
                exit,
            });
        };
        if r.sent.is_empty() {
            return Ok(Answer {
                text: Some(skipped.join("\n")),
                exit: Exit::Bounced,
            });
        }
        let sent: Vec<(MessageId, String)> = r
            .sent
            .iter()
            .map(|m| (m.message_id.clone(), m.agent_id.to_string()))
            .collect();
        self.wait_for(&sent, ms, &skipped, str::to_owned, out)
    }

    /// Says what was sent, waits on it, then prints each message's state after `skipped`, and
    /// exits as they stand. What was sent is said before the wait, so a sender whose wait fails
    /// still knows what went, and resends nothing.
    fn wait_for(
        &self,
        sent: &[(MessageId, String)],
        ms: u64,
        skipped: &[String],
        to: impl Fn(&str) -> String,
        out: &mut Out,
    ) -> Step<Answer> {
        let said: Vec<String> = sent
            .iter()
            .map(|(id, agent)| format!("sent {id} to {}", to(agent)))
            .collect();
        out.err(&format!(
            "{}\nwaiting up to {} s",
            said.join("\n"),
            ms / 1000
        ));
        let ids = sent.iter().map(|(id, _)| id.clone()).collect();
        let r: WaitMessagesResponse = self.daemon.post(
            "/v1/messages/wait",
            &WaitMessagesRequest {
                message_ids: ids,
                timeout_ms: ms,
            },
            Duration::from_millis(ms) + WAIT_MARGIN,
        )?;
        let mut lines: Vec<String> = skipped.to_vec();
        lines.extend(r.messages.iter().map(|m| {
            format!(
                "{} to {}: {}",
                m.id,
                to(m.agent_id.as_str()),
                m.state.as_str()
            )
        }));
        let mut exits: Vec<Exit> = skipped.iter().map(|_| Exit::Bounced).collect();
        exits.extend(r.messages.iter().map(|m| exit_for(m.state)));
        Ok(Answer {
            text: Some(lines.join("\n")),
            exit: worst(&exits),
        })
    }

    fn delegate(&self) -> Step<Answer> {
        let harness = self.value("launch");
        let sub = self.word(1);
        if harness.is_some() && sub.is_some() {
            return usage("name the agent to delegate to, or --launch one, not both");
        }
        if harness.is_none() && self.has("dir") {
            return usage("--dir is where a --launch agent starts; give --launch too");
        }
        if harness.is_none() && self.has("name") {
            return usage(
                "--name names a --launch agent; give --launch too, or bazhen agents rename one that runs",
            );
        }
        let launched = match harness {
            None => None,
            Some(h) => Some(HarnessId::parse(h).map_or_else(
                || {
                    let all: Vec<&str> = HarnessId::ALL.iter().map(|h| h.as_str()).collect();
                    usage(format!("--launch is {}, not {h}", all.join(" or ")))
                },
                Ok,
            )?),
        };
        let (agent_id, launch) = match launched {
            None => (
                Some(agent_ref(
                    sub,
                    "the agent to delegate to, or --launch <harness>",
                )?),
                None,
            ),
            Some(harness) => {
                let cwd = self.value("dir").map(start_dir);
                let name = self.value("name").map(new_name).transpose()?;
                (None, Some(Launch { harness, cwd, name }))
            }
        };
        let role = self.role("worker")?;
        let title = need(self.value("title"), "--title")?.to_owned();
        let brief = self.brief()?;
        let r: CreateTaskResponse = self.daemon.post(
            "/v1/tasks/delegate",
            &DelegateTaskRequest {
                idempotency_key: key()?,
                from_task_id: self.value("task").map(str::to_owned),
                agent_id,
                launch,
                role,
                title,
                brief,
            },
            CALL,
        )?;
        Ok(match launched {
            None => format!("delegated {} to {}", r.task_id, sub.unwrap_or_default()),
            Some(h) => format!(
                "delegated {} to a new {} agent, as {}",
                r.task_id,
                h.as_str(),
                r.assignment_id
                    .as_ref()
                    .map_or_else(|| "?".to_owned(), ToString::to_string)
            ),
        }
        .into())
    }

    fn task(&self, out: &mut Out) -> Step<Answer> {
        match self.word(1) {
            Some("show") => {
                let id = need(self.word(2), "the task")?;
                let d: TaskDetail = self.daemon.get(&format!("/v1/tasks/{id}"), CALL)?;
                let s = self.state()?;
                Ok(show_task(&d, &s).into())
            }
            Some("create") => self.create(),
            Some("assign") => {
                let task = need(self.word(2), "the task")?;
                let agent = agent_ref(self.word(3), "the agent")?;
                let role = self.role("worker")?;
                let r: AssignTaskResponse = self.daemon.post(
                    &format!("/v1/tasks/{task}/assign"),
                    &AssignTaskRequest {
                        idempotency_key: key()?,
                        agent_id: agent.clone(),
                        role,
                    },
                    CALL,
                )?;
                Ok(format!("assigned {agent} as {}", r.assignment_id).into())
            }
            Some("unassign") => {
                let task = need(self.word(2), "the task")?;
                let assignment = need(self.word(3), "the assignment")?;
                let _: TaskCommandResponse = self.daemon.post(
                    &format!("/v1/tasks/{task}/unassign"),
                    &UnassignTaskRequest {
                        idempotency_key: key()?,
                        assignment_id: assignment.to_owned(),
                    },
                    CALL,
                )?;
                Ok(format!("unassigned {assignment}").into())
            }
            Some(done @ ("done" | "cancel")) => {
                let outcome = if done == "done" {
                    TaskOutcome::Done
                } else {
                    TaskOutcome::Cancelled
                };
                match self.word(2) {
                    Some(task) => self.finish(task, outcome),
                    None if outcome == TaskOutcome::Cancelled => usage("missing the task"),
                    None => {
                        let task = self.own_task()?;
                        self.finish(&task, outcome)
                    }
                }
            }
            Some("note") => self.note(),
            Some("send") => self.task_send(out),
            _ => {
                let me = if self.has("all") { None } else { self.me()? };
                let s = self.state()?;
                Ok(list_tasks(&s, me.as_deref()).into())
            }
        }
    }

    fn create(&self) -> Step<Answer> {
        let title = need(self.value("title"), "--title")?.to_owned();
        let brief = self.brief()?;
        let parent_task_id = self.value("parent").map(str::to_owned);
        let assign = match self.value("assign") {
            None => None,
            Some(agent) => Some(Grant {
                agent_id: agent_ref(Some(agent), "--assign")?,
                role: self.role("worker")?,
            }),
        };
        let r: CreateTaskResponse = self.daemon.post(
            "/v1/tasks",
            &CreateTaskRequest {
                idempotency_key: key()?,
                title,
                brief,
                parent_task_id,
                assign,
            },
            CALL,
        )?;
        Ok(match r.assignment_id {
            None => format!("created {}", r.task_id),
            Some(a) => format!("created {}, assigned as {a}", r.task_id),
        }
        .into())
    }

    fn finish(&self, task: &str, outcome: TaskOutcome) -> Step<Answer> {
        let _: TaskCommandResponse = self.daemon.post(
            &format!("/v1/tasks/{task}/finish"),
            &FinishTaskRequest {
                idempotency_key: key()?,
                outcome,
                note: self.value("note").map(str::to_owned),
                cascade: self.has("cascade").then_some(true),
            },
            CALL,
        )?;
        Ok(format!("{task} {}", outcome.as_str()).into())
    }

    /// The one task the asking agent is assigned, read from the state.
    fn own_task(&self) -> Step<String> {
        let Some(me) = self.me()? else {
            return usage("missing the task (outside an agent, name it)");
        };
        let s = self.state()?;
        let mine = active_for(&s, &me);
        match mine.as_slice() {
            [only] => Ok(only.task_id.to_string()),
            [] => usage("you are assigned no task"),
            several => {
                let ids: Vec<String> = several.iter().map(|a| a.task_id.to_string()).collect();
                usage(format!("name one of {}", ids.join(", ")))
            }
        }
    }

    fn note(&self) -> Step<Answer> {
        let first = self.word(2);
        let named = first.filter(|f| is_id("task", f));
        let words = if named.is_some() {
            self.p.words_from(3)
        } else {
            self.p.words_from(2)
        };
        let text = self.words(&words, &NOTE_OPTIONS)?;
        let text = need(Some(&text), "the note's text")?;
        let text = task_note_text(text).or_else(|e| usage(e.to_string()))?;
        let handoff = self.has("handoff");
        let task = match named {
            Some(task) => task.to_owned(),
            None => self.own_task()?,
        };
        let _: TaskCommandResponse = self.daemon.post(
            &format!("/v1/tasks/{task}/notes"),
            &AddTaskNoteRequest {
                idempotency_key: key()?,
                text,
                handoff: handoff.then_some(true),
            },
            CALL,
        )?;
        let suffix = if handoff {
            ", as a handoff for whoever is assigned it next"
        } else {
            ""
        };
        Ok(format!("noted on {task}{suffix}").into())
    }
}

/// The directory a new agent starts in: one under the daemon user's home as given, for the daemon
/// to expand, and any other made absolute from where the command runs.
pub(crate) fn start_dir(dir: &str) -> String {
    if dir.starts_with('~') {
        dir.to_owned()
    } else {
        resolve(dir)
    }
}

/// `dir` from where the command runs, as Node's `path.resolve` makes it absolute.
fn resolve(dir: &str) -> String {
    if dir.starts_with('/') {
        return normalize(dir);
    }
    let cwd = std::env::current_dir()
        .map_or_else(|_| "/".to_owned(), |c| c.to_string_lossy().into_owned());
    normalize(&format!("{cwd}/{dir}"))
}
