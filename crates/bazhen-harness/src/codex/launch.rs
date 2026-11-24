//! Starting a Codex agent's TUI: the thread Bazhen starts or resumes for it on the app-server,
//! then `codex resume` on that thread as another client of the same server (foundation-design
//! §5.8). And handing it mail, through `codex queue`.

use super::mail::{message_text, queue_args};
use super::threads::{Setting, compact_config, thread_config, toml_string};
use super::wire::{field, string};
use crate::js::Js;
use crate::{
    ChannelPort, LaunchError, LaunchRequest, LaunchSpec, Outgoing, Pushed, RunPort, SessionRef,
};
use bazhen_protocol::agents::ExternalRefKind;
use bazhen_protocol::shells::TuiTheme;
use serde_json::{Map, Value, json};
use std::time::Duration;

/// How long one `codex queue` may run.
const QUEUE_TIMEOUT: Duration = Duration::from_secs(60);

/// Where Codex's app-server listens for the Codex home `home`, as `--remote` takes it.
pub(super) fn app_server_address(codex_home: &str) -> String {
    format!("unix://{codex_home}/app-server-control/app-server-control.sock")
}

/// The first item of every agent's thread. A thread with no history can't be resumed, and a
/// developer message makes one without a model call.
fn binding(instructions: Option<&str>) -> Value {
    let text = "This thread belongs to an agent that Bazhen runs.";
    developer(&match instructions {
        Some(instructions) => format!("{text}\n\n{instructions}"),
        None => text.to_owned(),
    })
}

fn developer(text: &str) -> Value {
    json!({
        "type": "message",
        "role": "developer",
        "content": [{ "type": "input_text", "text": text }],
    })
}

/// What a resumed thread is given when its agent's instructions changed since its last start. The
/// thread keeps the earlier ones, so these say that they replace them.
fn superseding(instructions: &str) -> Value {
    developer(&format!(
        "Your instructions have changed. These replace the ones this thread was given earlier:\n\n{instructions}"
    ))
}

/// Codex has no light or dark of its own: `tui.theme` picks only its syntax highlighting, and its
/// other colours follow the background the terminal reports, which the runtime sets.
fn syntax_theme(theme: TuiTheme) -> &'static str {
    match theme {
        TuiTheme::Light => "one-half-light",
        TuiTheme::Dark => "one-half-dark",
    }
}

/// What one start of an agent gives the threads it loads: this daemon's socket, when there is
/// one, and the compaction window it asks for.
fn config(socket: Option<&str>, request: &LaunchRequest) -> Vec<(&'static str, Setting)> {
    let mut config = socket.map_or_else(Vec::new, thread_config);
    config.extend(compact_config(request.compact_window_tokens));
    config
}

/// `config` as a thread request's field.
fn config_field(config: &[(&'static str, Setting)], params: &mut Map<String, Value>) {
    if config.is_empty() {
        return;
    }
    let config = config
        .iter()
        .map(|(key, value)| {
            let value = match value {
                Setting::Text(text) => json!(text),
                Setting::Number(n) => json!(n),
            };
            ((*key).to_owned(), value)
        })
        .collect();
    params.insert("config".to_owned(), Value::Object(config));
}

/// `config` as `-c key=value` flags, as a TUI sends them with each thread it loads.
fn config_flags(config: &[(&'static str, Setting)]) -> impl Iterator<Item = String> {
    config.iter().flat_map(|(key, value)| {
        let value = match value {
            Setting::Text(text) => toml_string(text),
            Setting::Number(n) => n.to_string(),
        };
        ["-c".to_owned(), format!("{key}={value}")]
    })
}

/// The thread a `thread/start` or `thread/resume` result is about.
fn thread_of(result: &Value) -> Result<String, LaunchError> {
    let result = Js::parse(result.to_string().as_bytes());
    result
        .as_ref()
        .and_then(|r| string(field(r, "thread")?, "id"))
        .map(str::to_owned)
        .ok_or_else(|| {
            LaunchError::Unavailable("Codex's app-server answered with no thread".to_owned())
        })
}

/// What Codex is started with on every launch: the app-server it joins, and this daemon's socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Starts {
    /// The app-server, as `--remote` reaches it.
    pub(super) remote: String,
    pub(super) socket: Option<String>,
}

impl Starts {
    /// A new thread for the agent, with the item that binds it, and the TUI on it.
    pub(super) async fn launch(
        &self,
        request: &LaunchRequest,
        channel: &dyn ChannelPort,
    ) -> Result<LaunchSpec, LaunchError> {
        let config = config(self.socket.as_deref(), request);
        let mut params = Map::new();
        params.insert("cwd".to_owned(), json!(request.cwd));
        config_field(&config, &mut params);
        let started = channel
            .request("thread/start", Value::Object(params))
            .await?;
        let thread = thread_of(&started)?;
        // The thread keeps the item, so the instructions outlive a resume, as a flag would not.
        let items = [binding(request.instructions.as_deref())];
        channel
            .request(
                "thread/inject_items",
                json!({ "threadId": thread, "items": items }),
            )
            .await?;
        Ok(self.tui(&thread, request, &config))
    }

    /// The TUI again, on the agent's own thread. A thread with no subscriber unloads, so it is
    /// resumed first, which loads it from disk.
    pub(super) async fn resume(
        &self,
        request: &LaunchRequest,
        session: &str,
        channel: &dyn ChannelPort,
    ) -> Result<LaunchSpec, LaunchError> {
        let config = config(self.socket.as_deref(), request);
        let mut params = Map::new();
        params.insert("threadId".to_owned(), json!(session));
        params.insert("excludeTurns".to_owned(), json!(true));
        config_field(&config, &mut params);
        let resumed = channel
            .request("thread/resume", Value::Object(params))
            .await?;
        // The agent stays on its own thread; a server that answered with another would rebind it.
        // The server took the request, so this is no refusal of it, as the TypeScript daemon read it.
        let thread = thread_of(&resumed)?;
        if thread != session {
            return Err(LaunchError::Unavailable(format!(
                "asked to resume thread {session}, the app-server resumed {thread}"
            )));
        }
        if let (true, Some(instructions)) = (
            request.instructions_changed,
            request.instructions.as_deref(),
        ) {
            let items = [superseding(instructions)];
            channel
                .request(
                    "thread/inject_items",
                    json!({ "threadId": thread, "items": items }),
                )
                .await?;
        }
        Ok(self.tui(&thread, request, &config))
    }

    fn tui(
        &self,
        thread: &str,
        request: &LaunchRequest,
        config: &[(&'static str, Setting)],
    ) -> LaunchSpec {
        let mut argv = [
            "codex",
            "resume",
            thread,
            // Without it the TUI picks a server of its own.
            "--remote",
            &self.remote,
            // Keeps the transcript in the terminal's scrollback.
            "--no-alt-screen",
            // The TUI keeps its terminal's title set to the thread it shows, through /new and
            // /resume.
            "-c",
            r#"tui.terminal_title=["thread-id"]"#,
        ]
        .map(str::to_owned)
        .to_vec();
        argv.extend(config_flags(config));
        if let Some(theme) = request.theme {
            argv.push("-c".to_owned());
            argv.push(format!("tui.theme={}", toml_string(syntax_theme(theme))));
        }
        LaunchSpec {
            argv,
            env: Vec::new(),
            theme: request.theme,
            session: Some(SessionRef {
                kind: ExternalRefKind::CodexThread,
                id: thread.to_owned(),
            }),
        }
    }

    /// Stores one message in Codex: on the app-server, which wakes an idle thread and otherwise
    /// waits for the turn boundary, else in the Codex home, which holds it until a server comes
    /// up. Either way it waits there as queued, and is delivered once a turn takes it.
    pub(super) async fn push(&self, mail: &Outgoing<'_>, run: &dyn RunPort) -> Pushed {
        let Some(session) = mail.session else {
            return Pushed::NotNow;
        };
        let text = message_text(mail.message_id, mail.body);
        let mut failures = Vec::new();
        for remote in [Some(self.remote.as_str()), None] {
            let mut argv = vec!["codex".to_owned()];
            argv.extend(queue_args(&session.id, &text, remote));
            let to = remote.unwrap_or("the Codex home");
            match run.run(&argv, QUEUE_TIMEOUT).await {
                Ok(out) if out.code == Some(0) => {
                    return Pushed::Accepted {
                        offline: remote.is_none(),
                    };
                }
                Ok(out) => {
                    let how = out
                        .code
                        .map_or_else(|| "on a signal".to_owned(), |c| c.to_string());
                    failures.push(match out.stderr.trim() {
                        "" => format!("codex queue to {to} exited {how}"),
                        why => format!("codex queue to {to} exited {how}: {why}"),
                    });
                }
                Err(err) => failures.push(format!("codex queue to {to} failed: {err}")),
            }
        }
        Pushed::Failed {
            detail: failures.join("; "),
        }
    }
}
