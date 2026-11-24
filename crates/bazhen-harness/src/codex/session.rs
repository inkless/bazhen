//! The daemon's one connection to Codex's app-server: the handshake that checks the server is the
//! user's Codex home's, and every agent's thread picked up again on each connection
//! (foundation-design §5.8).

use super::launch::{control_socket, resume_params};
use super::signals::{busy, result_activity, result_not_loaded};
use super::threads::js_space;
use super::wire::string;
use super::{AUTO_CONTINUED, INTERRUPTED, Threads, lock, on};
use crate::js::Js;
use crate::{
    Bound, BoxFuture, ChannelError, ChannelErrorKind, ChannelPort, Endpoint, Followed, Keyed,
    Lookup, Observed, Reloaded, Report, Session, SessionKey,
};
use bazhen_protocol::agents::ActivityValue;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// Why an agent stays where it is when its title names another thread.
pub(crate) const UNTRACKED: &str = "thread switches are not being tracked";

/// The Codex home the agents run in, as they name it and with its links resolved, which is how a
/// server names its own.
#[derive(Clone)]
pub(super) struct Home {
    pub(super) path: String,
    real: String,
    real_path: Arc<Lookup>,
}

impl Home {
    pub(super) fn new(path: String, real_path: Arc<Lookup>) -> Self {
        let real = resolved(&*real_path, &path);
        Self {
            path,
            real,
            real_path,
        }
    }
}

/// `path` with every link in it resolved, or as it is when it doesn't exist.
fn resolved(real_path: &Lookup, path: &str) -> String {
    real_path(path).unwrap_or_else(|| path.to_owned())
}

/// The server's version: the token after the client's name in `initialize`'s `userAgent`
/// (`bazhen/0.166.0 (Mac OS 26.7.1; arm64) …`), which has no field for it.
fn server_version(user_agent: &str) -> Option<String> {
    let (name, version) = user_agent.split_once(|c| c == '/' || js_space(c))?;
    // The first of them is the slash: the name is the run before it.
    let slash = user_agent.get(name.len()..)?.starts_with('/');
    let version = version
        .split(js_space)
        .next()
        .filter(|_| slash && !name.is_empty())?;
    (!version.is_empty()).then(|| version.to_owned())
}

/// The version in `codex --version`'s output (`codex-cli 0.166.0`).
pub(super) fn cli_version(output: &str) -> Option<String> {
    let output = output.trim_matches(js_space);
    let (name, version) = output.split_once(js_space)?;
    let spaced = output.get(name.len()..)?.starts_with(' ');
    let numbered = version.starts_with(|c: char| c.is_ascii_digit());
    (spaced && numbered && !version.contains(js_space)).then(|| version.to_owned())
}

/// Codex's [`Session`]. It shares what Codex holds of each thread with the adapter that reads the
/// server's notifications.
pub(super) struct CodexSession {
    home: Home,
    /// This daemon's socket, which every thread it loads is given.
    socket: Option<String>,
    threads: Arc<Mutex<Threads>>,
}

impl CodexSession {
    pub(super) fn new(home: Home, socket: Option<String>, threads: Arc<Mutex<Threads>>) -> Self {
        Self {
            home,
            socket,
            threads,
        }
    }

    /// One resume of `thread` for `agent`, with the config the agent was started with.
    async fn resume(
        &self,
        channel: &dyn ChannelPort,
        agent: &Bound,
        thread: &str,
    ) -> Result<Js, ChannelError> {
        let params = resume_params(self.socket.as_deref(), thread, &agent.launch);
        let result = channel.request("thread/resume", params).await?;
        Ok(Js::parse(result.to_string().as_bytes()).unwrap_or(Js::Null))
    }

    /// What a resume of a bound thread says of it now: a turn the last connection cut off was
    /// continued by the new server if the thread is busy again, and interrupted otherwise.
    fn resumed(&self, thread: &str, result: &Js) -> Vec<Keyed> {
        let value = result_activity(result);
        let mut t = lock(&self.threads);
        if t.cut_off.remove(thread) {
            let label = if value.is_some_and(busy) {
                AUTO_CONTINUED
            } else {
                INTERRUPTED
            };
            t.labels.insert(thread.to_owned(), label);
        }
        match value {
            Some(ActivityValue::Idle) if t.failed.contains(thread) => Vec::new(),
            Some(value) => vec![t.signal(thread, value, None)],
            None => Vec::new(),
        }
    }
}

fn untracked() -> Followed {
    Followed::Untracked {
        detail: UNTRACKED.to_owned(),
    }
}

impl Session for CodexSession {
    fn endpoint(&self) -> Endpoint {
        Endpoint {
            address: control_socket(&self.home.path),
            start: ["codex", "app-server", "daemon", "start"]
                .map(str::to_owned)
                .to_vec(),
        }
    }

    /// The thread a notification or a request names.
    fn route(&self, report: &Report<'_>) -> Option<SessionKey> {
        let (Report::Notification { params, .. } | Report::ServerRequest { params, .. }) = report
        else {
            return None;
        };
        let params = Js::parse(params)?;
        string(&params, "threadId").map(|thread| SessionKey(thread.to_owned()))
    }

    /// `initialize`, failing on a server for any Codex home but the agents', which the daemon backs
    /// off from and tries again, as the TypeScript daemon did. Each names the version doctor
    /// reports, none included.
    fn handshake<'a>(
        &'a mut self,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Result<Option<String>, ChannelError>> {
        Box::pin(async move {
            let params = json!({
                "clientInfo": { "name": "bazhen", "version": "0" },
                "capabilities": { "experimentalApi": true },
            });
            let answer = channel.request("initialize", params).await?;
            let answer = Js::parse(answer.to_string().as_bytes()).unwrap_or(Js::Null);
            let (Some(found), Some(user_agent)) =
                (string(&answer, "codexHome"), string(&answer, "userAgent"))
            else {
                return Err(ChannelError {
                    kind: ChannelErrorKind::Failed,
                    message: "initialize answered with no codexHome and userAgent".to_owned(),
                });
            };
            if resolved(&*self.home.real_path, found) != self.home.real {
                return Err(ChannelError {
                    kind: ChannelErrorKind::Failed,
                    message: format!("the app-server belongs to {found}, not {}", self.home.real),
                });
            }
            let version = server_version(user_agent);
            channel.notify("initialized", Value::Null).await?;
            lock(&self.threads).version.clone_from(&version);
            Ok(version)
        })
    }

    /// Only a client that started or resumed a thread hears its events and requests, and a thread
    /// with no client unloads, so every bound thread is resumed, one after another. Each says how
    /// it is as its resume answers, and those picked up say so last of all.
    fn connected<'a>(
        &'a mut self,
        channel: &'a dyn ChannelPort,
        bound: &'a [Bound],
    ) -> BoxFuture<'a, Vec<Keyed>> {
        Box::pin(async move {
            let mut out = Vec::new();
            let mut resumed = Vec::new();
            for agent in bound {
                let thread = &agent.session.id;
                if let Ok(result) = self.resume(channel, agent, thread).await {
                    out.extend(self.resumed(thread, &result));
                    resumed.push(on(thread, Observed::Resumed));
                }
            }
            out.extend(resumed);
            out
        })
    }

    fn reload<'a>(
        &'a mut self,
        agent: &'a Bound,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Reloaded> {
        Box::pin(async move {
            let thread = &agent.session.id;
            let Ok(result) = self.resume(channel, agent, thread).await else {
                return Reloaded::NotYet;
            };
            let facts = self.resumed(thread, &result);
            if result_not_loaded(&result) {
                Reloaded::NotYet
            } else {
                Reloaded::Loaded(facts)
            }
        })
    }

    /// A connection ends only when its server exits, and a turn running then ends with it. What
    /// the server held for the connection, its requests and each thread's state, went with it.
    fn disconnected(&mut self) -> Vec<Keyed> {
        let mut t = lock(&self.threads);
        let busy_then: Vec<String> = t
            .activity
            .iter()
            .filter(|(_, activity)| busy(**activity))
            .map(|(thread, _)| thread.clone())
            .collect();
        t.cut_off.extend(busy_then);
        t.activity.clear();
        t.failed.clear();
        t.first_item.clear();
        t.requests.clear();
        t.questions.clear();
        Vec::new()
    }

    /// Not yet: the next change follows an agent to the thread its title names.
    fn follow<'a>(
        &'a mut self,
        _agent: &'a Bound,
        _candidate: &'a str,
        _channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Followed> {
        Box::pin(std::future::ready(untracked()))
    }

    fn may_follow_to(&self, _candidate: &str, _announced: &SessionKey) -> bool {
        false
    }
}

#[cfg(test)]
mod tests;
