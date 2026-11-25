//! Agents: each a harness's TUI in a terminal of its own, which the daemon launches
//! (`agents/launch.ts`). The daemon mints every id and records the launch before anything starts
//! (foundation-design §8.1), and the request's key makes a retry answer as the first did instead
//! of launching twice (§5.1).

pub(crate) mod lifecycle;
pub(crate) mod prompts;
pub(crate) mod reconcile;
pub(crate) mod restart;
pub(crate) mod transcript;
pub(crate) mod view;
pub(crate) mod watch;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use bazhen_harness::{Harness, Harnesses, LaunchRequest, LaunchSpec};
use bazhen_protocol::agent_events::{AgentFailed, AgentFailedReason, AgentLaunched, AgentRunning};
use bazhen_protocol::agents::{
    ExternalRef, ExternalRefKind, HarnessId, LaunchAgentRequest, LaunchAgentResponse,
};
use bazhen_protocol::events::RuntimeRefPayload;
use bazhen_protocol::ids::{AgentId, EnvironmentId, TerminalId};
use bazhen_protocol::names::Role;
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;
use bazhen_store::{AgentChange, AppendError, NewEvent, OnceError, Writer as StoreWriter};
use serde::{Deserialize, Serialize};
use tokio_util::task::TaskTracker;

use self::prompts::{Composed, FLEET, Prompts, compose};
use crate::budget::{Budget, Counts, TerminalLimit};
use crate::failure::failure_detail;
use crate::pairing::random_bytes;
use crate::roles::Roles;
use crate::shells::{RUNTIME, ShellError, resolve_directory};
use crate::terminals::{Kind, NewTerminal, Terminals};
use crate::tokens::AgentTokens;
use crate::turns::Turns;
use crate::writer::Writer;

/// Why a command on an agent did nothing, in the kinds its answer tells apart.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum AgentError {
    /// The request breaks a rule, names a directory that isn't one, or a role none defines.
    #[error("{0}")]
    Invalid(String),
    /// This environment runs no such harness.
    #[error("{0}")]
    Unsupported(String),
    #[error(transparent)]
    Limit(#[from] TerminalLimit),
    #[error("idempotency key {0} was first used for a different request")]
    Idempotency(String),
    /// Another live agent holds the name asked for.
    #[error("another agent is named {0}; close it or pick another name")]
    NameTaken(String),
    /// The agent is recorded failed; `why` carries no secret.
    #[error("agent {agent} failed to launch: {why}")]
    LaunchFailed { agent: String, why: String },
    #[error("no agent {0}")]
    Unknown(String),
    /// Its state doesn't allow the command, or its terminal isn't the one recorded.
    #[error("{0}")]
    Conflict(String),
    #[error("agent {id} is at generation {}", generation.map_or_else(|| "null".to_owned(), |g| g.to_string()))]
    Stale { id: String, generation: Option<u64> },
    /// The agent has no harness session that starting it again could resume, or its harness
    /// can't resume the one it has.
    #[error("{0}")]
    NotResumable(String),
    /// The session it would resume is another agent's too, for a harness whose sessions are one
    /// agent's at a time; answered as not resumable.
    #[error("{0}")]
    SessionTaken(String),
    #[error("{0}")]
    ServerUnconfirmed(String),
    #[error("{0}")]
    NeedsRestart(String),
    /// The daemon can't do it as it runs now, or the environment couldn't just now.
    #[error("{0}")]
    Unavailable(String),
    /// A step on the agent's linked shells, answered as the shells' own.
    #[error(transparent)]
    Shells(ShellError),
    /// A failure no command expects, which is the daemon's.
    #[error("{0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AgentError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<AppendError> for AgentError {
    fn from(err: AppendError) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<OnceError> for AgentError {
    fn from(err: OnceError) -> Self {
        match err {
            OnceError::Conflict(key) => Self::Idempotency(key),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl From<crate::writer::Closed> for AgentError {
    fn from(err: crate::writer::Closed) -> Self {
        Self::Internal(err.to_string())
    }
}

/// A directory's refusal, as a launch answers it.
impl From<ShellError> for AgentError {
    fn from(err: ShellError) -> Self {
        match err {
            ShellError::Invalid(message) => Self::Invalid(message),
            other => Self::Internal(other.to_string()),
        }
    }
}

/// Why no agent can be launched while no hook client is built: agents report through it.
pub(crate) const NO_HOOK: &str = "this daemon can't launch agents: bazhen-hook, which they report through, isn't built. Build it with moon run :build-hook, then start the daemon again";

/// The request as a launch key keeps it: as it was asked, before its directory was resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Asked {
    harness: HarnessId,
    cwd: String,
    project: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

/// What a launch key remembers: the request, and how that launch ended.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LaunchRecord {
    request: Asked,
    response: LaunchAgentResponse,
    failed: bool,
}

/// The last part of `path`, as Node's `basename` gives it: a trailing slash is no part.
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// `argv` started through `shell` as a login shell, re-reading the user's rc as a new terminal
/// tab does (`loginArgv` in `env-local`): fish takes its arguments as `$argv`, any other shell
/// as `"$@"`.
fn login_argv(shell: &str, argv: Vec<String>) -> Vec<String> {
    let fish = Path::new(shell)
        .file_name()
        .is_some_and(|name| name == "fish");
    let head: &[&str] = if fish {
        &["-l", "-i", "-c", "exec $argv"]
    } else {
        &["-l", "-i", "-c", "exec \"$@\"", "sh"]
    };
    std::iter::once(shell.to_owned())
        .chain(head.iter().map(|&arg| arg.to_owned()))
        .chain(argv)
        .collect()
}

/// A harness session as its terminal carries it, in the order `JSON.stringify` writes it there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionTag<'a> {
    kind: ExternalRefKind,
    id: &'a str,
    environment_id: &'a EnvironmentId,
}

fn session_tag(session: &ExternalRef) -> Result<String, AgentError> {
    serde_json::to_string(&SessionTag {
        kind: session.kind,
        id: &session.id,
        environment_id: &session.environment_id,
    })
    .map_err(|err| AgentError::Internal(err.to_string()))
}

fn now_ms() -> u64 {
    u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0)
}

fn minted<K: bazhen_protocol::ids::Kind>() -> Result<bazhen_protocol::ids::Id<K>, AgentError> {
    let random = random_bytes::<16>()
        .map_err(|err| AgentError::Internal(format!("no id can be made: {err}")))?;
    Ok(bazhen_protocol::ids::Id::mint(now_ms(), random))
}

/// The first answer `key` got, if any: the same response, or the same failure. A launch the
/// daemon died in the middle of is settled after the key was answered, so whether it failed is
/// read from the agent as well.
fn replayed(
    w: &StoreWriter<'_>,
    key: &str,
    asked: &Asked,
) -> Result<Option<LaunchAgentResponse>, AgentError> {
    let Some(prior) = w.recall(key)? else {
        return Ok(None);
    };
    let prior: LaunchRecord = serde_json::from_value(prior)
        .map_err(|err| AgentError::Internal(format!("launch key {key} holds no launch: {err}")))?;
    if prior.request != *asked {
        return Err(AgentError::Idempotency(key.to_owned()));
    }
    let agent = prior.response.agent_id.as_str();
    let reads = w.reads();
    if prior.failed || reads.agent_state(agent)?.as_deref() == Some("failed") {
        let why = reads.agent_failure_detail(agent)?.map_or_else(
            || "an earlier attempt failed".to_owned(),
            |detail| format!("an earlier attempt failed: {detail}"),
        );
        return Err(AgentError::LaunchFailed {
            agent: agent.to_owned(),
            why,
        });
    }
    Ok(Some(prior.response))
}

/// What an agent's launch needs.
#[derive(Debug)]
pub(crate) struct AgentsDeps {
    pub(crate) store: Writer,
    pub(crate) terminals: Arc<dyn Terminals>,
    pub(crate) budget: Arc<Budget>,
    /// The daemon user's home, which a launch directory's leading `~` names.
    pub(crate) home: String,
    /// The daemon's socket, handed to every agent as `BAZHEN_SOCKET`.
    pub(crate) socket: String,
    /// The daemon's tasks, which every command runs on to its end.
    pub(crate) tracker: TaskTracker,
    pub(crate) roles: Arc<Roles>,
    pub(crate) harnesses: Harnesses,
    /// Whether a hook client is built, which every agent reports through.
    pub(crate) hook_built: bool,
    pub(crate) tokens: AgentTokens,
    pub(crate) prompts: Prompts,
    /// With `agents.shell = "login"`, the shell every agent starts through.
    pub(crate) login_shell: Option<String>,
    /// Commands on agents and shells, one at a time by what each acts on, shared with the
    /// shells: a linked shell opens in its agent's turn.
    pub(crate) turns: Arc<Turns>,
    /// What the agents' hooks keep between requests, which the routes take as theirs: a closed
    /// agent's waiter is answered here, whatever closed it.
    pub(crate) hooks: Arc<crate::hooks::Hooks>,
}

/// What a launch records of itself before anything starts.
struct Recording {
    agent: AgentId,
    terminal: TerminalId,
    harness: HarnessId,
    project: String,
    /// As resolved.
    cwd: String,
    role: Option<Role>,
    prompt_hash: String,
    compact_window_tokens: Option<u32>,
}

/// What a recorded launch goes on to start with.
struct Launching<'a> {
    harness: &'a dyn Harness,
    agent: AgentId,
    terminal: TerminalId,
    environment: EnvironmentId,
    cwd: String,
    name: String,
    prompt: Composed,
    prompt_file: String,
    theme: Option<TuiTheme>,
    compact_window_tokens: Option<u32>,
}

/// What a start gave: where its terminal runs, its harness session, and the theme it drew for.
struct Started {
    locator: Record<String>,
    external_ref: Option<ExternalRef>,
    theme: Option<TuiTheme>,
}

/// The agents this daemon launches.
#[derive(Debug)]
pub(crate) struct Agents {
    deps: AgentsDeps,
    /// When this daemon started: nothing it didn't start could start a terminal after it.
    started: std::time::Instant,
    /// When each create this daemon asked for and saw refused returned: nothing starts the
    /// terminal after it, though a holder it spawned may yet answer.
    refused: std::sync::Mutex<HashMap<TerminalId, std::time::Instant>>,
    unreconciled: std::sync::Mutex<reconcile::Unreconciled>,
}

impl Agents {
    pub(crate) fn new(deps: AgentsDeps) -> Self {
        Self {
            deps,
            started: std::time::Instant::now(),
            refused: std::sync::Mutex::default(),
            unreconciled: std::sync::Mutex::default(),
        }
    }

    /// Runs `command` to its end on the daemon's tasks, whether or not its caller waits for the
    /// answer, as the TypeScript daemon's promise runs on: a client gone mid-launch would
    /// otherwise leave an agent recorded launched and never started.
    pub(crate) async fn completing<T, F>(
        self: &Arc<Self>,
        command: impl FnOnce(Arc<Self>) -> F,
    ) -> Result<T, AgentError>
    where
        F: Future<Output = Result<T, AgentError>> + Send + 'static,
        T: Send + 'static,
    {
        self.deps
            .tracker
            .spawn(command(Arc::clone(self)))
            .await
            .map_err(|err| AgentError::Internal(format!("an agent's command ended early: {err}")))?
    }

    /// Runs `work` on the agents' tracker, which the daemon drains before it stops.
    pub(crate) fn spawn(
        &self,
        work: impl Future<Output = ()> + Send + 'static,
    ) -> tokio::task::JoinHandle<()> {
        self.deps.tracker.spawn(work)
    }

    async fn write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&StoreWriter<'_>) -> Result<T, AgentError> + Send + 'static,
    ) -> Result<T, AgentError> {
        self.deps.store.run(move |store| store.write(job)).await?
    }

    /// What the state's agents are described with now: the harnesses served, and the roles in
    /// force as they read at this call.
    pub(crate) fn view(self: &Arc<Self>) -> view::AgentsView {
        view::AgentsView::new(Arc::clone(self), self.deps.roles.current())
    }

    /// The turns its commands take, which the shells share.
    #[cfg(test)]
    pub(crate) fn turns(&self) -> &Arc<crate::turns::Turns> {
        &self.deps.turns
    }

    pub(crate) fn harnesses(&self) -> &Harnesses {
        &self.deps.harnesses
    }

    /// Launches one agent. A repeat of the key while the launch is in flight gets the answer so
    /// far.
    pub(crate) async fn launch(
        &self,
        req: &LaunchAgentRequest,
    ) -> Result<LaunchAgentResponse, AgentError> {
        let asked = Asked {
            harness: req.harness,
            cwd: req.cwd.clone(),
            project: req
                .project
                .clone()
                .unwrap_or_else(|| basename(&req.cwd).to_owned()),
            name: req.name.as_ref().map(|name| name.as_str().to_owned()),
            role: req.role.as_ref().map(|role| role.as_str().to_owned()),
        };
        let key = req.idempotency_key.clone();
        // A retry gets the first answer, whatever has happened to the directory since.
        let (k, a) = (key.clone(), asked.clone());
        if let Some(prior) = self.write(move |w| replayed(w, &k, &a)).await? {
            return Ok(prior);
        }
        if !self.deps.hook_built {
            return Err(AgentError::Unavailable(NO_HOOK.to_owned()));
        }
        let harness = self.deps.harnesses.get(req.harness).ok_or_else(|| {
            AgentError::Unsupported(format!(
                "this environment cannot run {}",
                req.harness.as_str()
            ))
        })?;
        let roles = self.deps.roles.current();
        if let Some(role) = &req.role
            && roles.book.get(role).is_none()
        {
            return Err(AgentError::Invalid(format!(
                "no role is defined as {}: bazhen roles lists them",
                role.as_str()
            )));
        }
        let cwd = resolve_directory(&req.cwd, &self.deps.home)?;
        let project = req
            .project
            .clone()
            .unwrap_or_else(|| basename(&cwd).to_owned());
        let agent: AgentId = minted()?;
        let terminal: TerminalId = minted()?;
        // Written before the launch is recorded, so a write that fails records nothing.
        let prompt = compose(FLEET, &roles.book, req.role.as_ref());
        let prompt_file = self
            .deps
            .prompts
            .write(&agent, &prompt.text)
            .map_err(|err| {
                AgentError::Internal(format!("agent {agent}'s prompt can't be written: {err}"))
            })?
            .to_string_lossy()
            .into_owned();
        // Taken before the agent is recorded, so nothing else settles it while it starts.
        let _turn = self.deps.turns.take(agent.as_str()).await;
        let recording = Recording {
            agent: agent.clone(),
            terminal: terminal.clone(),
            harness: req.harness,
            project,
            cwd: cwd.clone(),
            role: req.role.clone(),
            prompt_hash: prompt.hash.clone(),
            compact_window_tokens: req.compact_window_tokens,
        };
        let recorded = self.record_launch(&key, asked.clone(), recording).await;
        let (launched, name, environment) = match recorded {
            Ok(Ok(recorded)) => recorded,
            Ok(Err(prior)) => {
                self.deps.prompts.remove(&agent);
                return Ok(prior);
            }
            Err(err) => {
                self.deps.prompts.remove(&agent);
                return Err(err);
            }
        };
        let launching = Launching {
            harness,
            agent,
            terminal,
            environment,
            cwd,
            name,
            prompt,
            prompt_file,
            theme: req.theme,
            compact_window_tokens: req.compact_window_tokens,
        };
        self.settle_start(&key, asked, launched, launching).await
    }

    /// Starts what `launched` recorded, and records how it went, answering the key with it.
    async fn settle_start(
        &self,
        key: &str,
        asked: Asked,
        launched: LaunchAgentResponse,
        launching: Launching<'_>,
    ) -> Result<LaunchAgentResponse, AgentError> {
        let agent = launching.agent.clone();
        let name = launching.name.clone();
        match self.start(launching).await {
            Ok(started) => self.running(key, asked, launched, &name, started).await,
            Err(cause) => {
                tracing::error!("bazhen: agent {agent} failed to launch: {cause}");
                self.deps.prompts.remove(&agent);
                let detail = failure_detail(&cause);
                self.failed(key, asked, launched, &detail).await?;
                Err(AgentError::LaunchFailed {
                    agent: agent.as_str().to_owned(),
                    why: detail,
                })
            }
        }
    }

    /// Records the launch, its name chosen and the budget's slot taken, and the key's answer, in
    /// one transaction: a repeat sees exactly what has been done so far, and two launches can't
    /// take one name. A launch the key already answered, meanwhile, is that answer.
    async fn record_launch(
        &self,
        key: &str,
        asked: Asked,
        launch: Recording,
    ) -> Result<Result<(LaunchAgentResponse, String, EnvironmentId), LaunchAgentResponse>, AgentError>
    {
        let budget = Arc::clone(&self.deps.budget);
        let key = key.to_owned();
        self.write(move |w| {
            // Under the same transaction as the record, so two launches with one key make one.
            if let Some(prior) = replayed(w, &key, &asked)? {
                return Ok(Err(prior));
            }
            let reads = w.reads();
            let (name, name_ordinal) = match &asked.name {
                None => {
                    let (name, ordinal) = reads.next_default_name(&launch.project)?;
                    (name, Some(ordinal))
                }
                Some(name) if reads.live_agent_named(name)?.is_some() => {
                    return Err(AgentError::NameTaken(name.clone()));
                }
                Some(name) => (name.clone(), None),
            };
            budget.admit(Counts {
                open: reads.open_terminals()?,
                starting: reads.starting_terminals()?,
            })?;
            let environment = w.local_environment()?;
            let id = w.append(&NewEvent::Agent {
                agent: launch.agent.clone(),
                actor: "system".to_owned(),
                change: AgentChange::Launched(AgentLaunched {
                    environment_id: environment.clone(),
                    harness: launch.harness,
                    project: launch.project,
                    cwd: launch.cwd,
                    terminal_id: Some(launch.terminal.clone()),
                    launched_by: None,
                    name: Some(name.clone()),
                    name_ordinal,
                    runtime: Some(RUNTIME.to_owned()),
                    role: launch.role,
                    prompt_hash: Some(launch.prompt_hash),
                    compact_window_tokens: launch.compact_window_tokens,
                }),
            })?;
            let response = LaunchAgentResponse {
                agent_id: launch.agent,
                terminal_id: Some(launch.terminal),
                event_ids: vec![id],
            };
            w.remember(
                &key,
                &LaunchRecord {
                    request: asked,
                    response: response.clone(),
                    failed: false,
                },
            )?;
            Ok(Ok((response, name, environment)))
        })
        .await
    }

    /// Starts the agent's harness in its terminal, with a token of this start's own, which is
    /// kept if it starts and abandoned if not. A token that can't be written fails the launch as
    /// the runtime refusing it would. The error is the failure's own text.
    async fn start(&self, launching: Launching<'_>) -> Result<Started, String> {
        let Launching {
            harness,
            agent,
            terminal,
            environment,
            cwd,
            name,
            prompt,
            prompt_file,
            theme,
            compact_window_tokens,
        } = launching;
        let token = self
            .deps
            .tokens
            .mint(&agent)
            .await
            .map_err(|err| err.to_string())?;
        let request = LaunchRequest {
            cwd: cwd.clone(),
            theme,
            instructions: Some(prompt.text),
            instructions_file: Some(prompt_file),
            // Its first start: there is no prompt before it to differ from.
            instructions_changed: false,
            name: (!name.is_empty()).then_some(name),
            compact_window_tokens: compact_window_tokens.map(u64::from),
        };
        let spec = match harness.launch(&request, None).await {
            Ok(spec) => spec,
            Err(err) => {
                token.abandoned().await;
                return Err(err.to_string());
            }
        };
        let LaunchSpec {
            argv,
            env,
            theme,
            session,
        } = spec;
        let external_ref = session.map(|session| ExternalRef {
            environment_id: environment,
            kind: session.kind,
            id: session.id,
        });
        let harness_session = external_ref
            .as_ref()
            .map(session_tag)
            .transpose()
            .map_err(|err| err.to_string());
        let harness_session = match harness_session {
            Ok(tag) => tag,
            Err(err) => {
                token.abandoned().await;
                return Err(err);
            }
        };
        let (argv, env) = self.process_of(&agent, &token.file, argv, env);
        let spec = NewTerminal {
            terminal_id: terminal.clone(),
            kind: Kind::Agent {
                agent_id: agent,
                harness_session,
            },
            argv,
            cwd,
            env,
            theme,
            generation: 0,
        };
        match self.deps.terminals.create(spec).await {
            Ok(locator) => {
                token.kept().await;
                Ok(Started {
                    locator,
                    external_ref,
                    theme,
                })
            }
            Err(err) => {
                self.refused(terminal);
                token.abandoned().await;
                Err(err.to_string())
            }
        }
    }

    /// What the agents' hooks keep between requests: a closed agent's waiter is answered there.
    #[cfg(test)]
    pub(crate) fn hooks(&self) -> &Arc<crate::hooks::Hooks> {
        &self.deps.hooks
    }

    /// Notes that the create of `terminal` returned refused, now.
    fn refused(&self, terminal: TerminalId) {
        self.refused
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(terminal, std::time::Instant::now());
    }

    /// A moment after which nothing could start `terminal`: when its create returned refused, or
    /// else when this daemon started, for one a daemon before it asked for.
    fn unstartable_since(&self, terminal: &TerminalId) -> std::time::Instant {
        self.refused
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(terminal)
            .copied()
            .unwrap_or(self.started)
    }

    /// The argv and variables an agent's process starts with, each start: its harness's, with
    /// the daemon's own for it, through the login shell where one is set.
    fn process_of(
        &self,
        agent: &AgentId,
        token_file: &Path,
        argv: Vec<String>,
        env: Vec<(String, String)>,
    ) -> (Vec<String>, BTreeMap<String, String>) {
        let mut vars: BTreeMap<String, String> = env.into_iter().collect();
        vars.insert("BAZHEN_AGENT_ID".to_owned(), agent.as_str().to_owned());
        // Not named for its token: Codex's default shell environment policy strips every
        // variable whose name holds KEY, SECRET or TOKEN from the commands an agent runs.
        vars.insert(
            "BAZHEN_AGENT_AUTH_FILE".to_owned(),
            token_file.to_string_lossy().into_owned(),
        );
        vars.insert("BAZHEN_SOCKET".to_owned(), self.deps.socket.clone());
        let argv = match &self.deps.login_shell {
            Some(shell) => login_argv(shell, argv),
            None => argv,
        };
        (argv, vars)
    }

    /// Records the agent running on its terminal, and the key's answer with it.
    async fn running(
        &self,
        key: &str,
        asked: Asked,
        launched: LaunchAgentResponse,
        name: &str,
        started: Started,
    ) -> Result<LaunchAgentResponse, AgentError> {
        let change = AgentChange::Running(AgentRunning {
            external_ref: started.external_ref,
            runtime_ref: Some(RuntimeRefPayload {
                runtime: RUNTIME.to_owned(),
                locator: started.locator,
            }),
            theme: started.theme,
            // What its harness was started as, which a rename doesn't reach.
            harness_name: (!name.is_empty()).then(|| name.to_owned()),
        });
        self.settle(key, asked, launched, change, false).await
    }

    /// Records the launch failed, saying why, and the key's answer with it.
    async fn failed(
        &self,
        key: &str,
        asked: Asked,
        launched: LaunchAgentResponse,
        detail: &str,
    ) -> Result<LaunchAgentResponse, AgentError> {
        let change = AgentChange::Failed(AgentFailed {
            reason: AgentFailedReason::LaunchRejected,
            detail: Some(detail.to_owned()),
        });
        self.settle(key, asked, launched, change, true).await
    }

    async fn settle(
        &self,
        key: &str,
        asked: Asked,
        launched: LaunchAgentResponse,
        change: AgentChange,
        failed: bool,
    ) -> Result<LaunchAgentResponse, AgentError> {
        let key = key.to_owned();
        self.write(move |w| {
            let id = w.append(&NewEvent::Agent {
                agent: launched.agent_id.clone(),
                actor: "system".to_owned(),
                change,
            })?;
            let mut response = launched;
            response.event_ids.push(id);
            w.remember(
                &key,
                &LaunchRecord {
                    request: asked,
                    response: response.clone(),
                    failed,
                },
            )?;
            Ok(response)
        })
        .await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;

    use bazhen_harness::{Delivery, LaunchError};
    use bazhen_protocol::names::AgentName;

    use super::*;
    use crate::budget::tests::{Machine, roomy};
    use crate::terminals::fake::Fake;
    use crate::testing::stub_harness::{
        STUB_ARGV, STUB_SESSION, StubHarness, production_for_test, pull,
    };
    use crate::testing::{TempDir, runtime};

    /// Agents on a fake runtime, over a store of their own, whose user's home holds `repo`.
    pub(crate) struct Fixture {
        pub(crate) agents: Arc<Agents>,
        fake: Fake,
        pub(crate) store: Writer,
        home: String,
        run: PathBuf,
        _dir: TempDir,
        thread: Option<crate::writer::Thread>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.finish();
            }
        }
    }

    pub(crate) struct Setup {
        pub(crate) harnesses: Harnesses,
        pub(crate) hook_built: bool,
        pub(crate) max: u64,
        pub(crate) login_shell: Option<String>,
    }

    impl Default for Setup {
        fn default() -> Self {
            Self {
                harnesses: StubHarness::new(pull()).served_as(HarnessId::ClaudeCode),
                hook_built: true,
                max: 100,
                login_shell: None,
            }
        }
    }

    pub(crate) fn setup_with(setup: Setup) -> Fixture {
        let dir = TempDir::new("agents");
        let path = dir.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join("repo")).unwrap();
        let home = home.to_string_lossy().into_owned();
        let run = dir.path().join("run");
        let fake = Fake::default();
        let budget = Budget::new(
            setup.max,
            Arc::new(Machine(StdMutex::new(roomy()))),
            Box::new(|_| {}),
        );
        let uid = rustix::process::getuid().as_raw();
        let hooks = Arc::new(crate::hooks::Hooks::default());
        let agents = Agents::new(AgentsDeps {
            store: store.clone(),
            terminals: Arc::new(fake.clone()),
            budget: Arc::new(budget),
            home: home.clone(),
            socket: "/run/b.sock".to_owned(),
            tracker: TaskTracker::new(),
            roles: Arc::new(Roles::new(None)),
            harnesses: setup.harnesses,
            hook_built: setup.hook_built,
            tokens: AgentTokens::new(run.join("agents"), uid, store.clone()),
            prompts: prompts::daemon_prompts(&run, uid),
            login_shell: setup.login_shell,
            turns: Arc::default(),
            hooks: Arc::clone(&hooks),
        });
        Fixture {
            agents: Arc::new(agents),
            fake,
            store,
            home,
            run,
            _dir: dir,
            thread: Some(thread),
        }
    }

    fn setup() -> Fixture {
        setup_with(Setup::default())
    }

    /// The stub `setup` serves, with what it was asked.
    pub(crate) fn stubbed(stub: &StubHarness) -> Fixture {
        setup_with(Setup {
            harnesses: stub.served_as(HarnessId::ClaudeCode),
            ..Setup::default()
        })
    }

    pub(crate) fn request(key: &str) -> LaunchAgentRequest {
        LaunchAgentRequest {
            idempotency_key: key.to_owned(),
            harness: HarnessId::ClaudeCode,
            cwd: "~/repo".to_owned(),
            project: None,
            theme: None,
            name: None,
            role: None,
            compact_window_tokens: None,
        }
    }

    fn named(key: &str, name: &str) -> LaunchAgentRequest {
        LaunchAgentRequest {
            name: Some(AgentName::parse(name).unwrap()),
            ..request(key)
        }
    }

    impl Fixture {
        pub(crate) async fn launch(
            &self,
            req: LaunchAgentRequest,
        ) -> Result<LaunchAgentResponse, AgentError> {
            self.agents.launch(&req).await
        }

        /// The agent's current terminal.
        pub(crate) fn terminal_of(&self, agent: &str) -> String {
            self.store
                .reader()
                .unwrap()
                .reads()
                .agent_terminal(agent)
                .unwrap()
                .and_then(|found| found.terminal_id)
                .unwrap()
                .as_str()
                .to_owned()
        }

        /// Shells on the agents' own runtime, store, budget and turns, as serve.rs builds them.
        pub(crate) fn shells(&self) -> Arc<crate::shells::Shells> {
            Arc::new(crate::shells::Shells::new(crate::shells::ShellsDeps {
                turns: Arc::clone(&self.agents.deps.turns),
                store: self.store.clone(),
                terminals: Arc::new(self.fake.clone()),
                budget: Arc::clone(&self.agents.deps.budget),
                home: self.home.clone(),
                shell: "/bin/zsh".to_owned(),
                socket: "/run/b.sock".to_owned(),
                tracker: TaskTracker::new(),
                stop: tokio_util::sync::CancellationToken::new(),
                integration: None,
            }))
        }

        /// Agents over the same store, runtime, token files and hooks, as a daemon started again
        /// builds them: no command's turn held, and nothing a start remembered.
        pub(crate) fn restarted(&self) -> Arc<Agents> {
            let deps = &self.agents.deps;
            Arc::new(Agents::new(AgentsDeps {
                store: deps.store.clone(),
                terminals: Arc::clone(&deps.terminals),
                budget: Arc::clone(&deps.budget),
                home: deps.home.clone(),
                socket: deps.socket.clone(),
                tracker: TaskTracker::new(),
                roles: Arc::clone(&deps.roles),
                harnesses: Harnesses::new(Vec::new()),
                hook_built: deps.hook_built,
                tokens: deps.tokens.clone(),
                prompts: deps.prompts.clone(),
                login_shell: None,
                turns: Arc::default(),
                hooks: Arc::clone(&deps.hooks),
            }))
        }

        /// The fake runtime the agents run on.
        pub(crate) fn fake(&self) -> &Fake {
            &self.fake
        }

        /// The token files the agents' starts left.
        pub(crate) fn token_files(&self) -> Vec<String> {
            std::fs::read_dir(self.run.join("agents")).map_or_else(
                |_| Vec::new(),
                |dir| {
                    dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                        .collect()
                },
            )
        }

        /// The signals the runtime was asked to send, in order.
        pub(crate) fn fake_signalled(&self) -> Vec<(String, bazhen_protocol::agents::Signal)> {
            let mut signalled = Vec::new();
            self.fake
                .set(|state| signalled.clone_from(&state.signalled));
            signalled
        }

        /// The terminal's process ends, told to no one.
        pub(crate) fn fake_exit_unseen(&self, terminal: &str) {
            self.fake.exit_unseen(terminal);
        }

        /// Each event recorded, as its type and payload, oldest first.
        fn events(&self) -> Vec<(String, serde_json::Value)> {
            let reader = self.store.reader().unwrap();
            let events = reader.reads().events(0, 1000).unwrap();
            events
                .into_iter()
                .map(|e| (e.kind, serde_json::from_str(&e.payload).unwrap()))
                .collect()
        }

        pub(crate) fn types(&self) -> Vec<String> {
            self.events().into_iter().map(|(kind, _)| kind).collect()
        }

        /// The payload of the last event of `kind`.
        pub(crate) fn last(&self, kind: &str) -> serde_json::Value {
            self.last_of(kind).unwrap()
        }

        /// The payload of the last event of `kind`, where one was recorded.
        pub(crate) fn last_of(&self, kind: &str) -> Option<serde_json::Value> {
            self.events()
                .into_iter()
                .rev()
                .find(|(k, _)| k == kind)
                .map(|(_, payload)| payload)
        }

        fn state(&self, agent: &AgentId) -> Option<String> {
            let reader = self.store.reader().unwrap();
            reader.reads().agent_state(agent.as_str()).unwrap()
        }

        fn spec(&self, answer: &LaunchAgentResponse) -> NewTerminal {
            self.fake
                .spec_of(answer.terminal_id.as_ref().unwrap().as_str())
        }

        pub(crate) fn prompts(&self) -> Vec<String> {
            std::fs::read_dir(self.run.join("prompts")).map_or_else(
                |_| Vec::new(),
                |dir| {
                    dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                        .collect()
                },
            )
        }
    }

    #[test]
    fn names_each_agent_its_projects_next_number_and_starts_its_harness_under_that_name() {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        runtime().block_on(async {
            f.launch(request("k-1")).await.unwrap();
            f.launch(request("k-2")).await.unwrap();
        });
        let launched: Vec<_> = f
            .events()
            .into_iter()
            .filter(|(kind, _)| kind == "agent.launched")
            .map(|(_, p)| (p["name"].clone(), p["nameOrdinal"].clone()))
            .collect();
        let started: Vec<_> = stub
            .launches
            .lock()
            .unwrap()
            .iter()
            .map(|l| l.name.clone())
            .collect();
        assert_eq!(
            launched,
            [
                (serde_json::json!("repo-1"), serde_json::json!(1)),
                (serde_json::json!("repo-2"), serde_json::json!(2))
            ]
        );
        assert_eq!(
            started,
            [Some("repo-1".to_owned()), Some("repo-2".to_owned())]
        );
    }

    #[test]
    fn launches_under_the_name_asked_for_and_refuses_one_a_live_agent_holds_recording_nothing() {
        let f = setup();
        runtime().block_on(async {
            f.launch(named("k-1", "lead")).await.unwrap();
            let before = f.events().len();
            let taken = f.launch(named("k-2", "LEAD")).await;
            assert_eq!(
                taken.map_err(|e| e.to_string()),
                Err("another agent is named LEAD; close it or pick another name".to_owned())
            );
            assert_eq!(f.events().len(), before);
        });
        let launched = f.last("agent.launched");
        assert_eq!(
            (&launched["name"], launched.get("nameOrdinal")),
            (&serde_json::json!("lead"), None)
        );
        assert_eq!(f.prompts().len(), 1);
    }

    #[test]
    fn refuses_a_repeat_of_a_launchs_key_naming_another_name_or_role() {
        let f = setup();
        runtime().block_on(async {
            f.launch(named("k-1", "lead")).await.unwrap();
            let renamed = f.launch(named("k-1", "worker")).await;
            let roled = f
                .launch(LaunchAgentRequest {
                    role: Some(Role::worker()),
                    ..named("k-1", "lead")
                })
                .await;
            let conflict = Err(AgentError::Idempotency("k-1".to_owned()));
            assert_eq!([renamed, roled], [conflict.clone(), conflict]);
        });
    }

    #[test]
    fn records_the_agent_before_starting_it_then_its_terminal_on_its_harness_session_still_starting()
     {
        let f = setup();
        let answer = runtime().block_on(f.launch(request("k-1"))).unwrap();
        assert_eq!(
            f.types(),
            ["environment.registered", "agent.launched", "agent.running"]
        );
        assert_eq!(answer.event_ids.len(), 2);
        assert_eq!(f.state(&answer.agent_id).as_deref(), Some("starting"));
        let launched = f.last("agent.launched");
        let environment = launched["environmentId"].as_str().unwrap().to_owned();
        assert_eq!(
            [
                &launched["project"],
                &launched["cwd"],
                &launched["terminalId"],
                &launched["runtime"],
            ],
            [
                &serde_json::json!("repo"),
                &serde_json::json!(format!("{}/repo", f.home)),
                &serde_json::json!(answer.terminal_id.as_ref().unwrap().as_str()),
                &serde_json::json!("holder"),
            ]
        );
        let running = f.last("agent.running");
        assert_eq!(
            running["externalRef"],
            serde_json::json!({
                "environmentId": environment, "kind": "claude-session", "id": STUB_SESSION
            })
        );
        assert_eq!(running["runtimeRef"]["runtime"], "holder");
        assert_eq!(running["harnessName"], "repo-1");
        let spec = f.spec(&answer);
        assert_eq!(
            spec.kind,
            Kind::Agent {
                agent_id: answer.agent_id.clone(),
                harness_session: Some(format!(
                    r#"{{"kind":"claude-session","id":"{STUB_SESSION}","environmentId":"{environment}"}}"#
                )),
            }
        );
    }

    #[test]
    fn starts_the_harnesss_tui_with_bazhens_variables_beside_its_own_in_the_directory_asked() {
        let f = setup();
        let answer = runtime().block_on(f.launch(request("k-1"))).unwrap();
        let spec = f.spec(&answer);
        let file = spec.env["BAZHEN_AGENT_AUTH_FILE"].clone();
        assert_eq!(
            (
                spec.argv.clone(),
                spec.cwd.clone(),
                spec.env.keys().map(String::as_str).collect::<Vec<_>>()
            ),
            (
                STUB_ARGV.map(str::to_owned).to_vec(),
                format!("{}/repo", f.home),
                vec![
                    "BAZHEN_AGENT_AUTH_FILE",
                    "BAZHEN_AGENT_ID",
                    "BAZHEN_SOCKET",
                    "STUB_HOME"
                ]
            )
        );
        assert_eq!(
            [
                &spec.env["BAZHEN_AGENT_ID"],
                &spec.env["BAZHEN_SOCKET"],
                &spec.env["STUB_HOME"]
            ],
            [answer.agent_id.as_str(), "/run/b.sock", "/stub"]
        );
        // The start's token is kept: its file is the one the agent reads, and its hash proves it.
        let token = std::fs::read_to_string(&file).unwrap();
        let reader = f.store.reader().unwrap();
        assert_eq!(
            reader
                .reads()
                .agent_token_hash(answer.agent_id.as_str())
                .unwrap(),
            Some(crate::tokens::hash_of(token.trim_end()))
        );
        assert!(file.starts_with(&f.run.join("agents").to_string_lossy().into_owned()));
    }

    #[test]
    fn starts_each_agent_through_the_login_shell_when_there_is_one() {
        let start = |shell: &str| {
            let f = setup_with(Setup {
                login_shell: Some(shell.to_owned()),
                ..Setup::default()
            });
            let answer = runtime().block_on(f.launch(request("k-1"))).unwrap();
            f.spec(&answer).argv
        };
        let argv = |words: &[&str]| words.iter().map(|&w| w.to_owned()).collect::<Vec<_>>();
        assert_eq!(
            [start("/usr/bin/fish"), start("/bin/zsh")],
            [
                argv(&[
                    "/usr/bin/fish",
                    "-l",
                    "-i",
                    "-c",
                    "exec $argv",
                    "stub-tui",
                    "--fresh"
                ]),
                argv(&[
                    "/bin/zsh",
                    "-l",
                    "-i",
                    "-c",
                    "exec \"$@\"",
                    "sh",
                    "stub-tui",
                    "--fresh"
                ]),
            ]
        );
    }

    #[test]
    fn hands_the_harness_the_theme_asked_for_and_records_the_one_its_tui_started_in() {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        let answer = runtime()
            .block_on(f.launch(LaunchAgentRequest {
                theme: Some(TuiTheme::Light),
                ..request("k-1")
            }))
            .unwrap();
        assert_eq!(
            stub.launches.lock().unwrap()[0].theme,
            Some(TuiTheme::Light)
        );
        assert_eq!(f.last("agent.running")["theme"], "dark");
        assert_eq!(f.spec(&answer).theme, Some(TuiTheme::Dark));
        // None asked, none recorded.
        runtime().block_on(f.launch(request("k-2"))).unwrap();
        assert_eq!(f.last("agent.running").get("theme"), None);
    }

    #[test]
    fn starts_the_agent_with_the_compaction_window_the_request_names_and_keeps_it_for_later_starts()
    {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        runtime()
            .block_on(f.launch(LaunchAgentRequest {
                compact_window_tokens: Some(200_000),
                ..request("k-1")
            }))
            .unwrap();
        assert_eq!(
            stub.launches.lock().unwrap()[0].compact_window_tokens,
            Some(200_000)
        );
        assert_eq!(f.last("agent.launched")["compactWindowTokens"], 200_000);
    }

    #[test]
    fn launches_once_for_a_repeated_key_answering_from_the_first_though_its_directory_has_gone() {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        runtime().block_on(async {
            let first = f.launch(request("k-1")).await.unwrap();
            std::fs::remove_dir(format!("{}/repo", f.home)).unwrap();
            let again = f.launch(request("k-1")).await.unwrap();
            assert_eq!(again, first);
        });
        assert_eq!(stub.launches.lock().unwrap().len(), 1);
        assert_eq!(f.types().len(), 3);
    }

    #[test]
    fn refuses_a_harness_the_environment_cant_run_before_recording_anything() {
        let f = setup_with(Setup {
            harnesses: production_for_test(),
            ..Setup::default()
        });
        let refused = runtime().block_on(f.launch(LaunchAgentRequest {
            harness: HarnessId::Codex,
            ..request("k-1")
        }));
        assert_eq!(
            refused,
            Err(AgentError::Unsupported(
                "this environment cannot run codex".to_owned()
            ))
        );
        assert_eq!(f.types(), Vec::<String>::new());
    }

    #[test]
    fn starts_claude_code_on_a_session_it_names_reading_its_prompt_from_the_file() {
        let f = setup_with(Setup {
            harnesses: production_for_test(),
            ..Setup::default()
        });
        let answer = runtime().block_on(f.launch(request("k-1"))).unwrap();
        let argv = f.spec(&answer).argv;
        let prompt = f
            .run
            .join(format!("prompts/{}.md", answer.agent_id.as_str()));
        let after = |flag: &str| {
            argv.iter()
                .position(|a| a == flag)
                .and_then(|i| argv.get(i + 1))
                .cloned()
        };
        assert_eq!(
            (
                argv.first().cloned(),
                after("--session-id"),
                after("--append-system-prompt-file")
            ),
            (
                Some("claude".to_owned()),
                Some("session-1".to_owned()),
                Some(prompt.to_string_lossy().into_owned())
            )
        );
        assert_eq!(f.last("agent.running")["externalRef"]["id"], "session-1");
    }

    #[test]
    fn refuses_every_launch_while_no_hook_client_is_built_recording_nothing() {
        let f = setup_with(Setup {
            hook_built: false,
            ..Setup::default()
        });
        let refused = runtime().block_on(f.launch(request("k-1")));
        assert_eq!(refused, Err(AgentError::Unavailable(NO_HOOK.to_owned())));
        assert!(NO_HOOK.contains("moon run :build-hook"));
        assert_eq!(f.types(), Vec::<String>::new());
    }

    #[test]
    fn records_a_refused_launch_as_failed_saying_why_secrets_taken_out_and_the_same_to_a_repeat() {
        let stub = StubHarness::refusing(LaunchError::Refused(
            "no such model; api_key = s3cr3t".to_owned(),
        ));
        let f = stubbed(&stub);
        let (first, again, agent) = runtime().block_on(async {
            let first = f.launch(request("k-1")).await;
            let again = f.launch(request("k-1")).await;
            let agent = f.last("agent.launched");
            (first, again, agent)
        });
        let id = f.events()[1].0.clone();
        assert_eq!(id, "agent.launched");
        let Err(AgentError::LaunchFailed { agent: failed, why }) = first else {
            panic!("launched: {first:?}");
        };
        assert_eq!(why, "no such model; api_key = [redacted]");
        assert_eq!(
            again,
            Err(AgentError::LaunchFailed {
                agent: failed.clone(),
                why: "an earlier attempt failed: no such model; api_key = [redacted]".to_owned(),
            })
        );
        assert_eq!(
            f.types(),
            ["environment.registered", "agent.launched", "agent.failed"]
        );
        assert_eq!(
            f.last("agent.failed"),
            serde_json::json!({"reason": "launch_rejected", "detail": "no such model; api_key = [redacted]"})
        );
        assert!(agent["terminalId"].is_string());
        assert_eq!(stub.launches.lock().unwrap().len(), 1);
        assert_eq!(f.prompts(), Vec::<String>::new());
        // Its token, which nothing started with, is gone too.
        assert_eq!(std::fs::read_dir(f.run.join("agents")).unwrap().count(), 0);
    }

    #[test]
    fn records_a_launch_the_runtime_refused_as_failed_and_gives_its_slot_back() {
        let f = setup_with(Setup {
            max: 1,
            ..Setup::default()
        });
        f.fake.set(|state| state.fail_creates = true);
        let failed = runtime().block_on(f.launch(request("k-1")));
        assert!(
            matches!(failed, Err(AgentError::LaunchFailed { .. })),
            "{failed:?}"
        );
        assert_eq!(f.last("agent.failed")["reason"], "launch_rejected");
        assert_eq!(f.prompts(), Vec::<String>::new());
        f.fake.set(|state| state.fail_creates = false);
        assert!(runtime().block_on(f.launch(request("k-2"))).is_ok());
    }

    /// A daemon that dies mid-launch leaves its key's record saying nothing failed; the agent's
    /// own state says it did, once reconciliation settles it.
    #[test]
    fn answers_a_repeat_of_an_agent_recorded_failed_since_with_its_failure() {
        let f = stubbed(&StubHarness::refusing(LaunchError::Unavailable(
            "socket gone".to_owned(),
        )));
        let failed = runtime().block_on(f.launch(request("k-1")));
        let Err(AgentError::LaunchFailed { agent, .. }) = failed else {
            panic!("launched: {failed:?}");
        };
        let record = |failed: bool| {
            runtime().block_on(f.store.run(move |store| {
                store.write(|w| -> Result<(), OnceError> {
                    let mut kept: serde_json::Value = w.recall("k-1")?.unwrap();
                    kept["failed"] = serde_json::Value::Bool(failed);
                    w.remember("k-1", &kept)
                })
            }))
        };
        record(false).unwrap().unwrap();
        let again = runtime().block_on(f.launch(request("k-1")));
        assert_eq!(
            again,
            Err(AgentError::LaunchFailed {
                agent,
                why: "an earlier attempt failed: socket gone".to_owned(),
            })
        );
    }

    #[test]
    fn refuses_a_launch_past_the_budget_starting_and_recording_nothing() {
        let stub = StubHarness::new(pull());
        let f = setup_with(Setup {
            harnesses: stub.served_as(HarnessId::ClaudeCode),
            max: 1,
            ..Setup::default()
        });
        runtime().block_on(f.launch(request("k-1"))).unwrap();
        let before = f.types();
        let refused = runtime().block_on(f.launch(request("k-2")));
        assert!(matches!(refused, Err(AgentError::Limit(_))), "{refused:?}");
        assert_eq!(f.types(), before);
        assert_eq!(stub.launches.lock().unwrap().len(), 1);
        assert_eq!(f.prompts().len(), 1);
    }

    #[test]
    fn starts_the_agent_with_the_fleets_instructions_then_its_roles_prompt_from_a_private_file() {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        let answer = runtime()
            .block_on(f.launch(LaunchAgentRequest {
                role: Some(Role::worker()),
                ..request("k-1")
            }))
            .unwrap();
        let roles = Roles::new(None).current();
        let worker = roles.book.get(&Role::worker()).unwrap();
        let expected = format!(
            "{FLEET}\n\n## Your role: {}\n\n{}",
            worker.title, worker.prompt
        );
        let launched = stub.launches.lock().unwrap()[0].clone();
        let file = launched.instructions_file.clone().unwrap();
        assert_eq!(
            (
                launched.instructions.as_deref(),
                std::fs::read_to_string(&file).unwrap(),
                launched.instructions_changed
            ),
            (Some(expected.as_str()), expected.clone(), false)
        );
        assert_eq!(
            file,
            f.run
                .join(format!("prompts/{}.md", answer.agent_id.as_str()))
                .to_string_lossy()
        );
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            [mode(Path::new(&file)), mode(&f.run.join("prompts"))],
            [0o600, 0o700]
        );
        assert_eq!(
            f.last("agent.launched")["promptHash"],
            crate::tokens::hash_of(&expected)
        );
        assert_eq!(f.last("agent.launched")["role"], "worker");
    }

    #[test]
    fn refuses_a_role_no_definition_has_starting_and_recording_nothing() {
        let f = setup();
        let refused = runtime().block_on(f.launch(LaunchAgentRequest {
            role: Role::parse("juggler"),
            ..request("k-1")
        }));
        assert_eq!(
            refused,
            Err(AgentError::Invalid(
                "no role is defined as juggler: bazhen roles lists them".to_owned()
            ))
        );
        assert_eq!(f.types(), Vec::<String>::new());
        assert_eq!(f.prompts(), Vec::<String>::new());
    }

    #[test]
    fn refuses_a_directory_that_isnt_one_starting_and_recording_nothing() {
        let f = setup();
        let refused = runtime().block_on(f.launch(LaunchAgentRequest {
            cwd: "~/nowhere".to_owned(),
            ..request("k-1")
        }));
        assert_eq!(
            refused,
            Err(AgentError::Invalid(format!(
                "{}/nowhere does not exist",
                f.home
            )))
        );
        assert_eq!(f.types(), Vec::<String>::new());
    }

    #[test]
    fn refuses_a_launch_whose_prompt_cant_be_written_recording_and_starting_nothing() {
        let stub = StubHarness::new(pull());
        let f = stubbed(&stub);
        std::fs::create_dir_all(&f.run).unwrap();
        std::fs::write(f.run.join("prompts"), "not a directory").unwrap();
        let refused = runtime().block_on(f.launch(request("k-1")));
        assert!(
            matches!(&refused, Err(AgentError::Internal(why)) if why.contains("prompt can't be written")),
            "{refused:?}"
        );
        assert_eq!(f.types(), Vec::<String>::new());
        assert_eq!(stub.launches.lock().unwrap().len(), 0);
    }

    #[test]
    fn names_its_project_by_the_directory_asked_unless_the_request_names_one() {
        let f = setup();
        runtime().block_on(async {
            f.launch(LaunchAgentRequest {
                cwd: "~/repo/".to_owned(),
                ..request("k-1")
            })
            .await
            .unwrap();
            f.launch(LaunchAgentRequest {
                project: Some("bazhen".to_owned()),
                ..request("k-2")
            })
            .await
            .unwrap();
        });
        let launched: Vec<_> = f
            .events()
            .into_iter()
            .filter(|(kind, _)| kind == "agent.launched")
            .map(|(_, p)| (p["project"].clone(), p["name"].clone()))
            .collect();
        assert_eq!(
            launched,
            [
                (serde_json::json!("repo"), serde_json::json!("repo-1")),
                (serde_json::json!("bazhen"), serde_json::json!("bazhen-1")),
            ]
        );
        assert_eq!(
            [
                basename("/"),
                basename("a/b//"),
                basename("~"),
                basename("x")
            ],
            ["", "b", "~", "x"]
        );
    }

    /// The stub, served as each harness in turn, for each way mail reaches it, is launched the
    /// same way every time: nothing in the daemon names a harness, and only the stub's own argv
    /// starts.
    #[test]
    fn launches_the_stub_the_same_way_whichever_harness_it_is_served_as() {
        let runs: Vec<_> = HarnessId::ALL
            .into_iter()
            .flat_map(|id| {
                [Delivery::Pull, Delivery::Push, Delivery::None].map(move |delivery| (id, delivery))
            })
            .map(|(id, delivery)| {
                let stub = StubHarness::new(bazhen_harness::Capabilities { delivery, ..pull() });
                let f = setup_with(Setup {
                    harnesses: stub.served_as(id),
                    ..Setup::default()
                });
                let answer = runtime()
                    .block_on(f.launch(LaunchAgentRequest {
                        harness: id,
                        ..request("k-1")
                    }))
                    .unwrap();
                let spec = f.spec(&answer);
                let calls: Vec<_> = stub
                    .launches
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|l| {
                        let cwd = l.cwd.strip_prefix(&f.home).map(str::to_owned);
                        (cwd, l.name.clone(), l.instructions.clone())
                    })
                    .collect();
                (
                    answer.event_ids.len(),
                    f.types(),
                    spec.argv,
                    spec.env.into_keys().collect::<Vec<_>>(),
                    calls,
                    f.last("agent.running")["externalRef"]["id"].clone(),
                )
            })
            .collect();
        assert_eq!(runs[0].2, STUB_ARGV.map(str::to_owned).to_vec());
        assert!(runs.iter().all(|run| *run == runs[0]), "{runs:#?}");
    }
}
