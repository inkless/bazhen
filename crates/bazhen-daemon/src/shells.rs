//! Shell terminals (`shells/lifecycle.ts`): opening, closing, restarting and renaming them, and
//! closing one at once when its shell exits. Commands on one shell run one at a time. A shell
//! beside an agent needs the agents this daemon doesn't run yet, so it opens none, and a restart
//! opens its new shell standalone.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use bazhen_protocol::events::{
    RuntimeRefPayload, TerminalClosed, TerminalClosedReason, TerminalFailed, TerminalFailedReason,
    TerminalIncarnation, TerminalOpened, TerminalRenamed,
};
use bazhen_protocol::ids::{DeviceId, TerminalId};
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::{
    BusyShell, CloseShellRequest, OpenShellRequest, RenameShellRequest, RestartShellRequest,
    ShellCommand, ShellCommandResponse, TerminalState, TuiTheme, shell_commands,
};
use bazhen_store::{
    Actor, AppendError, NewEvent, OnceError, ShellRow, TerminalChange, Writer as StoreWriter,
};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::budget::{Budget, Counts, TerminalLimit};
use crate::terminals::{Exit, Exits, Recorded, ShellSpec, TerminalError, Terminals};
use crate::writer::Writer;

/// The runtime every shell this daemon opens is created on.
const RUNTIME: &str = "holder";

/// Why a command on a shell did nothing, in the kinds its answer tells apart.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ShellError {
    /// The request breaks a rule, or names a directory that isn't one.
    #[error("{0}")]
    Invalid(String),
    /// It is valid, but needs what this daemon doesn't do yet.
    #[error("{0}")]
    Unsupported(String),
    #[error(transparent)]
    Limit(#[from] TerminalLimit),
    #[error("idempotency key {0} was first used for a different request")]
    Idempotency(String),
    #[error("no shell {0}")]
    Unknown(String),
    /// Its state doesn't allow the command, or its terminal isn't the one recorded.
    #[error("{0}")]
    Conflict(String),
    #[error("shell {id} is at generation {generation}")]
    Stale { id: String, generation: u64 },
    /// Something other than the shell runs in it, so a close must be confirmed.
    #[error("{message}")]
    Busy {
        message: String,
        busy: Vec<BusyShell>,
    },
    /// The runtime could not open it; it is recorded failed.
    #[error("shell {0} failed to open")]
    OpenFailed(String),
    #[error("{0}")]
    ServerUnconfirmed(String),
    #[error("{0}")]
    NeedsRestart(String),
    /// The runtime could not act just now; the command can be repeated.
    #[error("{0}")]
    Unavailable(String),
    /// A failure no command expects, which is the daemon's.
    #[error("{0}")]
    Internal(String),
}

impl From<rusqlite::Error> for ShellError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<AppendError> for ShellError {
    fn from(err: AppendError) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<OnceError> for ShellError {
    fn from(err: OnceError) -> Self {
        match err {
            OnceError::Conflict(key) => Self::Idempotency(key),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl From<crate::writer::Closed> for ShellError {
    fn from(err: crate::writer::Closed) -> Self {
        Self::Internal(err.to_string())
    }
}

/// The runtime's failure as a command on shell `id` answers it (`fromEnvironment` in
/// `lifecycle.ts` and `commands.ts`). A shell has no exited state to be in, so a process found
/// not as expected is a replaced one.
fn from_runtime(id: &str, cause: TerminalError) -> ShellError {
    match cause {
        TerminalError::Stale(_) | TerminalError::Gone(_) | TerminalError::ProcessState(_) => {
            ShellError::Conflict(format!(
                "shell {id}'s terminal is not the one recorded; its server or pane has changed"
            ))
        }
        TerminalError::Unservable {
            protocol,
            holder_pid,
        } => {
            let holder = holder_pid.map_or_else(
                || "its holder".to_owned(),
                |pid| format!("its holder, pid {pid},"),
            );
            ShellError::NeedsRestart(format!(
                "shell {id}'s terminal runs on a holder that speaks only {}, which this version of Bazhen doesn't, so it can't be closed from here: {holder} keeps running until its process is ended. Once it has, close it again, or relaunch it.",
                protocol.join(", ")
            ))
        }
        TerminalError::Unconfirmed(_) => ShellError::ServerUnconfirmed(format!(
            "shell {id}'s terminal is no longer where it ran, but what ran it may still be running it; close it with force to record it closed anyway"
        )),
        TerminalError::Other(detail) => ShellError::Unavailable(format!(
            "could not reach the environment running shell {id}: {detail}"
        )),
    }
}

/// The request as the idempotency key keeps it, as `JSON.stringify` writes
/// `{ command, terminalId, ...req }`: the command first, then the shell, then the request's keys
/// in its schema's order.
#[derive(Serialize)]
struct Asked<'a, R> {
    command: &'a str,
    #[serde(rename = "terminalId", skip_serializing_if = "Option::is_none")]
    terminal_id: Option<&'a str>,
    #[serde(flatten)]
    request: &'a R,
}

fn asked<R: Serialize>(
    command: &str,
    terminal_id: Option<&str>,
    request: &R,
) -> Result<String, ShellError> {
    serde_json::to_string(&Asked {
        command,
        terminal_id,
        request,
    })
    .map_err(|e| ShellError::Internal(e.to_string()))
}

/// `path` with `.` and `..` taken out and its slashes single, as Node's `path.join` leaves one.
fn normalized(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

/// The directory a launch asked for, as the daemon will use it (`resolveDirectory` in
/// `agents/cwd.ts`). A leading `~` is the daemon user's home, as a shell reads it; anything else
/// must be absolute, and an existing directory.
pub(crate) fn resolve_directory(requested: &str, home: &str) -> Result<String, ShellError> {
    let path = if requested == "~" {
        home.to_owned()
    } else if let Some(rest) = requested.strip_prefix("~/") {
        // Joined as text, as `path.join` joins: a path's own join would take `~//tmp` for `/tmp`.
        let mut joined = normalized(Path::new(&format!("{home}/{rest}")))
            .to_string_lossy()
            .into_owned();
        // `path.join` keeps a trailing slash, as `~/work/` asks.
        if rest.ends_with('/') && !joined.ends_with('/') {
            joined.push('/');
        }
        joined
    } else {
        requested.to_owned()
    };
    if !path.starts_with('/') {
        return Err(ShellError::Invalid(format!(
            "\"{requested}\" is not a full path: start it with / or ~/"
        )));
    }
    match std::fs::metadata(&path) {
        Ok(found) if found.is_dir() => Ok(path),
        Ok(_) => Err(ShellError::Invalid(format!("{path} is not a directory"))),
        // Only a missing path is the request's fault; anything else, such as EACCES, is the
        // daemon's.
        Err(err)
            if matches!(
                err.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Err(ShellError::Invalid(format!("{path} does not exist")))
        }
        Err(err) => Err(ShellError::Internal(format!("{path} can't be read: {err}"))),
    }
}

/// Commands on one shell, one at a time, each waiting its turn by the shell's id.
#[derive(Debug, Default)]
struct Turns(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

/// A shell's turn, given back as it drops.
#[derive(Debug)]
struct Turn<'a> {
    turns: &'a Turns,
    id: String,
    held: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Turns {
    async fn take(&self, id: &str) -> Turn<'_> {
        let lock = {
            let mut turns = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(turns.entry(id.to_owned()).or_default())
        };
        Turn {
            turns: self,
            id: id.to_owned(),
            held: Some(lock.lock_owned().await),
        }
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        drop(self.held.take());
        let mut turns = self.turns.0.lock().unwrap_or_else(PoisonError::into_inner);
        // Forgotten once no other command holds or waits for it.
        if turns
            .get(&self.id)
            .is_some_and(|lock| Arc::strong_count(lock) == 1)
        {
            turns.remove(&self.id);
        }
    }
}

/// What a shell's lifecycle needs.
#[derive(Debug)]
pub(crate) struct ShellsDeps {
    pub(crate) store: Writer,
    pub(crate) terminals: Arc<dyn Terminals>,
    pub(crate) budget: Arc<Budget>,
    /// The daemon user's home: a shell's default directory, and what `~` names.
    pub(crate) home: String,
    /// The shell a new terminal tab would run.
    pub(crate) shell: String,
    /// The daemon's socket, handed to every shell as `BAZHEN_SOCKET`.
    pub(crate) socket: String,
    /// The daemon's tasks, which every command runs on to its end.
    pub(crate) tracker: TaskTracker,
}

/// How long an exited shell's failed close waits to be tried again, at first and at most.
const RETRY_FIRST: Duration = Duration::from_millis(100);
const RETRY_MOST: Duration = Duration::from_secs(30);

/// Why an exited shell's terminal wasn't ended.
#[derive(Debug)]
enum Unended {
    /// A later try may end it: its runtime or the store couldn't be reached just now.
    Again(ShellError),
    /// No try can: it has no terminal recorded, or what runs there is provably not the one
    /// recorded or speaks no protocol this build does, the failures a forced close can't record
    /// past either. The shell stays `state`.
    Never {
        state: TerminalState,
        err: ShellError,
    },
}

impl From<ShellError> for Unended {
    fn from(err: ShellError) -> Self {
        Self::Again(err)
    }
}

/// Shell terminals: whoever can reach the daemon's API can open and close them, confirming a
/// busy close included, as with agents' own commands.
#[derive(Debug)]
pub(crate) struct Shells {
    deps: ShellsDeps,
    turns: Turns,
    /// Exited shells whose terminal couldn't be ended and is being tried again, by terminal and
    /// generation, each said once. One no try can end is said once as it is given up, and not
    /// kept, since nothing tries it again.
    unended: Mutex<HashSet<String>>,
}

/// A new shell, as `start` opens it.
#[derive(Debug)]
struct Opening {
    cwd: String,
    theme: Option<TuiTheme>,
    restart_of: Option<TerminalId>,
    /// The paired device that asked for it, which its environment names.
    opened_by: Option<DeviceId>,
}

/// A command's last step: an answer made already, or changes to record with the key's answer.
#[derive(Debug)]
enum Last {
    Answer(ShellCommandResponse),
    Record {
        done: Vec<u64>,
        then: Vec<TerminalChange>,
    },
}

/// A command past its checks: the first answer to its key, or the shell to act on.
#[derive(Debug)]
enum Begun {
    Prior(ShellCommandResponse),
    Found(ShellRow),
}

fn recorded(found: &ShellRow) -> Option<Recorded> {
    Some(Recorded {
        terminal_id: found.id.clone(),
        locator: found.locator.clone()?,
    })
}

/// What a forced close leaves running, as its log line says it (`stillRunning`).
fn still_running(found: &ShellRow) -> String {
    let pid = found
        .locator
        .as_deref()
        .and_then(|text| serde_json::from_str::<Record<String>>(text).ok())
        .and_then(|locator| {
            locator
                .entries()
                .iter()
                .find(|(key, _)| key == "holderPid")
                .map(|(_, pid)| pid.clone())
        })
        .unwrap_or_else(|| "unknown".to_owned());
    format!("its holder (pid {pid}) may still be running it")
}

fn offers(command: ShellCommand) -> impl Fn(&ShellRow) -> bool {
    move |found| shell_commands(found.state, found.linked_agent_id.is_some()).contains(&command)
}

impl Shells {
    pub(crate) fn new(deps: ShellsDeps) -> Self {
        Self {
            deps,
            turns: Turns::default(),
            unended: Mutex::new(HashSet::new()),
        }
    }

    pub(crate) fn terminals(&self) -> &Arc<dyn Terminals> {
        &self.deps.terminals
    }

    pub(crate) fn budget(&self) -> &Arc<Budget> {
        &self.deps.budget
    }

    /// Runs `command` to its end on the daemon's tasks, whether or not its caller waits for the
    /// answer: a client that goes away mid-command would otherwise leave a shell recorded opened
    /// and never running, holding its slot in the budget, as the TypeScript daemon's promise,
    /// which runs on, never does.
    pub(crate) async fn completing<T, F>(
        self: &Arc<Self>,
        command: impl FnOnce(Arc<Self>) -> F,
    ) -> Result<T, ShellError>
    where
        F: Future<Output = Result<T, ShellError>> + Send + 'static,
        T: Send + 'static,
    {
        self.deps
            .tracker
            .spawn(command(Arc::clone(self)))
            .await
            .map_err(|err| ShellError::Internal(format!("a shell's command ended early: {err}")))?
    }

    async fn write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&StoreWriter<'_>) -> Result<T, ShellError> + Send + 'static,
    ) -> Result<T, ShellError> {
        self.deps.store.run(move |store| store.write(job)).await?
    }

    async fn shell(&self, id: &str) -> Result<Option<ShellRow>, ShellError> {
        let id = id.to_owned();
        Ok(self
            .deps
            .store
            .run(move |store| store.reads().shell(&id))
            .await??)
    }

    async fn record(
        &self,
        terminal: &TerminalId,
        actor: Actor,
        change: TerminalChange,
    ) -> Result<u64, ShellError> {
        let terminal = terminal.clone();
        self.write(move |w| {
            Ok(w.append(&NewEvent::Terminal {
                terminal,
                actor,
                change,
            })?)
        })
        .await
    }

    /// The first answer to `key`, unless the shell it named has failed to open, which a repeat
    /// says again.
    async fn replayed(
        &self,
        key: &str,
        request: &str,
    ) -> Result<Option<ShellCommandResponse>, ShellError> {
        let (key, request) = (key.to_owned(), request.to_owned());
        let prior = self
            .write(move |w| Ok(w.replay::<ShellCommandResponse>(&key, &request)?))
            .await?;
        let Some(prior) = prior else { return Ok(None) };
        self.unless_failed(prior).await.map(Some)
    }

    async fn unless_failed(
        &self,
        prior: ShellCommandResponse,
    ) -> Result<ShellCommandResponse, ShellError> {
        let id = prior.terminal_id.as_str();
        match self.shell(id).await? {
            Some(found) if found.state == TerminalState::Failed => {
                Err(ShellError::OpenFailed(id.to_owned()))
            }
            _ => Ok(prior),
        }
    }

    /// Opens a standalone shell. The terminal is recorded before the runtime starts it, and the
    /// key's answer with it, so a retry opens nothing new.
    pub(crate) async fn open(
        &self,
        req: &OpenShellRequest,
        opened_by: Option<DeviceId>,
    ) -> Result<ShellCommandResponse, ShellError> {
        let request = asked("open", None, req)?;
        if let Some(prior) = self.replayed(&req.idempotency_key, &request).await? {
            return Ok(prior);
        }
        if req.linked_agent_id.is_some() {
            return Err(ShellError::Unsupported(
                "this daemon can't open a shell beside an agent yet".to_owned(),
            ));
        }
        let cwd = resolve_directory(req.cwd.as_deref().unwrap_or("~"), &self.deps.home)?;
        let opening = Opening {
            cwd,
            theme: req.theme,
            restart_of: None,
            opened_by,
        };
        self.start(opening, &req.idempotency_key, &request).await
    }

    /// Records a new shell, admitted by the budget and answered under `key` in the one
    /// transaction, then starts it on the runtime and records it running, or failed.
    async fn start(
        &self,
        opening: Opening,
        key: &str,
        request: &str,
    ) -> Result<ShellCommandResponse, ShellError> {
        let budget = Arc::clone(&self.deps.budget);
        let (key, request) = (key.to_owned(), request.to_owned());
        let (cwd, theme, restart_of) = (
            opening.cwd.clone(),
            opening.theme,
            opening.restart_of.clone(),
        );
        let opened = self
            .write(move |w| {
                // Under the same transaction as the record, so two opens with one key make one.
                if let Some(prior) = w.replay::<ShellCommandResponse>(&key, &request)? {
                    return Ok(Err(prior));
                }
                let reads = w.reads();
                budget.admit(Counts {
                    open: reads.open_terminals()?,
                    starting: reads.starting_terminals()?,
                })?;
                let terminal = w.mint_terminal()?;
                let payload = TerminalOpened {
                    environment_id: w.local_environment()?,
                    cwd,
                    linked_agent_id: None,
                    theme,
                    restart_of,
                    runtime: Some(RUNTIME.to_owned()),
                };
                let id = w.append(&NewEvent::Terminal {
                    terminal: terminal.clone(),
                    actor: Actor::User,
                    change: TerminalChange::Opened(payload),
                })?;
                let response = ShellCommandResponse {
                    terminal_id: terminal,
                    event_ids: vec![id],
                };
                w.answered(&key, &request, &response)?;
                Ok(Ok(response))
            })
            .await?;
        let opened = match opened {
            Ok(opened) => opened,
            Err(prior) => return self.unless_failed(prior).await,
        };
        let terminal = opened.terminal_id.clone();
        // Held until it is recorded running or failed: an exit told while the runtime still
        // starts it waits, and then finds it running, to close.
        let _turn = self.turns.take(terminal.as_str()).await;
        let spec = self.spec(&terminal, opening);
        match self.deps.terminals.create(spec).await {
            Err(cause) => {
                tracing::error!("bazhen: shell {terminal} failed to open: {cause}");
                self.record(
                    &terminal,
                    Actor::User,
                    TerminalChange::Failed(TerminalFailed {
                        reason: TerminalFailedReason::OpenRejected,
                    }),
                )
                .await?;
                Err(ShellError::OpenFailed(terminal.as_str().to_owned()))
            }
            Ok(locator) => {
                let running = self
                    .record(
                        &terminal,
                        Actor::User,
                        TerminalChange::Running(TerminalIncarnation {
                            runtime_ref: RuntimeRefPayload {
                                runtime: RUNTIME.to_owned(),
                                locator,
                            },
                        }),
                    )
                    .await?;
                let mut event_ids = opened.event_ids;
                event_ids.push(running);
                Ok(ShellCommandResponse {
                    terminal_id: terminal,
                    event_ids,
                })
            }
        }
    }

    /// The user's shell as a login shell, told its terminal and the daemon's socket, and the
    /// paired device that opened it.
    fn spec(&self, terminal: &TerminalId, opening: Opening) -> ShellSpec {
        let mut env = BTreeMap::from([
            (
                "BAZHEN_TERMINAL_ID".to_owned(),
                terminal.as_str().to_owned(),
            ),
            ("BAZHEN_SOCKET".to_owned(), self.deps.socket.clone()),
        ]);
        if let Some(device) = opening.opened_by {
            env.insert("BAZHEN_DEVICE_ID".to_owned(), device.as_str().to_owned());
        }
        ShellSpec {
            terminal_id: terminal.clone(),
            linked_agent_id: None,
            argv: vec![self.deps.shell.clone(), "-l".to_owned(), "-i".to_owned()],
            cwd: opening.cwd,
            env,
            theme: opening.theme,
        }
    }

    /// A command's checks, under its shell's turn: a repeated key gets the first answer;
    /// otherwise the shell must be in a state the command accepts, at the generation it names.
    async fn begin(
        &self,
        id: &str,
        key: &str,
        request: &str,
        generation: Option<u64>,
        accepts: impl Fn(&ShellRow) -> bool,
    ) -> Result<Begun, ShellError> {
        if let Some(prior) = self.replayed(key, request).await? {
            return Ok(Begun::Prior(prior));
        }
        let found = self
            .shell(id)
            .await?
            .ok_or_else(|| ShellError::Unknown(id.to_owned()))?;
        if !accepts(&found) {
            return Err(ShellError::Conflict(format!(
                "shell {id} is {}",
                found.state.as_str()
            )));
        }
        if let Some(asked) = generation
            && asked != found.generation
        {
            return Err(ShellError::Stale {
                id: id.to_owned(),
                generation: found.generation,
            });
        }
        Ok(Begun::Found(found))
    }

    /// Records a command's last step with the key's answer, in one transaction.
    async fn finish(
        &self,
        terminal: &TerminalId,
        key: &str,
        request: &str,
        last: Last,
    ) -> Result<ShellCommandResponse, ShellError> {
        let (terminal, key, request) = (terminal.clone(), key.to_owned(), request.to_owned());
        self.write(move |w| {
            let response = match last {
                Last::Answer(response) => response,
                Last::Record { mut done, then } => {
                    for change in then {
                        done.push(w.append(&NewEvent::Terminal {
                            terminal: terminal.clone(),
                            actor: Actor::User,
                            change,
                        })?);
                    }
                    ShellCommandResponse {
                        terminal_id: terminal,
                        event_ids: done,
                    }
                }
            };
            w.answered(&key, &request, &response)?;
            Ok(response)
        })
        .await
    }

    /// Ends a shell and everything in it, asking first (`busy`) when the shell isn't what runs in
    /// its foreground. A lost shell is only taken off the list: there is nothing left to end.
    pub(crate) async fn close(
        &self,
        id: &str,
        req: &CloseShellRequest,
    ) -> Result<ShellCommandResponse, ShellError> {
        let request = asked("close", Some(id), req)?;
        let key = &req.idempotency_key;
        let force = req.force == Some(true);
        let accepts = |found: &ShellRow| {
            found.state == TerminalState::Closed
                || if force {
                    found.state == TerminalState::Closing
                } else {
                    offers(ShellCommand::Close)(found)
                }
        };
        let _turn = self.turns.take(id).await;
        let found = match self
            .begin(id, key, &request, Some(req.generation), accepts)
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        let last = if found.state == TerminalState::Closed {
            Last::Answer(ShellCommandResponse {
                terminal_id: found.id.clone(),
                event_ids: Vec::new(),
            })
        } else {
            if found.state == TerminalState::Running && req.confirm_busy != Some(true) {
                self.refuse_busy(&found, req.confirmed_program.as_deref())
                    .await?;
            }
            let mut done = Vec::new();
            if found.state != TerminalState::Closing {
                done.push(
                    self.record(&found.id, Actor::User, TerminalChange::Closing)
                        .await?,
                );
            }
            if found.state != TerminalState::Lost {
                self.end(&found, force).await?;
            }
            Last::Record {
                done,
                then: vec![TerminalChange::Closed(TerminalClosed {
                    reason: TerminalClosedReason::User,
                })],
            }
        };
        self.finish(&found.id, key, &request, last).await
    }

    /// Refuses a close while something other than the shell runs in it, but for the program the
    /// user was shown running and chose to end. A shell already dead runs nothing.
    async fn refuse_busy(
        &self,
        found: &ShellRow,
        confirmed: Option<&str>,
    ) -> Result<(), ShellError> {
        let Some(terminal) = recorded(found) else {
            return Ok(());
        };
        let program = match self.deps.terminals.foreground(&terminal).await {
            Ok(program) => program,
            // A shell already dead runs nothing, as one whose holder died with it: the close ends
            // what is left of it, where a refusal would leave the user no way past.
            Err(TerminalError::ProcessState(_) | TerminalError::Gone(_)) => None,
            Err(cause) => return Err(from_runtime(found.id.as_str(), cause)),
        };
        match program {
            Some(program) if Some(program.as_str()) != confirmed => Err(ShellError::Busy {
                message: format!(
                    "{program} is running in shell {}; close anyway to end it",
                    found.id
                ),
                busy: vec![BusyShell {
                    terminal_id: found.id.clone(),
                    program,
                }],
            }),
            _ => Ok(()),
        }
    }

    /// Ends the shell's terminal; a forced close records past what may still run it.
    async fn end(&self, found: &ShellRow, force: bool) -> Result<(), ShellError> {
        let Some(terminal) = recorded(found) else {
            return Ok(());
        };
        match self.deps.terminals.close(&terminal).await {
            Ok(()) => Ok(()),
            Err(cause) if force && cause.forceable() => {
                tracing::warn!(
                    "bazhen: shell {} closed by force; {}",
                    found.id,
                    still_running(found)
                );
                Ok(())
            }
            Err(cause) => Err(from_runtime(found.id.as_str(), cause)),
        }
    }

    /// Starts a new shell in a lost one's directory, and takes the lost one off the list once
    /// the new one runs: a restart that fails leaves it lost, to be restarted again. The answer
    /// names the new shell.
    pub(crate) async fn restart(
        &self,
        id: &str,
        req: &RestartShellRequest,
        opened_by: Option<DeviceId>,
    ) -> Result<ShellCommandResponse, ShellError> {
        let request = asked("restart", Some(id), req)?;
        let key = &req.idempotency_key;
        let _turn = self.turns.take(id).await;
        let found = match self
            .begin(
                id,
                key,
                &request,
                Some(req.generation),
                offers(ShellCommand::Restart),
            )
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        if req.retype == Some(true) {
            return Err(self.unretypeable(&found).await?);
        }
        let opening = Opening {
            cwd: self.restart_cwd(&found)?,
            theme: req.theme.or(found.theme),
            restart_of: Some(found.id.clone()),
            opened_by,
        };
        let response = self.start(opening, key, &request).await?;
        let old = found.id.clone();
        self.write(move |w| {
            for change in [
                TerminalChange::Closing,
                TerminalChange::Closed(TerminalClosed {
                    reason: TerminalClosedReason::Restarted,
                }),
            ] {
                w.append(&NewEvent::Terminal {
                    terminal: old.clone(),
                    actor: Actor::User,
                    change,
                })?;
            }
            Ok(())
        })
        .await?;
        self.finish(&found.id, key, &request, Last::Answer(response))
            .await
    }

    /// Why a restart can't type the lost shell's last line back: none is kept, or, with one kept
    /// by an earlier daemon, this one has no shell integration to report the prompt it waits for.
    async fn unretypeable(&self, found: &ShellRow) -> Result<ShellError, ShellError> {
        let id = found.id.as_str().to_owned();
        let kept = self
            .deps
            .store
            .run(move |store| store.reads().keeps_last_command(&id))
            .await??;
        Ok(ShellError::Conflict(if kept {
            "shell integration is off, so a new shell can't report its prompt".to_owned()
        } else {
            format!("shell {} is lost with no last command kept", found.id)
        }))
    }

    /// Where a restart opens: the directory the shell was last seen in, while it is still a
    /// directory, else the one it opened in. Only a directory gone or not one is passed over;
    /// one that can't be read is the daemon's failure.
    fn restart_cwd(&self, found: &ShellRow) -> Result<String, ShellError> {
        match resolve_directory(&found.current_cwd, &self.deps.home) {
            Err(ShellError::Invalid(_)) => Ok(found.cwd.clone()),
            resolved => resolved,
        }
    }

    /// Gives a shell a name, or, given none, takes it away. `req.name` is the name as checked,
    /// trimmed.
    pub(crate) async fn rename(
        &self,
        id: &str,
        req: &RenameShellRequest,
    ) -> Result<ShellCommandResponse, ShellError> {
        let request = asked("rename", Some(id), req)?;
        let key = &req.idempotency_key;
        let _turn = self.turns.take(id).await;
        let found = match self
            .begin(id, key, &request, None, offers(ShellCommand::Rename))
            .await?
        {
            Begun::Prior(prior) => return Ok(prior),
            Begun::Found(found) => found,
        };
        let last = Last::Record {
            done: Vec::new(),
            then: vec![TerminalChange::Renamed(TerminalRenamed {
                name: req.name.clone(),
            })],
        };
        self.finish(&found.id, key, &request, last).await
    }

    /// Closes the shells whose process ends, as the runtime tells, until `stop`. Each exit is
    /// handled on `tracker`, so one slow close holds up no other.
    pub(crate) async fn watch(
        self: Arc<Self>,
        mut exits: Box<dyn Exits>,
        tracker: TaskTracker,
        stop: CancellationToken,
    ) {
        while let Some(Some(exit)) = stop.run_until_cancelled(exits.next()).await {
            let (shells, stop) = (Arc::clone(&self), stop.clone());
            tracker.spawn(async move { shells.exited(exit, &stop).await });
        }
    }

    /// A shell that exits closes at once, with no warning. Closing goes first, so a view whose
    /// stream ends with the terminal is told it closed, not that it disconnected. A close that
    /// fails leaves it closing and is tried again, less often each time, until it ends, the shell
    /// is closed or replaced another way, or `stop`: the runtime tells each exit once, so nothing
    /// else would end it while the daemon runs.
    pub(crate) async fn exited(&self, exit: Exit, stop: &CancellationToken) {
        let id = exit.terminal_id.as_str().to_owned();
        let incarnation = format!("{id}:{}", exit.generation);
        let mut wait = RETRY_FIRST;
        loop {
            let ended = {
                let _turn = self.turns.take(&id).await;
                self.close_exited(&id, exit.generation).await
            };
            {
                let mut unended = self.unended.lock().unwrap_or_else(PoisonError::into_inner);
                match ended {
                    Ok(()) => {
                        unended.remove(&incarnation);
                        return;
                    }
                    Err(Unended::Never { state, err }) => {
                        unended.remove(&incarnation);
                        tracing::warn!(
                            "bazhen: shell {id}: can't end it after it exited, so it stays {}: {err}",
                            state.as_str()
                        );
                        return;
                    }
                    Err(Unended::Again(err)) => {
                        if unended.insert(incarnation.clone()) {
                            tracing::warn!(
                                "bazhen: shell {id}: could not end it after it exited: {err}"
                            );
                        }
                    }
                }
            }
            if stop
                .run_until_cancelled(tokio::time::sleep(wait))
                .await
                .is_none()
            {
                return;
            }
            wait = (wait * 2).min(RETRY_MOST);
        }
    }

    async fn close_exited(&self, id: &str, generation: u64) -> Result<(), Unended> {
        let Some(found) = self.shell(id).await? else {
            return Ok(());
        };
        let ending = matches!(found.state, TerminalState::Running | TerminalState::Closing);
        // An exit of another generation is of a process started outside the daemon, which isn't
        // followed yet.
        if !ending || found.generation != generation {
            return Ok(());
        }
        let terminal = recorded(&found).ok_or_else(|| Unended::Never {
            state: found.state,
            err: ShellError::Conflict("the shell has no terminal recorded".to_owned()),
        })?;
        if found.state != TerminalState::Closing {
            self.record(&found.id, Actor::System, TerminalChange::Closing)
                .await?;
        }
        self.deps
            .terminals
            .close(&terminal)
            .await
            .map_err(|cause| {
                if cause.forceable() {
                    Unended::Again(from_runtime(id, cause))
                } else {
                    Unended::Never {
                        state: TerminalState::Closing,
                        err: from_runtime(id, cause),
                    }
                }
            })?;
        self.record(
            &found.id,
            Actor::System,
            TerminalChange::Closed(TerminalClosed {
                reason: TerminalClosedReason::Exited,
            }),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    use bazhen_protocol::shells::Shell;
    use bazhen_store::SnapshotView;

    use super::*;
    use crate::budget::tests::{Machine, roomy};
    use crate::terminals::fake::{Fake, OnClose};
    use crate::testing::{TempDir, runtime};

    /// Shells on a fake runtime whose user's shell is zsh, over a store of their own.
    struct Harness {
        shells: Arc<Shells>,
        fake: Fake,
        store: Writer,
        home: String,
        dir: TempDir,
        thread: Option<crate::writer::Thread>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                thread.finish();
            }
        }
    }

    fn setup(max: u64) -> Harness {
        let dir = TempDir::new("shells");
        let path = dir.path().join("bazhen.db");
        let (store, thread) =
            crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let home = home.to_string_lossy().into_owned();
        let fake = Fake::default();
        let budget = Budget::new(
            max,
            Arc::new(Machine(StdMutex::new(roomy()))),
            Box::new(|_| {}),
        );
        let shells = Shells::new(ShellsDeps {
            store: store.clone(),
            terminals: Arc::new(fake.clone()),
            budget: Arc::new(budget),
            home: home.clone(),
            shell: "/bin/zsh".to_owned(),
            socket: "/run/b.sock".to_owned(),
            tracker: TaskTracker::new(),
        });
        Harness {
            shells: Arc::new(shells),
            fake,
            store,
            home,
            dir,
            thread: Some(thread),
        }
    }

    fn opening(key: &str) -> OpenShellRequest {
        OpenShellRequest {
            idempotency_key: key.to_owned(),
            linked_agent_id: None,
            cwd: None,
            theme: None,
        }
    }

    fn closing(key: &str, generation: u64) -> CloseShellRequest {
        CloseShellRequest {
            idempotency_key: key.to_owned(),
            generation,
            confirm_busy: None,
            confirmed_program: None,
            force: None,
        }
    }

    /// A close the user confirmed after being shown nvim running in the shell.
    fn confirming_nvim(key: &str) -> CloseShellRequest {
        CloseShellRequest {
            confirmed_program: Some("nvim".to_owned()),
            ..closing(key, 0)
        }
    }

    fn restarting(key: &str) -> RestartShellRequest {
        RestartShellRequest {
            idempotency_key: key.to_owned(),
            generation: 0,
            theme: None,
            retype: None,
        }
    }

    fn terminal(id: &str) -> TerminalId {
        TerminalId::parse(id).unwrap()
    }

    impl Harness {
        async fn open(&self, key: &str) -> Result<String, ShellError> {
            self.shells
                .open(&opening(key), None)
                .await
                .map(|opened| opened.terminal_id.as_str().to_owned())
        }

        fn shell(&self, id: &str) -> Option<ShellRow> {
            self.store.reader().unwrap().reads().shell(id).unwrap()
        }

        fn state_of(&self, id: &str) -> Option<TerminalState> {
            self.shell(id).map(|found| found.state)
        }

        /// The shells the state lists.
        fn listed(&self) -> Vec<Shell> {
            let view = SnapshotView {
                host: "h".to_owned(),
            };
            let reader = self.store.reader().unwrap();
            reader.reads().snapshot(&view).unwrap().shells
        }

        /// A shell opened in `theme` whose holder has gone, as reconciliation records it.
        async fn lost(&self, theme: TuiTheme) -> String {
            let req = OpenShellRequest {
                theme: Some(theme),
                ..opening("lost")
            };
            let id = self.shells.open(&req, None).await.unwrap().terminal_id;
            self.fake.set(|state| {
                state.running.remove(id.as_str());
            });
            self.shells
                .record(&id, Actor::System, TerminalChange::Lost)
                .await
                .unwrap();
            id.as_str().to_owned()
        }

        /// The shell was last seen in `cwd`, as its shell's reports note it.
        async fn seen_in(&self, id: &str, cwd: &str) {
            let (id, cwd) = (id.to_owned(), cwd.to_owned());
            self.store
                .run(move |store| {
                    store.write(|w| -> rusqlite::Result<()> {
                        w.connection().execute(
                            "UPDATE terminals SET current_cwd = ? WHERE id = ?",
                            (&cwd, &id),
                        )?;
                        Ok(())
                    })
                })
                .await
                .unwrap()
                .unwrap();
        }

        /// Closes shells as their shells exit, until the token is cancelled.
        fn watch(&self) -> CancellationToken {
            let (tracker, stop) = (TaskTracker::new(), CancellationToken::new());
            let watching =
                Arc::clone(&self.shells).watch(self.fake.exits(), tracker.clone(), stop.clone());
            tracker.spawn(watching);
            stop
        }

        async fn until(&self, id: &str, state: TerminalState) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.state_of(id) != Some(state) {
                assert!(
                    Instant::now() < deadline,
                    "shell {id} is {:?}, never {state:?}",
                    self.state_of(id)
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        /// Notes each shell's state as its close reaches the runtime.
        fn note_states_at_close(&self) -> Arc<StdMutex<Vec<Option<TerminalState>>>> {
            let seen = Arc::new(StdMutex::new(Vec::new()));
            let (store, at) = (self.store.clone(), Arc::clone(&seen));
            *self.fake.on_close.lock().unwrap() = Some(OnClose(Box::new(move |id| {
                let found = store.reader().unwrap().reads().shell(id).unwrap();
                at.lock().unwrap().push(found.map(|f| f.state));
            })));
            seen
        }
    }

    #[test]
    fn runs_the_users_shell_as_a_login_shell_in_their_home_told_its_terminal_but_no_agent() {
        let h = setup(100);
        runtime().block_on(async {
            let req = OpenShellRequest {
                theme: Some(TuiTheme::Light),
                ..opening("o")
            };
            let id = h.shells.open(&req, None).await.unwrap().terminal_id;
            let spec = h.fake.spec_of(id.as_str());
            assert_eq!(
                (spec.argv, spec.cwd, spec.linked_agent_id, spec.theme),
                (
                    vec!["/bin/zsh".to_owned(), "-l".to_owned(), "-i".to_owned()],
                    h.home.clone(),
                    None,
                    Some(TuiTheme::Light)
                )
            );
            assert_eq!(
                spec.env,
                BTreeMap::from([
                    ("BAZHEN_TERMINAL_ID".to_owned(), id.as_str().to_owned()),
                    ("BAZHEN_SOCKET".to_owned(), "/run/b.sock".to_owned()),
                ])
            );
            assert_eq!(h.state_of(id.as_str()), Some(TerminalState::Running));
        });
    }

    #[test]
    fn refuses_a_shell_beside_an_agent_which_this_daemon_runs_none_of_yet() {
        let h = setup(100);
        runtime().block_on(async {
            let req = OpenShellRequest {
                linked_agent_id: bazhen_protocol::ids::AgentId::parse(
                    "agent_0190a1b2c3d47abc8def0123456789ad",
                ),
                ..opening("o")
            };
            let refused = h.shells.open(&req, None).await;
            assert!(
                matches!(refused, Err(ShellError::Unsupported(_))),
                "{refused:?}"
            );
            assert_eq!(h.listed(), []);
        });
    }

    #[test]
    fn answers_a_repeated_key_with_the_first_shell_opening_no_second_one() {
        let h = setup(100);
        runtime().block_on(async {
            let first = h.open("same").await.unwrap();
            let again = h.open("same").await.unwrap();
            let elsewhere = OpenShellRequest {
                cwd: Some("/".to_owned()),
                ..opening("same")
            };
            let conflict = h.shells.open(&elsewhere, None).await;
            assert_eq!(again, first);
            assert_eq!(h.fake.state.lock().unwrap().running.len(), 1);
            assert_eq!(conflict, Err(ShellError::Idempotency("same".to_owned())));
        });
    }

    #[test]
    fn opens_in_the_directory_asked_reading_a_tilde_as_home_and_refuses_any_other() {
        let dir = TempDir::new("cwd");
        let home = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir(dir.path().join("b")).unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("file"), "").unwrap();
        let resolved = |asked: &str| resolve_directory(asked, &home);
        assert_eq!(resolved("~"), Ok(home.clone()));
        assert_eq!(resolved("~/a/../b"), Ok(format!("{home}/b")));
        assert_eq!(resolved("~/a/./b/"), Ok(format!("{home}/a/b/")));
        assert_eq!(resolved("~//b"), Ok(format!("{home}/b")));
        assert_eq!(resolved(&format!("{home}/b")), Ok(format!("{home}/b")));
        assert_eq!(
            [
                resolved("work"),
                resolved("/no/such/dir"),
                resolved(&format!("{home}/file"))
            ],
            [
                Err(ShellError::Invalid(
                    "\"work\" is not a full path: start it with / or ~/".to_owned()
                )),
                Err(ShellError::Invalid(
                    "/no/such/dir does not exist".to_owned()
                )),
                Err(ShellError::Invalid(format!(
                    "{home}/file is not a directory"
                ))),
            ]
        );
    }

    #[test]
    fn keeps_each_request_as_json_stringify_writes_it_command_and_shell_first() {
        let req = CloseShellRequest {
            confirm_busy: Some(true),
            ..closing("k", 0)
        };
        assert_eq!(
            asked("close", Some("term_x"), &req).unwrap(),
            r#"{"command":"close","terminalId":"term_x","idempotencyKey":"k","generation":0,"confirmBusy":true}"#
        );
        assert_eq!(
            asked("open", None, &opening("o")).unwrap(),
            r#"{"command":"open","idempotencyKey":"o"}"#
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_while_a_program_runs_in_it_naming_it_and_closes_once_that_is_confirmed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "nvim");
            let refused = h.shells.close(&id, &closing("c1", 0)).await;
            let before = (h.state_of(&id), h.fake.carries(&id));
            let confirmed = CloseShellRequest {
                confirm_busy: Some(true),
                ..closing("c2", 0)
            };
            h.shells.close(&id, &confirmed).await.unwrap();
            assert_eq!(
                refused,
                Err(ShellError::Busy {
                    message: format!("nvim is running in shell {id}; close anyway to end it"),
                    busy: vec![BusyShell {
                        terminal_id: terminal(&id),
                        program: "nvim".to_owned(),
                    }],
                })
            );
            assert_eq!(before, (Some(TerminalState::Running), true));
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_without_asking_a_shell_whose_process_died_before_its_exit_was_seen() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "nvim");
            h.fake.exit_unseen(&id);
            h.shells.close(&id, &closing("c", 0)).await.unwrap();
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_without_asking_a_running_shell_whose_holder_died_with_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.run_in_foreground(&id, "nvim");
            h.fake.gone(&id);
            h.shells.close(&id, &closing("c", 0)).await.unwrap();
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_for_the_program_the_user_confirmed_and_refuses_one_started_since() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let confirmed = h.open("a").await.unwrap();
            let replaced = h.open("b").await.unwrap();
            h.fake.run_in_foreground(&confirmed, "nvim");
            h.fake.run_in_foreground(&replaced, "htop");
            h.shells
                .close(&confirmed, &confirming_nvim("c1"))
                .await
                .unwrap();
            let refused = h.shells.close(&replaced, &confirming_nvim("c2")).await;
            assert!(
                matches!(refused, Err(ShellError::Busy { .. })),
                "{refused:?}"
            );
            assert_eq!(
                (h.state_of(&confirmed), h.state_of(&replaced)),
                (Some(TerminalState::Closed), Some(TerminalState::Running))
            );
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_shell_at_its_prompt_without_asking_and_lists_it_no_more() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let listed = h.listed().len();
            h.shells.close(&id, &closing("c", 0)).await.unwrap();
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Closed), false)
            );
            assert_eq!((listed, h.listed()), (1, vec![]));
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn answers_a_repeated_close_the_same_and_one_of_a_closed_shell_with_no_events() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let first = h.shells.close(&id, &closing("c", 0)).await.unwrap();
            let again = h.shells.close(&id, &closing("c", 0)).await.unwrap();
            let after = h.shells.close(&id, &closing("d", 0)).await.unwrap();
            assert_eq!(first.event_ids.len(), 2);
            assert_eq!(again, first);
            assert_eq!(after.event_ids, Vec::<u64>::new());
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn refuses_a_close_naming_an_earlier_generation_and_a_shell_it_doesnt_know() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let stale = h.shells.close(&id, &closing("c", 1)).await;
            let unknown = h.shells.close("term_nope", &closing("d", 0)).await;
            assert_eq!(
                stale,
                Err(ShellError::Stale {
                    id: id.clone(),
                    generation: 0
                })
            );
            assert_eq!(unknown, Err(ShellError::Unknown("term_nope".to_owned())));
            assert_eq!(h.state_of(&id), Some(TerminalState::Running));
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn leaves_a_shell_closing_when_its_terminal_cant_be_reached_and_closes_it_by_force() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            h.fake.set(|state| state.fail_closes = true);
            let unreached = h.shells.close(&id, &closing("c", 0)).await;
            let left = h.state_of(&id);
            let forced = CloseShellRequest {
                force: Some(true),
                ..closing("f", 0)
            };
            h.shells.close(&id, &forced).await.unwrap();
            assert_eq!(
                unreached,
                Err(ShellError::Unavailable(format!(
                    "could not reach the environment running shell {id}: the fake is unreachable"
                )))
            );
            assert_eq!(
                (left, h.state_of(&id)),
                (Some(TerminalState::Closing), Some(TerminalState::Closed))
            );
        });
    }

    #[test]
    fn closes_a_shell_at_once_when_its_shell_exits_recorded_closing_before_its_session_ends() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let at_close = h.note_states_at_close();
            let stop = h.watch();
            h.fake.exit(&id);
            h.until(&id, TerminalState::Closed).await;
            stop.cancel();
            assert!(!h.fake.carries(&id));
            assert_eq!(*at_close.lock().unwrap(), [Some(TerminalState::Closing)]);
        });
    }

    #[test]
    fn leaves_running_a_shell_whose_exit_is_of_another_generation_than_the_one_recorded() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let stop = CancellationToken::new();
            h.shells
                .exited(
                    Exit {
                        terminal_id: terminal(&id),
                        generation: 1,
                    },
                    &stop,
                )
                .await;
            assert_eq!(
                (h.state_of(&id), h.fake.carries(&id)),
                (Some(TerminalState::Running), true)
            );
        });
    }

    /// What the daemon logs while it is set as the thread's subscriber.
    #[derive(Debug, Clone, Default)]
    struct Said(Arc<StdMutex<Vec<u8>>>);

    impl std::io::Write for Said {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Said {
        fn logging(&self) -> tracing::subscriber::DefaultGuard {
            let said = self.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || said.clone())
                .finish();
            tracing::subscriber::set_default(subscriber)
        }

        fn times(&self, text: &str) -> usize {
            String::from_utf8_lossy(&self.0.lock().unwrap())
                .matches(text)
                .count()
        }
    }

    impl Harness {
        /// How many closes have reached the runtime from now on.
        fn count_closes(&self) -> Arc<std::sync::atomic::AtomicUsize> {
            let tries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = Arc::clone(&tries);
            *self.fake.on_close.lock().unwrap() = Some(OnClose(Box::new(move |_| {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            })));
            tries
        }

        /// Handles the exit of `id`'s shell as the watch does, until `stop`.
        fn exit_told(&self, id: &str, stop: &CancellationToken) -> tokio::task::JoinHandle<()> {
            let (shells, stop) = (Arc::clone(&self.shells), stop.clone());
            let exit = Exit {
                terminal_id: terminal(id),
                generation: 0,
            };
            TaskTracker::new().spawn(async move { shells.exited(exit, &stop).await })
        }
    }

    async fn until_tried(tries: &std::sync::atomic::AtomicUsize, times: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while tries.load(std::sync::atomic::Ordering::SeqCst) < times {
            assert!(
                Instant::now() < deadline,
                "tried {tries:?} times, never {times}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[test]
    fn tries_again_to_end_an_exited_shell_it_couldnt_saying_so_once_until_it_ends() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let tries = h.count_closes();
            h.fake.set(|state| state.fail_closes = true);
            let ending = h.exit_told(&id, &CancellationToken::new());
            until_tried(&tries, 3).await;
            let unended = h.shells.unended.lock().unwrap().clone();
            let left = h.state_of(&id);
            h.fake.set(|state| state.fail_closes = false);
            tokio::time::timeout(Duration::from_secs(5), ending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(unended, HashSet::from([format!("{id}:0")]));
            assert_eq!(left, Some(TerminalState::Closing));
            assert_eq!(h.state_of(&id), Some(TerminalState::Closed));
            assert!(h.shells.unended.lock().unwrap().is_empty());
            assert_eq!(said.times("could not end it after it exited"), 1);
        });
    }

    #[test]
    fn gives_up_at_once_ending_an_exited_shell_no_try_can_end_saying_so_once() {
        let h = setup(100);
        let said = Said::default();
        let _logging = said.logging();
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let tries = h.count_closes();
            let replaced = TerminalError::Stale("another holder answers".to_owned());
            h.fake.set(|state| state.closes_refused = Some(replaced));
            let ending = h.exit_told(&id, &CancellationToken::new());
            tokio::time::timeout(Duration::from_secs(5), ending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(tries.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert_eq!(h.state_of(&id), Some(TerminalState::Closing));
            // Nothing tries it again, so nothing is kept to say it once more.
            assert!(h.shells.unended.lock().unwrap().is_empty());
            assert_eq!(
                [
                    said.times("can't end it after it exited, so it stays closing"),
                    said.times("could not end it after it exited"),
                ],
                [1, 0]
            );
        });
    }

    #[test]
    fn stops_trying_to_end_an_exited_shell_once_the_daemon_stops() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let tries = h.count_closes();
            h.fake.set(|state| state.fail_closes = true);
            let stop = CancellationToken::new();
            let ending = h.exit_told(&id, &stop);
            until_tried(&tries, 1).await;
            stop.cancel();
            let ended = tokio::time::timeout(Duration::from_secs(5), ending).await;
            assert!(matches!(ended, Ok(Ok(()))), "{ended:?}");
            assert_eq!(h.state_of(&id), Some(TerminalState::Closing));
        });
    }

    #[test]
    fn tells_the_shell_a_paired_device_opens_or_restarts_which_device_that_was() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let phone = DeviceId::parse("dev_0190a1b2c3d47abc8def0123456789ad").unwrap();
            let opened = h
                .shells
                .open(&opening("by-phone"), Some(phone.clone()))
                .await
                .unwrap();
            let restarted = h
                .shells
                .restart(&lost, &restarting("r"), Some(phone.clone()))
                .await
                .unwrap();
            let device_of = |id: &TerminalId| {
                h.fake
                    .spec_of(id.as_str())
                    .env
                    .get("BAZHEN_DEVICE_ID")
                    .cloned()
            };
            assert_eq!(
                [
                    device_of(&opened.terminal_id),
                    device_of(&restarted.terminal_id)
                ],
                [
                    Some(phone.as_str().to_owned()),
                    Some(phone.as_str().to_owned())
                ]
            );
        });
    }

    #[test]
    fn restarts_as_a_new_standalone_shell_in_its_directory_and_in_its_theme() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let restarted = h
                .shells
                .restart(&lost, &restarting("r"), None)
                .await
                .unwrap();
            let new = restarted.terminal_id.as_str();
            let spec = h.fake.spec_of(new);
            assert_eq!(
                (h.state_of(&lost), h.state_of(new)),
                (Some(TerminalState::Closed), Some(TerminalState::Running))
            );
            assert_eq!(
                (spec.cwd, spec.linked_agent_id, spec.theme),
                (h.home.clone(), None, Some(TuiTheme::Light))
            );
            assert_eq!(h.listed().len(), 1);
        });
    }

    #[test]
    fn stays_lost_when_its_restart_fails_and_a_repeat_says_so_so_it_can_be_restarted_again() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            h.fake.set(|state| state.fail_creates = true);
            let failed = h.shells.restart(&lost, &restarting("r"), None).await;
            let repeated = h.shells.restart(&lost, &restarting("r"), None).await;
            let between = h.state_of(&lost);
            h.fake.set(|state| state.fail_creates = false);
            let again = h
                .shells
                .restart(&lost, &restarting("r2"), None)
                .await
                .unwrap();
            assert!(
                matches!(failed, Err(ShellError::OpenFailed(_))),
                "{failed:?}"
            );
            assert_eq!(repeated, failed);
            assert_eq!(between, Some(TerminalState::Lost));
            assert_eq!(
                (h.state_of(&lost), h.state_of(again.terminal_id.as_str())),
                (Some(TerminalState::Closed), Some(TerminalState::Running))
            );
        });
    }

    #[test]
    fn restarts_in_the_directory_it_was_last_seen_in_not_the_one_it_opened_in() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let moved = h.dir.path().join("moved");
            std::fs::create_dir(&moved).unwrap();
            let moved = moved.to_string_lossy().into_owned();
            h.seen_in(&lost, &moved).await;
            let restarted = h
                .shells
                .restart(&lost, &restarting("r"), None)
                .await
                .unwrap();
            assert_eq!(h.fake.spec_of(restarted.terminal_id.as_str()).cwd, moved);
        });
    }

    #[test]
    fn restarts_in_the_directory_it_opened_in_once_the_one_it_was_last_seen_in_is_gone() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let gone = h.dir.path().join("gone").to_string_lossy().into_owned();
            h.seen_in(&lost, &gone).await;
            let restarted = h
                .shells
                .restart(&lost, &restarting("r"), None)
                .await
                .unwrap();
            assert_eq!(h.fake.spec_of(restarted.terminal_id.as_str()).cwd, h.home);
        });
    }

    #[test]
    fn fails_a_restart_whose_last_directory_cant_be_read_rather_than_pass_it_over() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            // A link to itself, which no stat can follow: neither gone nor a file, but unreadable.
            let looped = h.dir.path().join("looped");
            std::os::unix::fs::symlink(&looped, &looped).unwrap();
            h.seen_in(&lost, &looped.to_string_lossy()).await;
            let failed = h.shells.restart(&lost, &restarting("r"), None).await;
            assert!(
                matches!(&failed, Err(ShellError::Internal(why)) if why.contains("can't be read")),
                "{failed:?}"
            );
            assert_eq!(h.state_of(&lost), Some(TerminalState::Lost));
        });
    }

    #[test]
    fn refuses_to_type_back_a_line_the_lost_shell_kept_none_of() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let req = RestartShellRequest {
                retype: Some(true),
                ..restarting("r")
            };
            let refused = h.shells.restart(&lost, &req, None).await;
            assert_eq!(
                refused,
                Err(ShellError::Conflict(format!(
                    "shell {lost} is lost with no last command kept"
                )))
            );
            assert_eq!(h.state_of(&lost), Some(TerminalState::Lost));
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn closes_a_lost_shell_reaching_no_terminal_since_none_is_left() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Dark).await;
            h.shells.close(&lost, &closing("c", 0)).await.unwrap();
            assert_eq!(h.state_of(&lost), Some(TerminalState::Closed));
            assert_eq!(h.fake.state.lock().unwrap().closed, Vec::<String>::new());
        });
    }

    #[test]
    fn shows_the_name_given_and_none_once_it_is_taken_away() {
        let h = setup(100);
        runtime().block_on(async {
            let id = h.open("open").await.unwrap();
            let rename = |key: &str, name: Option<&str>| RenameShellRequest {
                idempotency_key: key.to_owned(),
                name: name.map(str::to_owned),
            };
            h.shells
                .rename(&id, &rename("n1", Some("dev server")))
                .await
                .unwrap();
            let named = h.listed()[0].name.clone();
            h.shells.rename(&id, &rename("n2", None)).await.unwrap();
            assert_eq!(
                (named, h.listed()[0].name.clone()),
                (Some("dev server".to_owned()), None)
            );
        });
    }

    #[test]
    fn refuses_a_shell_past_the_budget_recording_none() {
        let h = setup(1);
        runtime().block_on(async {
            h.open("a").await.unwrap();
            let refused = h.open("b").await;
            assert!(matches!(refused, Err(ShellError::Limit(_))), "{refused:?}");
            assert_eq!(h.listed().len(), 1);
        });
    }

    #[test]
    fn admits_only_one_of_two_shells_racing_for_the_last_slot() {
        let h = setup(1);
        runtime().block_on(async {
            let both = tokio::join!(h.open("a"), h.open("b"));
            let refused = [&both.0, &both.1]
                .into_iter()
                .filter(|opened| matches!(opened, Err(ShellError::Limit(_))))
                .count();
            let opened = [&both.0, &both.1]
                .into_iter()
                .filter(|opened| opened.is_ok())
                .count();
            assert_eq!((opened, refused), (1, 1), "{both:?}");
        });
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn gives_a_shells_slot_back_once_it_is_closed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let h = setup(1);
        runtime().block_on(async {
            let id = h.open("a").await.unwrap();
            h.shells.close(&id, &closing("c", 0)).await.unwrap();
            assert!(h.open("b").await.is_ok());
        });
    }

    #[test]
    fn gives_a_shells_slot_back_once_its_shell_exits() {
        let h = setup(1);
        runtime().block_on(async {
            let id = h.open("a").await.unwrap();
            let stop = h.watch();
            h.fake.exit(&id);
            h.until(&id, TerminalState::Closed).await;
            stop.cancel();
            assert!(h.open("b").await.is_ok());
        });
    }

    #[test]
    fn gives_a_shells_slot_back_when_it_fails_to_open() {
        let h = setup(1);
        runtime().block_on(async {
            h.fake.set(|state| state.fail_creates = true);
            let failed = h.open("a").await;
            h.fake.set(|state| state.fail_creates = false);
            assert!(
                matches!(failed, Err(ShellError::OpenFailed(_))),
                "{failed:?}"
            );
            assert!(h.open("b").await.is_ok());
        });
    }

    #[test]
    fn restarts_a_lost_shell_into_the_slot_it_gave_back_and_refuses_one_with_none_left() {
        let (roomy, full) = (setup(1), setup(1));
        runtime().block_on(async {
            let roomy_lost = roomy.lost(TuiTheme::Light).await;
            let full_lost = full.lost(TuiTheme::Light).await;
            full.open("fills-the-slot").await.unwrap();
            let restarted = roomy
                .shells
                .restart(&roomy_lost, &restarting("r"), None)
                .await;
            let refused = full
                .shells
                .restart(&full_lost, &restarting("r"), None)
                .await;
            assert!(restarted.is_ok(), "{restarted:?}");
            assert!(matches!(refused, Err(ShellError::Limit(_))), "{refused:?}");
            assert_eq!(full.state_of(&full_lost), Some(TerminalState::Lost));
        });
    }

    /// Creates wait until the test lets each through.
    fn held(h: &Harness) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        h.fake
            .set(|state| state.hold_creates = Some(Arc::clone(&gate)));
        gate
    }

    /// Asks for `command` and stops waiting for its answer while its create is held.
    async fn gone_mid_command<F>(h: &Harness, command: impl FnOnce(Arc<Shells>) -> F)
    where
        F: Future<Output = Result<ShellCommandResponse, ShellError>> + Send + 'static,
    {
        let asked = h.shells.completing(command);
        let answered = tokio::time::timeout(Duration::from_millis(50), asked).await;
        assert!(answered.is_err(), "{answered:?}");
    }

    #[test]
    fn records_running_a_shell_whose_caller_went_away_while_it_opened() {
        let h = setup(100);
        runtime().block_on(async {
            let gate = held(&h);
            gone_mid_command(&h, |shells| async move {
                shells.open(&opening("o"), None).await
            })
            .await;
            gate.add_permits(1);
            let id = h.listed()[0].id.as_str().to_owned();
            h.until(&id, TerminalState::Running).await;
            assert_eq!(h.open("o").await, Ok(id));
        });
    }

    #[test]
    fn closes_the_lost_shell_of_a_restart_whose_caller_went_away_while_it_opened() {
        let h = setup(100);
        runtime().block_on(async {
            let lost = h.lost(TuiTheme::Light).await;
            let gate = held(&h);
            let old = lost.clone();
            gone_mid_command(&h, |shells| async move {
                shells.restart(&old, &restarting("r"), None).await
            })
            .await;
            gate.add_permits(1);
            h.until(&lost, TerminalState::Closed).await;
            let listed = h.listed();
            assert_eq!(
                listed.iter().map(|shell| shell.state).collect::<Vec<_>>(),
                [TerminalState::Running]
            );
        });
    }

    #[test]
    fn closes_a_shell_whose_shell_exits_before_its_start_has_answered() {
        let h = setup(100);
        runtime().block_on(async {
            h.fake.set(|state| state.exit_as_created = true);
            let stop = h.watch();
            let id = h.open("o").await.unwrap();
            h.until(&id, TerminalState::Closed).await;
            stop.cancel();
            assert!(!h.fake.carries(&id));
        });
    }

    #[test]
    fn answers_each_runtime_failure_in_the_words_a_shells_command_says_it() {
        let id = "term_x";
        assert_eq!(
            [
                from_runtime(id, TerminalError::Stale("moved".to_owned())),
                from_runtime(
                    id,
                    TerminalError::Unservable {
                        protocol: vec!["holder/2.0".to_owned()],
                        holder_pid: Some(42),
                    }
                ),
                from_runtime(
                    id,
                    TerminalError::Unservable {
                        protocol: vec!["holder/2.0".to_owned(), "holder/3.0".to_owned()],
                        holder_pid: None,
                    }
                ),
                from_runtime(id, TerminalError::Unconfirmed("gone".to_owned())),
            ],
            [
                ShellError::Conflict(
                    "shell term_x's terminal is not the one recorded; its server or pane has changed".to_owned()
                ),
                ShellError::NeedsRestart(
                    "shell term_x's terminal runs on a holder that speaks only holder/2.0, which this version of Bazhen doesn't, so it can't be closed from here: its holder, pid 42, keeps running until its process is ended. Once it has, close it again, or relaunch it.".to_owned()
                ),
                ShellError::NeedsRestart(
                    "shell term_x's terminal runs on a holder that speaks only holder/2.0, holder/3.0, which this version of Bazhen doesn't, so it can't be closed from here: its holder keeps running until its process is ended. Once it has, close it again, or relaunch it.".to_owned()
                ),
                ShellError::ServerUnconfirmed(
                    "shell term_x's terminal is no longer where it ran, but what ran it may still be running it; close it with force to record it closed anyway".to_owned()
                ),
            ]
        );
    }
}
