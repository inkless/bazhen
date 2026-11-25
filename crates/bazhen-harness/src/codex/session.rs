//! The daemon's one connection to Codex's app-server: the handshake that checks the server is the
//! user's Codex home's, every agent's thread picked up again on each connection, and an agent
//! followed to the thread its terminal's title names (foundation-design §5.8).

use super::launch::{control_socket, resume_params};
use super::signals::{busy, result_activity, result_not_loaded};
use super::threads::{js_space, matching, read_thread_list, title_prefix};
use super::wire::string;
use super::{AUTO_CONTINUED, INTERRUPTED, Threads, lock, on};
use crate::js::Js;
use crate::{
    AgentId, Bound, BoxFuture, ChannelError, ChannelErrorKind, ChannelPort, Endpoint, Followed,
    Keyed, Lookup, Observed, Reloaded, Session, SessionKey,
};
use bazhen_protocol::agents::{ActivityValue, ExternalRef, ExternalRefKind};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// The threads `thread/list` answers with in one page.
const LIST_PAGE: u64 = 50;
/// The most pages a move's first try reads, for a thread the TUI resumed from far back; its
/// retries read only the first, where a thread saved since sorts.
const LIST_PAGES: usize = 40;
/// Why an agent stays where it is when its title can't be followed to one thread.
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

/// A move an agent's title asked for that has bound no thread yet: the prefix the title named,
/// and the one thread it found but couldn't resume.
#[derive(Debug)]
pub(super) struct Move {
    prefix: String,
    thread: Option<String>,
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

    /// The threads the server lists in up to `pages` pages, newest first; those it listed before
    /// a request failed, if one does.
    async fn listed(channel: &dyn ChannelPort, pages: usize) -> Vec<String> {
        let mut threads = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..pages {
            let params = match cursor.take() {
                None => json!({ "limit": LIST_PAGE }),
                Some(cursor) => json!({ "limit": LIST_PAGE, "cursor": cursor }),
            };
            let Ok(answer) = channel.request("thread/list", params).await else {
                break;
            };
            let page = Js::parse(answer.to_string().as_bytes())
                .map_or_else(Default::default, |answer| read_thread_list(&answer));
            threads.extend(page.threads);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        threads
    }
}

fn untracked() -> Followed {
    Followed::Untracked {
        detail: UNTRACKED.to_owned(),
    }
}

fn owned(found: Vec<&str>) -> Vec<String> {
    found.into_iter().map(str::to_owned).collect()
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
            // An agent not bound any more isn't moving either.
            lock(&self.threads)
                .moves
                .retain(|moving, _| bound.iter().any(|b| &b.agent == moving));
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

    /// The thread a title names: one the server announced, the one an earlier try found, or one
    /// the server lists. Its first try reads many pages, for a thread resumed from far back, and a
    /// retry of the same title only the first, where a thread saved since sorts. The agent is
    /// bound once its new thread is resumed, so nothing the thread says after the move is missed.
    /// A blank title never comes here: ingest reads one as [`Observed::Release`].
    fn follow<'a>(
        &'a mut self,
        agent: &'a Bound,
        candidate: &'a str,
        channel: &'a dyn ChannelPort,
    ) -> BoxFuture<'a, Followed> {
        Box::pin(async move {
            let waited = lock(&self.threads).moves.remove(&agent.agent);
            let Some(prefix) = title_prefix(candidate) else {
                return untracked();
            };
            // Still the same thread, as after `/compact`, or back on it.
            if agent.session.id.starts_with(prefix) {
                return Followed::Bound(agent.session.clone());
            }
            let waited = waited.filter(|m| m.prefix == prefix);
            let mut found = owned(matching(
                prefix,
                lock(&self.threads).seen.iter().map(String::as_str),
            ));
            if found.is_empty() {
                found.extend(waited.as_ref().and_then(|m| m.thread.clone()));
            }
            if found.is_empty() {
                let pages = if waited.is_none() { LIST_PAGES } else { 1 };
                let listed = Self::listed(channel, pages).await;
                found = owned(matching(prefix, listed.iter().map(String::as_str)));
            }
            let thread = match found.as_slice() {
                [] => None,
                [thread] => Some(thread.clone()),
                _ => return untracked(),
            };
            if let Some(thread) = &thread
                && self.resume(channel, agent, thread).await.is_ok()
            {
                return Followed::Bound(ExternalRef {
                    environment_id: agent.session.environment_id.clone(),
                    kind: ExternalRefKind::CodexThread,
                    id: thread.clone(),
                });
            }
            let prefix = prefix.to_owned();
            lock(&self.threads)
                .moves
                .insert(agent.agent.clone(), Move { prefix, thread });
            Followed::Pending
        })
    }

    fn may_follow_to(&self, candidate: &str, announced: &SessionKey) -> bool {
        title_prefix(candidate).is_some_and(|prefix| announced.0.starts_with(prefix))
    }

    fn settled(&mut self, agent: &AgentId) {
        lock(&self.threads).moves.remove(agent);
    }
}

#[cfg(test)]
mod tests;
