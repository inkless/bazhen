//! Claude Code, reached through its hooks (foundation-design §5.6). Bazhen picks the session id
//! itself, so the agent's first binding is known before any hook fires (§3.1), and passes its
//! hooks with the launch, beside the user's own, so nothing is written to the user's settings.

mod hook;
mod reply;
#[cfg(test)]
mod tests;

use crate::js::Js;
use crate::{
    ActivitySource, AgentRef, Answer, BoxFuture, Capabilities, ChannelPort, Delivery, Evidence,
    Harness, HarnessDeps, HarnessDoctor, IngestContext, Ingested, LaunchRequest, LaunchSpec,
    Listen, MailRefusal, Outgoing, Pending, PushPort, Pushed, Refused, Report, Resolution, RunPort,
    Session, SessionRef, Waiting,
};
use bazhen_protocol::agents::{ActivityValue, ExternalRef, ExternalRefKind};
use bazhen_protocol::shells::TuiTheme;
use std::collections::HashMap;
use std::sync::Mutex;

/// Which status line Bazhen's runs inside for a session, or [`StatusLineChoice::Leave`] to set
/// none, leaving Claude Code's own (foundation-design §11.2).
#[derive(Debug, Clone, PartialEq)]
enum StatusLineChoice {
    /// Bazhen's, wrapping the user's own command, or drawing nothing for none.
    Wrap(Option<UserStatusLine>),
    Leave,
}

/// A Claude Code `statusLine` setting of the command kind.
#[derive(Debug, Clone, PartialEq)]
struct UserStatusLine {
    command: String,
    padding: Option<f64>,
}

/// What a settings file says of the status line.
enum SettingsLine {
    /// It sets none, or the file is missing or isn't JSON.
    Unset,
    /// One of another kind than a command, which Bazhen can't run inside its own.
    Other,
    Command(UserStatusLine),
}

/// Where an organisation's managed Claude Code settings live, on this platform.
fn managed_settings() -> &'static str {
    if std::env::consts::OS == "macos" {
        "/Library/Application Support/ClaudeCode/managed-settings.json"
    } else {
        "/etc/claude-code/managed-settings.json"
    }
}

/// `base` and the names after it as one path, as `path.join` gives it for these.
fn joined(base: &str, names: &[&str]) -> String {
    let mut path = base.trim_end_matches('/').to_owned();
    for name in names {
        if !path.is_empty() || base.starts_with('/') {
            path.push('/');
        }
        path.push_str(name);
    }
    path
}

/// How long a transcript found to hold a conversation is taken as read before it is looked at
/// again.
const TRANSCRIPT_CHECK_MS: i64 = 2_000;

/// How long a permission request waits for the inbox; its hook's own timeout is set past it, so
/// the hook gives up first and Claude Code's prompt decides, never an automatic allow.
pub(crate) const APPROVAL_WAIT_MS: u64 = 50_000;

/// How long a tool call may wait on the `PostToolUse` hook. The client gives up on the daemon after
/// 2 s and acks within 5 s more, so it is done well before Claude Code would kill it and drop
/// what it wrote.
const FOLD_TIMEOUT_S: u32 = 10;

/// The bazhen verbs an agent is taught, which run without a permission prompt: the daemon decides
/// what each caller may do with them. Its admin verbs, and answering approvals, still ask; so
/// `agents` is allowed verb by verb, since `agents launch`, `close` and `signal` are admin verbs.
const AGENT_VERBS: [&str; 8] = [
    "agents list",
    "agents whoami",
    "agents rename",
    "agents send",
    "agents wait",
    "tasks",
    "inbox escalate",
    "roles",
];

/// A verb given a file to read (`--file`, `--brief-file`) asks as before: allowed, it would put
/// any file the agent can read into mail and the event log with no prompt. Ask overrides allow.
const READS_A_FILE: &str = "Bash(bazhen *-file*)";

pub(crate) struct ClaudeCode {
    deps: HarnessDeps,
    /// A mode every agent starts in, overriding the user's settings; unset by default.
    permission_mode: Option<String>,
    /// When each transcript was last found to hold a conversation: a snapshot asks per agent.
    held: Mutex<HashMap<String, i64>>,
}

impl std::fmt::Debug for ClaudeCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeCode")
            .field("deps", &self.deps)
            .finish_non_exhaustive()
    }
}

impl ClaudeCode {
    pub(crate) fn new(deps: HarnessDeps) -> Self {
        let permission_mode =
            (deps.daemon_env)("BAZHEN_CLAUDE_PERMISSION_MODE").filter(|mode| !mode.is_empty());
        Self {
            deps,
            permission_mode,
            held: Mutex::new(HashMap::new()),
        }
    }

    /// Which status line Bazhen's wraps for a session started in `cwd`. Only the user's own is
    /// lifted into the launch's settings. A project's settings are left to Claude Code, which
    /// gates them on the folder's trust, and so are managed settings, which outrank every other:
    /// when either sets a status line, or the user's isn't a command, Bazhen sets none, and that
    /// agent reports no usage.
    fn status_line(&self, cwd: &str) -> StatusLineChoice {
        let theirs = [
            managed_settings().to_owned(),
            joined(cwd, &[".claude", "settings.local.json"]),
            joined(cwd, &[".claude", "settings.json"]),
        ];
        if theirs
            .iter()
            .any(|file| !matches!(self.settings_line(file), SettingsLine::Unset))
        {
            return StatusLineChoice::Leave;
        }
        let config = (self.deps.user_env)("CLAUDE_CONFIG_DIR")
            .unwrap_or_else(|| joined(&self.deps.home, &[".claude"]));
        match self.settings_line(&joined(&config, &["settings.json"])) {
            SettingsLine::Unset => StatusLineChoice::Wrap(None),
            // One Bazhen can't run inside its own is left as it is, too.
            SettingsLine::Other => StatusLineChoice::Leave,
            SettingsLine::Command(line) => StatusLineChoice::Wrap(Some(line)),
        }
    }

    fn settings_line(&self, file: &str) -> SettingsLine {
        let Some(settings) = (self.deps.read_file)(file).and_then(|t| Js::parse(t.as_bytes()))
        else {
            return SettingsLine::Unset;
        };
        // JavaScript's typeof is "object" for an array as for an object.
        let Some(line @ (Js::Object(_) | Js::Array(_))) = settings.field("statusLine") else {
            return SettingsLine::Unset;
        };
        match (
            line.field("type").and_then(Js::as_str),
            line.field("command").and_then(Js::as_str),
        ) {
            (Some("command"), Some(command)) if !command.is_empty() => {
                SettingsLine::Command(UserStatusLine {
                    command: command.to_owned(),
                    padding: line.field("padding").and_then(Js::as_number),
                })
            }
            _ => SettingsLine::Other,
        }
    }

    /// Whether a transcript holds a conversation `--resume` can load.
    fn holds_conversation(&self, transcript: &str) -> bool {
        (self.deps.scan_transcript)(transcript, &mut is_conversation_entry)
    }

    /// The TUI with its hooks; Claude Code reads a theme in its settings ahead of the user's own,
    /// for this launch only.
    fn spec(&self, session: [&str; 2], request: &LaunchRequest) -> LaunchSpec {
        let [flag, id] = session;
        let mut argv = vec!["claude".to_owned(), flag.to_owned(), id.to_owned()];
        if let Some(name) = &request.name {
            argv.extend(["-n".to_owned(), name.clone()]);
        }
        if let Some(tokens) = request.compact_window_tokens {
            argv.extend(["--autocompact".to_owned(), tokens.to_string()]);
        }
        argv.extend(["--settings".to_owned(), self.settings(request).stringify()]);
        if let Some(mode) = &self.permission_mode {
            argv.extend(["--permission-mode".to_owned(), mode.clone()]);
        }
        // From their file when there is one, which keeps a user's role prompt out of the
        // process's arguments.
        match (&request.instructions_file, &request.instructions) {
            (Some(file), _) => {
                argv.extend(["--append-system-prompt-file".to_owned(), file.clone()]);
            }
            (None, Some(text)) => argv.extend(["--append-system-prompt".to_owned(), text.clone()]),
            (None, None) => {}
        }
        LaunchSpec {
            argv,
            env: Vec::new(),
            theme: request.theme,
            session: Some(SessionRef {
                kind: ExternalRefKind::ClaudeSession,
                id: id.to_owned(),
            }),
        }
    }

    /// The `--settings` the launch passes.
    fn settings(&self, request: &LaunchRequest) -> Js {
        let mut settings = vec![
            ("hooks".to_owned(), hooks(&self.deps.hook_command)),
            (
                "permissions".to_owned(),
                object([
                    (
                        "allow",
                        Js::Array(
                            AGENT_VERBS
                                .iter()
                                .map(|verb| string(&format!("Bash(bazhen {verb}:*)")))
                                .collect(),
                        ),
                    ),
                    ("ask", Js::Array(vec![string(READS_A_FILE)])),
                ]),
            ),
        ];
        if let StatusLineChoice::Wrap(user) = self.status_line(&request.cwd) {
            settings.push((
                "statusLine".to_owned(),
                wrapped_status_line(&self.deps.hook_command, user.as_ref()),
            ));
        }
        if let Some(theme) = request.theme {
            settings.push(("theme".to_owned(), string(theme.as_str())));
        }
        Js::Object(settings)
    }
}

fn string(s: &str) -> Js {
    Js::String(s.to_owned())
}

fn object<const N: usize>(entries: [(&str, Js); N]) -> Js {
    Js::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn seconds(s: u32) -> Js {
    Js::Number(f64::from(s))
}

/// One shell word, whatever the string holds.
fn shell_word(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Bazhen's status line: the hook client's wrapper, which runs the user's own command inside it,
/// its output passed through unchanged, and reports the line's input to the daemon.
fn wrapped_status_line(hook: &str, user: Option<&UserStatusLine>) -> Js {
    let inner = user.map_or(String::new(), |u| {
        format!(" sh -c {}", shell_word(&u.command))
    });
    let mut line = vec![
        ("type".to_owned(), string("command")),
        (
            "command".to_owned(),
            string(&format!("{hook} statusline-wrap{inner}")),
        ),
    ];
    if let Some(padding) = user.and_then(|u| u.padding) {
        line.push(("padding".to_owned(), Js::Number(padding)));
    }
    Js::Object(line)
}

/// The hooks a launch installs. The waiter runs asynchronously after every turn and at start,
/// and wakes an idle session when mail arrives (`asyncRewake`); Claude Code kills it at its
/// timeout, so that is a day and the waiter gives up first.
fn hooks(hook: &str) -> Js {
    let run = |event: &str, timeout: u32| {
        vec![
            ("type".to_owned(), string("command")),
            ("command".to_owned(), string(&format!("{hook} {event}"))),
            ("timeout".to_owned(), seconds(timeout)),
        ]
    };
    let hook_list =
        |hooks: Vec<Vec<(String, Js)>>| Js::Array(hooks.into_iter().map(Js::Object).collect());
    let group =
        |hooks: Vec<Vec<(String, Js)>>| Js::Array(vec![object([("hooks", hook_list(hooks))])]);
    let matched = |hooks: Vec<Vec<(String, Js)>>| {
        Js::Array(vec![object([
            ("matcher", string("*")),
            ("hooks", hook_list(hooks)),
        ])])
    };
    let mut waiter = run("wait", 86_400);
    waiter.push(("asyncRewake".to_owned(), Js::Bool(true)));
    // Reports that change nothing in the session run beside it, so no tool call waits on them.
    let report = |event: &str| {
        let mut r = run(event, 10);
        r.push(("async".to_owned(), Js::Bool(true)));
        r
    };
    object([
        ("SessionStart", group(vec![waiter.clone()])),
        // Not async: a turn's end must reach the daemon before the next turn's prompt does.
        ("Stop", group(vec![waiter.clone(), run("Stop", 10)])),
        // An API error ends the turn with StopFailure instead of Stop, idle all the same.
        ("StopFailure", group(vec![waiter, run("StopFailure", 10)])),
        ("UserPromptSubmit", group(vec![run("UserPromptSubmit", 10)])),
        // Not async: a permission request that follows must find the call it is about.
        ("PreToolUse", matched(vec![run("PreToolUse", 10)])),
        (
            "PermissionRequest",
            matched(vec![run(
                "PermissionRequest",
                u32::try_from(APPROVAL_WAIT_MS / 1000 + 10).unwrap_or(u32::MAX),
            )]),
        ),
        // Not async: its reply can fold mail into the running turn, so each tool call waits on it.
        (
            "PostToolUse",
            matched(vec![run("PostToolUse", FOLD_TIMEOUT_S)]),
        ),
        (
            "PostToolUseFailure",
            matched(vec![report("PostToolUseFailure")]),
        ),
        // A background subagent outlives the turn that started it: these say it is still at
        // work. Not async, so its start arrives before its first tool call.
        ("SubagentStart", group(vec![run("SubagentStart", 10)])),
        ("SubagentStop", group(vec![run("SubagentStop", 10)])),
    ])
}

/// Whether a line of a Claude Code transcript is one `--resume` can load the session from. A
/// session where only a command such as `/model` ran holds `system` entries and no message, and
/// resumes. Claude Code also writes metadata lines (`mode`, `permission-mode`, `atis-latch`,
/// `file-history-snapshot`), ahead of a turn too, and a transcript of only those is "No
/// conversation found".
fn is_conversation_entry(line: &str) -> bool {
    Js::parse(line.as_bytes())
        .as_ref()
        .and_then(|entry| entry.field("type"))
        .and_then(Js::as_str)
        .is_some_and(|kind| matches!(kind, "user" | "assistant" | "attachment" | "system"))
}

const THEMES: [TuiTheme; 2] = [TuiTheme::Light, TuiTheme::Dark];

impl Harness for ClaudeCode {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            delivery: Delivery::Pull,
            approvals: true,
            activity: ActivitySource::Hooks,
        }
    }

    fn themes(&self) -> &'static [TuiTheme] {
        &THEMES
    }

    fn launch<'a>(
        &'a self,
        request: &'a LaunchRequest,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> BoxFuture<'a, Result<LaunchSpec, Refused>> {
        let id = (self.deps.new_session_id)();
        let spec = self.spec(["--session-id", &id], request);
        Box::pin(std::future::ready(Ok(spec)))
    }

    fn resume<'a>(
        &'a self,
        request: &'a LaunchRequest,
        session: &'a ExternalRef,
        _channel: Option<&'a dyn ChannelPort>,
    ) -> Option<BoxFuture<'a, Result<LaunchSpec, Refused>>> {
        let spec = self.spec(["--resume", &session.id], request);
        Some(Box::pin(std::future::ready(Ok(spec))))
    }

    /// `--resume` loads a session only once its transcript, which its hooks name, holds a
    /// conversation. A session killed before its first turn has no file, and one killed just
    /// after a turn ended can have only the metadata Claude Code writes ahead of the turn. A "no"
    /// is never kept: nothing tells a client to read the agent again when the turn lands, so the
    /// next read must see it.
    fn can_resume(&self, evidence: &Evidence<'_>) -> bool {
        let Some(transcript) = evidence.transcript else {
            return false;
        };
        let now = (self.deps.now_ms)();
        let Ok(mut held) = self.held.lock() else {
            return self.holds_conversation(transcript);
        };
        if held
            .get(transcript)
            .is_some_and(|at| now - at < TRANSCRIPT_CHECK_MS)
        {
            return true;
        }
        held.retain(|_, when| now - *when < TRANSCRIPT_CHECK_MS);
        let holds = self.holds_conversation(transcript);
        if holds {
            held.insert(transcript.to_owned(), now);
        }
        holds
    }

    fn ingest(&self, report: Report<'_>, context: &IngestContext<'_>) -> Ingested {
        match (report, context.agent) {
            (Report::Hook { event, payload }, Some(agent)) => match Js::parse(payload) {
                Some(payload) => hook::ingest(event, &payload, agent, context.offered),
                None => Ingested::nothing(),
            },
            _ => Ingested::nothing(),
        }
    }

    /// The waiter wakes the session; a turn takes mail only while the agent is said to be
    /// working, since one ended by Esc reports no end, so its turn would otherwise stand.
    fn listening(&self, agent: &Listen) -> bool {
        match agent.hooks {
            Waiting::Waiter => true,
            Waiting::Turn => agent.activity == Some(ActivityValue::Working),
            Waiting::Nothing => false,
        }
    }

    fn not_ready_hint(&self) -> Option<&'static str> {
        None
    }

    fn accepts_mail(&self, _agent: &AgentRef<'_>) -> Result<(), MailRefusal> {
        Ok(())
    }

    fn push<'a>(
        &'a self,
        _mail: &'a Outgoing<'a>,
        _port: &'a dyn PushPort,
    ) -> BoxFuture<'a, Pushed> {
        Box::pin(std::future::ready(Pushed::NotNow))
    }

    fn answer(&self, to: &Pending<'_>, with: Resolution<'_>) -> Answer {
        reply::answer(to, with)
    }

    fn session(&self) -> Option<Box<dyn Session>> {
        None
    }

    fn doctor<'a>(
        &'a self,
        _channel: Option<&'a dyn ChannelPort>,
        _run: &'a dyn RunPort,
    ) -> BoxFuture<'a, Option<HarnessDoctor>> {
        Box::pin(std::future::ready(None))
    }
}
