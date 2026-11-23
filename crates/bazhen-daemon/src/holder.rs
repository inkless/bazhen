//! The daemon's terminals on `bazhen-holder`, as `main.ts` sets them up with
//! `terminals/holder.ts`, `terminals/containment.ts` and `terminals/runtimes.ts`: the build new
//! holders run, installed where it can't be written over, the runtime over it, and what `bazhen
//! doctor` says of both.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use bazhen_holder_proto::body::{Cols, Count, Generation, HistoryLines, Rows, Size, Theme};
use bazhen_host_guard::holder::{HolderProcess, is_vouchable};
use bazhen_host_guard::scope::{self, CapsRefused, MIN_SYSTEMD, TERMINALS_SLICE};
use bazhen_protocol::daemon::{
    Containment, Holder as HolderReport, HolderStats, MemoryCap, RunningHolder,
    RuntimeHealthReport, RuntimeReportState,
};
use bazhen_protocol::ids::TerminalId;
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::record::Record;
use bazhen_protocol::shells::TuiTheme;
use bazhen_protocol::terminals::TerminalScreen;
use bazhen_runtime_holder::{
    HealthState, HolderBuild, HolderLocator, HolderRef, HolderRuntime, InstallOptions,
    InstalledHolder, ProcessLaunch, RuntimeError, RuntimeEvent, StaleReason, TerminalSpec,
    TerminalTags,
};
use tokio::sync::broadcast;

use crate::config::RuntimeKind;
use crate::terminals::{
    Answer, Compatibility, Event, Events, Exit, FoundShell, Recorded, ShellForeground, ShellSpec,
    TerminalError, Terminals,
};

/// The size a terminal starts at, until a view attaches and sets its own (`DEFAULT_SIZE`).
const COLS: u64 = 120;
const ROWS: u64 = 40;

/// The most of a failure's text an answer carries (`DETAIL_MAX` in `commands.ts`).
const DETAIL_MAX: usize = 500;

/// Where `moon run :build` puts the holder beside this daemon: `target/release-holder`, beside
/// `target/release`, which this binary runs from.
pub(crate) fn holder_source(exe: &Path) -> PathBuf {
    exe.parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("/"))
        .join("release-holder")
        .join("bazhen-holder")
}

/// The build new holders run, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Install {
    Installed(InstalledHolder),
    None(String),
}

impl Install {
    pub(crate) fn installed(&self) -> Option<&InstalledHolder> {
        match self {
            Self::Installed(installed) => Some(installed),
            Self::None(_) => None,
        }
    }

    pub(crate) fn reason(&self) -> Option<&str> {
        match self {
            Self::Installed(_) => None,
            Self::None(reason) => Some(reason),
        }
    }
}

/// Installs the holder built at `source` under `state`, then removes the builds no process
/// runs, saying which; a failure is said, and leaves only new terminals unable to start.
pub(crate) fn install(source: PathBuf, state: &Path, uid: u32) -> Install {
    let dir = state.join("holder");
    let install =
        match bazhen_runtime_holder::install_holder(&InstallOptions::new(source, dir.clone(), uid))
        {
            Ok(installed) => Install::Installed(installed),
            Err(err) => {
                tracing::warn!("no holder: {err}");
                Install::None(err.to_string())
            }
        };
    let removed = bazhen_runtime_holder::prune_unused_holders(&dir, uid, install.installed());
    if !removed.is_empty() {
        tracing::info!(
            "removed holder builds no process runs: {}",
            removed.join(", ")
        );
    }
    install
}

/// Why the daemon can't start with `runtime.default` as configured, or `None` when it can. Every
/// new terminal goes to the default runtime: a holder, which can't start with no build installed;
/// and this daemon runs no tmux (`defaultRuntimeRefusal` in `runtimes.ts`, which takes tmux).
pub(crate) fn default_runtime_refusal(
    default: RuntimeKind,
    install: &Install,
    config_path: &str,
) -> Option<String> {
    match (default, install) {
        (RuntimeKind::Holder, Install::Installed(_)) => None,
        (RuntimeKind::Holder, Install::None(reason)) => Some(format!(
            "no holder can be started for new terminals: {reason}. To run them on tmux instead, set runtime.default = \"tmux\" in {config_path}"
        )),
        (RuntimeKind::Tmux, _) => Some(format!(
            "this daemon runs new terminals on bazhen-holder only, not tmux: set runtime.default = \"holder\" in {config_path}"
        )),
    }
}

/// What `bazhen doctor` says of holders: the build installed, and each holder that answers.
pub(crate) fn holder_doctor(install: &Install, holders: Vec<RunningHolder>) -> HolderReport {
    let installed = install.installed();
    HolderReport {
        binary: installed.map(|i| i.binary.to_string_lossy().into_owned()),
        build: installed.map(|i| i.build.clone()),
        reason: install.reason().map(str::to_owned),
        holders,
    }
}

/// A holder as `bazhen doctor` lists it.
fn running_holder(build: HolderBuild) -> RunningHolder {
    RunningHolder {
        terminal_id: build.terminal_id.as_str().to_owned(),
        build: build.build,
        protocol: build
            .protocol
            .as_slice()
            .iter()
            .map(|v| v.as_str().to_owned())
            .collect(),
        contained: build.contained.map_or(Nullable::Null, Nullable::Value),
        socket: Some(build.socket.to_string_lossy().into_owned()),
        holder_pid: build
            .holder_pid
            .map_or(Nullable::Null, |pid| Nullable::Value(pid.get())),
        stats: build.stats.map_or(Nullable::Null, |s| {
            Nullable::Value(HolderStats {
                engine_bytes: s.engine_bytes.get(),
                rss: s.rss.map(bazhen_holder_proto::body::Bounded::get),
                ring_bytes: s.ring_bytes.get(),
                history_lines: s.history_lines.get(),
                engine_resets: s.engine_resets.map(bazhen_holder_proto::body::Bounded::get),
            })
        }),
    }
}

/// What `bazhen doctor` says of containment: unchecked until a holder terminal has needed it.
/// Caps refused before anything ran leave terminals uncontained, said with why.
pub(crate) fn containment_doctor(
    containment: Option<&Result<scope::Containment, CapsRefused>>,
) -> Containment {
    match containment {
        None => Containment::Unchecked,
        Some(Err(refused)) => Containment::Uncontained {
            why: refused.to_string(),
        },
        Some(Ok(scope::Containment::Uncontained { why })) => {
            Containment::Uncontained { why: why.clone() }
        }
        Some(Ok(scope::Containment::Scoped(scoped))) => Containment::Scoped {
            systemd: u64::from(scoped.systemd),
            oom_policy: scoped.oom_policy,
            terminal: MemoryCap {
                asked: scoped.caps.terminal.clone(),
                bytes: scoped.enforced.terminal,
            },
            total: MemoryCap {
                asked: scoped.caps.total.clone(),
                bytes: scoped.enforced.total,
            },
            swap: MemoryCap {
                asked: scoped.caps.swap.clone(),
                bytes: scoped.enforced.swap,
            },
        },
    }
}

/// What the daemon says of containment once it is decided, and whether it is a warning.
pub(crate) fn containment_log(containment: &Containment) -> Option<(bool, String)> {
    match containment {
        Containment::Unchecked => None,
        Containment::Uncontained { why } => {
            Some((true, format!("holder terminals are not contained: {why}")))
        }
        Containment::Scoped {
            systemd,
            oom_policy,
            terminal,
            total,
            swap,
        } => {
            let oom = if *oom_policy {
                String::new()
            } else {
                format!(
                    "; systemd {systemd} predates OOMPolicy for scopes ({MIN_SYSTEMD}), so the kernel alone decides what dies past a cap"
                )
            };
            Some((
                !oom_policy,
                format!(
                    "holder terminals each start in a scope of their own in {TERMINALS_SLICE}, at most {} each with {} of swap, and {} together{oom}",
                    terminal.text(),
                    swap.text(),
                    total.text()
                ),
            ))
        }
    }
}

/// A failure's own text, cut to what an answer carries, ending `…` where it was cut
/// (`failureDetail` in `commands.ts`): its message alone, as an `Error`'s, not its causes'. It is
/// cut by characters, where TypeScript cuts by grapheme clusters, and not yet redacted as
/// `failureDetail` redacts: that needs its JavaScript patterns ported, a change of its own.
fn detail(err: &dyn std::error::Error) -> String {
    let text = err.to_string();
    if text.chars().count() <= DETAIL_MAX {
        return text;
    }
    let mut cut: String = text.chars().take(DETAIL_MAX - 1).collect();
    cut.push('…');
    cut
}

/// The runtime's failure in the kinds a command answers differently.
fn terminal_error(err: &RuntimeError) -> TerminalError {
    match err {
        RuntimeError::Stale {
            reason: StaleReason::Gone,
            ..
        } => TerminalError::Gone(detail(err)),
        RuntimeError::Stale { .. } => TerminalError::Stale(detail(err)),
        RuntimeError::ProcessState { .. } => TerminalError::ProcessState(detail(err)),
        RuntimeError::Unservable {
            protocol,
            holder_pid,
            ..
        } => TerminalError::Unservable {
            protocol: protocol
                .iter()
                .flat_map(|v| v.as_slice().iter().map(|t| t.as_str().to_owned()))
                .collect(),
            holder_pid: Some(*holder_pid),
        },
        RuntimeError::Unconfirmed { .. } => TerminalError::Unconfirmed(detail(err)),
        RuntimeError::Unreachable { .. } => TerminalError::Unreachable(detail(err)),
        RuntimeError::Predates { what, .. } => TerminalError::Predates {
            what: (*what).to_owned(),
        },
        RuntimeError::ScreenUnreadable { reason, .. } => TerminalError::Unreadable {
            reason: reason.clone(),
        },
        _ => TerminalError::Other(detail(err)),
    }
}

/// The terminal a store's record names, as the runtime acts on it.
fn holder_ref(terminal: &Recorded) -> Result<HolderRef, TerminalError> {
    let locator = HolderLocator::decode(&terminal.locator)
        .map_err(|e| TerminalError::Stale(e.to_string()))?;
    Ok(HolderRef {
        terminal_id: terminal.terminal_id.clone(),
        locator,
    })
}

/// The incarnation `terminal` names, as the store records it; `None` for one whose socket's path
/// isn't UTF-8, as no holder's is.
fn recorded_of(terminal: &HolderRef) -> Option<Recorded> {
    Some(Recorded {
        terminal_id: terminal.terminal_id.clone(),
        locator: terminal.locator.encode().ok()?,
    })
}

/// A program's name as a shell's foreground shows it: `None` for the shell's own process, and a
/// login shell's without the leading dash it may be named with, as `-fish`.
fn program(command: &str, own: bool) -> Option<String> {
    (!own).then(|| command.strip_prefix('-').unwrap_or(command).to_owned())
}

fn theme(theme: TuiTheme) -> Theme {
    match theme {
        TuiTheme::Light => Theme::Light,
        TuiTheme::Dark => Theme::Dark,
    }
}

/// The runtime over every holder this daemon starts or finds.
#[derive(Debug)]
pub(crate) struct Holder {
    runtime: Arc<HolderRuntime>,
    history_lines: u32,
    /// Whether containment has been said, once the first start decided it.
    told_containment: AtomicBool,
    /// What each receiver of its events keeps of the processes told running, which a close
    /// forgets.
    told: Mutex<Vec<Weak<Respawned>>>,
}

impl Holder {
    pub(crate) fn new(runtime: HolderRuntime, history_lines: u32) -> Self {
        Self {
            runtime: Arc::new(runtime),
            history_lines,
            told_containment: AtomicBool::new(false),
            told: Mutex::new(Vec::new()),
        }
    }

    /// Forgets `terminal_id` in what each receiver of its events keeps, once it is closed.
    fn forget(&self, terminal_id: &TerminalId) {
        let mut told = self.told.lock().unwrap_or_else(PoisonError::into_inner);
        told.retain(|kept| {
            kept.upgrade().is_some_and(|kept| {
                kept.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(terminal_id);
                true
            })
        });
    }

    /// A receiver of its events from now on.
    fn told(&self) -> HolderTold {
        let respawned = Arc::new(Mutex::new(HashMap::new()));
        self.told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Arc::downgrade(&respawned));
        let runtime = Arc::clone(&self.runtime);
        HolderTold {
            told: self.runtime.events(),
            respawned,
            reread: Reread(Box::new(move || {
                let runtime = Arc::clone(&runtime);
                Box::pin(async move {
                    let found = runtime.inventory().await.map_err(|e| detail(&e))?;
                    Ok(found.into_iter().map(|entry| entry.terminal).collect())
                })
            })),
        }
    }

    fn spec(&self, spec: ShellSpec) -> Result<TerminalSpec, TerminalError> {
        let invalid = |e: bazhen_holder_proto::body::Invalid| TerminalError::Other(e.to_string());
        Ok(TerminalSpec {
            terminal_id: spec.terminal_id,
            tags: TerminalTags::Shell {
                linked_agent_id: spec.linked_agent_id,
            },
            size: Size {
                cols: Cols::new(COLS).map_err(invalid)?,
                rows: Rows::new(ROWS).map_err(invalid)?,
            },
            history_lines: HistoryLines::new(u64::from(self.history_lines)).map_err(invalid)?,
            process: ProcessLaunch {
                argv: spec.argv,
                cwd: spec.cwd,
                env: spec.env,
                generation: Generation::new(0).map_err(invalid)?,
                theme: spec.theme.map(theme),
            },
        })
    }

    /// Says what the first start decided of containment, once.
    fn tell_containment(&self) {
        let decided = containment_doctor(self.runtime.containment());
        let Some((warn, message)) = containment_log(&decided) else {
            return;
        };
        if self.told_containment.swap(true, Ordering::Relaxed) {
            return;
        }
        if warn {
            tracing::warn!("bazhen: {message}");
        } else {
            tracing::info!("bazhen: {message}");
        }
    }
}

/// The process each terminal was last told running since the daemon started it, or read running
/// once a receiver fell behind, which an exit at that generation names.
type Respawned = Mutex<HashMap<TerminalId, HolderRef>>;

/// Reads again what runs in each terminal, for a receiver that fell behind what it was told.
struct Reread(Box<dyn Fn() -> Answer<'static, Result<Vec<HolderRef>, String>> + Send>);

impl std::fmt::Debug for Reread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Reread")
    }
}

/// The events a holder runtime tells.
#[derive(Debug)]
struct HolderTold {
    told: broadcast::Receiver<RuntimeEvent>,
    respawned: Arc<Respawned>,
    reread: Reread,
}

impl HolderTold {
    fn respawned(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalId, HolderRef>> {
        self.respawned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The process of `generation` the terminal was told running, if it was.
    fn ended(&self, terminal_id: &TerminalId, generation: Generation) -> Option<Recorded> {
        let mut respawned = self.respawned();
        let told = respawned.get(terminal_id)?;
        if told.locator.generation != Some(generation) {
            return None;
        }
        recorded_of(&respawned.remove(terminal_id)?)
    }
}

impl Events for HolderTold {
    fn next(&mut self) -> Answer<'_, Option<Event>> {
        Box::pin(async move {
            loop {
                match self.told.recv().await {
                    Ok(RuntimeEvent::Exited {
                        terminal_id,
                        generation,
                        ..
                    }) => {
                        let found = self.ended(&terminal_id, generation);
                        return Some(Event::Exited(Exit {
                            terminal_id,
                            generation: generation.get(),
                            found,
                        }));
                    }
                    Ok(RuntimeEvent::Respawned { terminal }) => {
                        if let Some(recorded) = recorded_of(&terminal) {
                            self.respawned()
                                .insert(terminal.terminal_id.clone(), terminal);
                            return Some(Event::Respawned(recorded));
                        }
                    }
                    Ok(RuntimeEvent::Lost { terminal }) => {
                        self.respawned().remove(&terminal.terminal_id);
                        if let Some(recorded) = recorded_of(&terminal) {
                            return Some(Event::Lost(recorded));
                        }
                    }
                    // What each terminal runs is read again, so an exit told after a respawn
                    // missed while behind still names its process. Any other event missed is
                    // seen again by what reads the terminal next: a close finds what is left of
                    // it.
                    Err(broadcast::error::RecvError::Lagged(_)) => match (self.reread.0)().await {
                        Ok(found) => self.respawned().extend(
                            found
                                .into_iter()
                                .map(|terminal| (terminal.terminal_id.clone(), terminal)),
                        ),
                        Err(err) => tracing::warn!(
                            "bazhen: holder events were missed, and what runs each terminal couldn't be read again: {err}"
                        ),
                    },
                    // A title isn't followed yet.
                    Ok(RuntimeEvent::Title { .. }) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
    }
}

impl Terminals for Holder {
    fn create(&self, spec: ShellSpec) -> Answer<'_, Result<Record<String>, TerminalError>> {
        Box::pin(async move {
            let spec = self.spec(spec)?;
            let created = self.runtime.create(spec).await;
            self.tell_containment();
            let created = created.map_err(|e| terminal_error(&e))?;
            let text = created
                .locator
                .encode()
                .map_err(|e| TerminalError::Other(e.to_string()))?;
            serde_json::from_str(&text).map_err(|e| TerminalError::Other(e.to_string()))
        })
    }

    fn close<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>> {
        Box::pin(async move {
            let terminal = holder_ref(terminal)?;
            self.runtime
                .close(&terminal)
                .await
                .map_err(|e| terminal_error(&e))?;
            self.forget(&terminal.terminal_id);
            Ok(())
        })
    }

    fn foreground<'a>(
        &'a self,
        terminal: &'a Recorded,
    ) -> Answer<'a, Result<Option<String>, TerminalError>> {
        Box::pin(async move {
            let terminal = holder_ref(terminal)?;
            let found = self
                .runtime
                .foreground(&terminal)
                .await
                .map_err(|e| terminal_error(&e))?;
            Ok(program(&found.command, found.own))
        })
    }

    fn paste<'a>(
        &'a self,
        terminal: &'a Recorded,
        text: &'a str,
        brackets: bool,
    ) -> Answer<'a, Result<(), TerminalError>> {
        Box::pin(async move {
            let terminal = holder_ref(terminal)?;
            self.runtime
                .paste(&terminal, text, brackets)
                .await
                .map_err(|e| terminal_error(&e))
        })
    }

    fn screen<'a>(
        &'a self,
        terminal: &'a Recorded,
        history: u32,
    ) -> Answer<'a, Result<TerminalScreen, TerminalError>> {
        Box::pin(async move {
            let terminal = holder_ref(terminal)?;
            let history =
                Count::new(u64::from(history)).map_err(|e| TerminalError::Other(e.to_string()))?;
            let read = self
                .runtime
                .screen(&terminal, history)
                .await
                .map_err(|e| terminal_error(&e))?;
            Ok(TerminalScreen {
                text: read.text().to_owned(),
                history: read.history().get(),
            })
        })
    }

    fn foregrounds<'a>(
        &'a self,
        terminals: &'a [Recorded],
    ) -> Answer<'a, Result<Vec<ShellForeground>, TerminalError>> {
        Box::pin(async move {
            let asked: HashSet<TerminalId> =
                terminals.iter().map(|t| t.terminal_id.clone()).collect();
            let read = self
                .runtime
                .foregrounds(&asked)
                .await
                .map_err(|e| terminal_error(&e))?;
            Ok(read
                .into_iter()
                .filter_map(|(terminal, found)| {
                    Some(ShellForeground {
                        terminal: recorded_of(&terminal)?,
                        command: program(&found.command, found.own),
                        cwd: found.cwd.and_then(|cwd| cwd.to_str().map(str::to_owned)),
                    })
                })
                .collect())
        })
    }

    fn health(&self) -> Answer<'_, RuntimeHealthReport> {
        Box::pin(async move {
            // No terminal recorded is named: one named whose socket is gone would be told to bind
            // it again, which only `reachable`, as reconcile reads the shells, does.
            let health = self.runtime.health(&[]).await;
            RuntimeHealthReport {
                kind: "holder".to_owned(),
                state: match health.state {
                    HealthState::Healthy => RuntimeReportState::Healthy,
                    HealthState::NotRunning => RuntimeReportState::NotRunning,
                    HealthState::Unreachable => RuntimeReportState::Unreachable,
                },
                version: Some(health.version),
                workarounds: None,
            }
        })
    }

    fn reachable<'a>(&'a self, recorded: &'a [Recorded]) -> Answer<'a, bool> {
        Box::pin(async move {
            let known: Vec<HolderRef> =
                recorded.iter().filter_map(|r| holder_ref(r).ok()).collect();
            self.runtime.health(&known).await.state != HealthState::Unreachable
        })
    }

    fn shells(&self) -> Answer<'_, Result<Vec<FoundShell>, TerminalError>> {
        Box::pin(async move {
            let found = self
                .runtime
                .inventory()
                .await
                .map_err(|e| terminal_error(&e))?;
            Ok(found
                .into_iter()
                .filter_map(|entry| match entry.tags {
                    TerminalTags::Shell { linked_agent_id } => Some(FoundShell {
                        terminal: recorded_of(&entry.terminal)?,
                        dead: entry.exit.is_some(),
                        linked_agent_id,
                    }),
                    TerminalTags::Agent { .. } => None,
                })
                .collect())
        })
    }

    fn gone<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, bool> {
        Box::pin(async move {
            // A locator that can't be read proves nothing gone.
            match holder_ref(terminal) {
                Ok(terminal) => self.runtime.gone(&terminal).await,
                Err(_) => false,
            }
        })
    }

    fn unlink<'a>(&'a self, terminal: &'a Recorded) -> Answer<'a, Result<(), TerminalError>> {
        Box::pin(async move {
            let terminal = holder_ref(terminal)?;
            self.runtime
                .unlink(&terminal)
                .await
                .map_err(|e| terminal_error(&e))
        })
    }

    fn compatibility(&self) -> Answer<'_, Result<Compatibility, TerminalError>> {
        Box::pin(async move {
            let read = self
                .runtime
                .compatibility()
                .await
                .map_err(|e| terminal_error(&e))?;
            Ok(Compatibility {
                outdated: read
                    .outdated
                    .into_iter()
                    .map(|(id, protocol)| (id.as_str().to_owned(), protocol))
                    .collect(),
                served: read
                    .served
                    .into_iter()
                    .map(|id| id.as_str().to_owned())
                    .collect(),
            })
        })
    }

    fn vouches(&self, pid: u64, start: u64) -> bool {
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        is_vouchable(HolderProcess { pid, start })
    }

    fn holders(&self) -> Answer<'_, Result<Vec<RunningHolder>, String>> {
        Box::pin(async move {
            let builds = self.runtime.builds().await.map_err(|e| detail(&e))?;
            Ok(builds.into_iter().map(running_holder).collect())
        })
    }

    fn containment(&self) -> Containment {
        containment_doctor(self.runtime.containment())
    }

    fn events(&self) -> Box<dyn Events> {
        Box::new(self.told())
    }

    fn shutdown(&self) -> Answer<'_, ()> {
        Box::pin(self.runtime.shutdown())
    }
}

/// Each runtime's health as the TypeScript daemon lists its routed runtimes: tmux, then the
/// holder (`healthOfEach` over `[tmux, holder]`). Tmux is never read here: this daemon starts
/// nothing on it and follows nothing a TypeScript daemon left on it, so it is unused.
pub(crate) fn routed(holder: RuntimeHealthReport) -> Vec<RuntimeHealthReport> {
    let tmux = RuntimeHealthReport {
        kind: "tmux".to_owned(),
        state: RuntimeReportState::Unused,
        version: None,
        workarounds: None,
    };
    vec![tmux, holder]
}

/// The environment every new terminal starts from, as a holder takes it: text only.
pub(crate) fn runtime_env(env: &crate::env::Env) -> BTreeMap<String, String> {
    env.iter()
        .filter_map(|(name, value)| Some((name.to_str()?.to_owned(), value.to_str()?.to_owned())))
        .collect()
}

#[cfg(test)]
mod tests {
    use bazhen_host_guard::scope::{Enforced, Scoped, TerminalCaps};

    use super::*;

    const GIB: u64 = 1 << 30;

    fn scoped(systemd: u32) -> scope::Containment {
        scope::Containment::Scoped(Scoped {
            systemd,
            oom_policy: systemd >= 253,
            caps: TerminalCaps {
                terminal: "50%".to_owned(),
                total: "infinity".to_owned(),
                swap: "0".to_owned(),
            },
            enforced: Enforced {
                terminal: Some(31 * GIB),
                total: None,
                swap: Some(0),
            },
            systemd_run: PathBuf::from("/usr/bin/systemd-run"),
            runtime_dir: "/run/user/1000".into(),
        })
    }

    fn installed() -> InstalledHolder {
        InstalledHolder {
            binary: PathBuf::from("/s/holder/0123456789abcdef/bazhen-holder"),
            build: "0123456789abcdef".to_owned(),
            install_dir: PathBuf::from("/s/holder"),
        }
    }

    #[test]
    fn refuses_the_holder_default_with_no_build_installed_saying_why_and_how_to_use_tmux() {
        let none = Install::None("no build at target/release-holder".to_owned());
        assert_eq!(
            default_runtime_refusal(RuntimeKind::Holder, &none, "/c/config.toml").as_deref(),
            Some(
                "no holder can be started for new terminals: no build at target/release-holder. To run them on tmux instead, set runtime.default = \"tmux\" in /c/config.toml"
            )
        );
    }

    #[test]
    fn starts_with_a_build_installed_and_refuses_tmux_which_it_doesnt_run() {
        let built = Install::Installed(installed());
        assert_eq!(
            default_runtime_refusal(RuntimeKind::Holder, &built, "/c/config.toml"),
            None
        );
        assert_eq!(
            default_runtime_refusal(RuntimeKind::Tmux, &built, "/c/config.toml").as_deref(),
            Some(
                "this daemon runs new terminals on bazhen-holder only, not tmux: set runtime.default = \"holder\" in /c/config.toml"
            )
        );
    }

    #[test]
    fn names_the_installed_build_and_the_build_each_answering_holder_runs() {
        let held = RunningHolder {
            terminal_id: "term_a".to_owned(),
            build: Some("fedcba9876543210".to_owned()),
            protocol: vec!["1.2".to_owned()],
            contained: Nullable::Value(true),
            socket: Some("/run/holders/term_a.sock".to_owned()),
            holder_pid: Nullable::Value(4242),
            stats: Nullable::Null,
        };
        assert_eq!(
            holder_doctor(&Install::Installed(installed()), vec![held.clone()]),
            HolderReport {
                binary: Some("/s/holder/0123456789abcdef/bazhen-holder".to_owned()),
                build: Some("0123456789abcdef".to_owned()),
                reason: None,
                holders: vec![held],
            }
        );
    }

    #[test]
    fn says_why_nothing_is_installed_with_no_holder_to_ask() {
        assert_eq!(
            holder_doctor(&Install::None("not built".to_owned()), Vec::new()),
            HolderReport {
                binary: None,
                build: None,
                reason: Some("not built".to_owned()),
                holders: Vec::new(),
            }
        );
    }

    #[test]
    fn names_each_cap_as_configured_and_as_the_kernel_enforces_it() {
        assert_eq!(
            containment_doctor(Some(&Ok(scoped(255)))),
            Containment::Scoped {
                systemd: 255,
                oom_policy: true,
                terminal: MemoryCap {
                    asked: "50%".to_owned(),
                    bytes: Some(31 * GIB)
                },
                total: MemoryCap {
                    asked: "infinity".to_owned(),
                    bytes: None
                },
                swap: MemoryCap {
                    asked: "0".to_owned(),
                    bytes: Some(0)
                },
            }
        );
    }

    #[test]
    fn says_why_terminals_arent_contained_and_nothing_of_how_systemd_would_be_reached() {
        let uncontained = scope::Containment::Uncontained {
            why: "darwin has no cgroups".to_owned(),
        };
        assert_eq!(
            containment_doctor(Some(&Ok(uncontained))),
            Containment::Uncontained {
                why: "darwin has no cgroups".to_owned()
            }
        );
    }

    #[test]
    fn says_caps_refused_before_anything_ran_leave_terminals_uncontained() {
        let refused = CapsRefused {
            caps: TerminalCaps {
                terminal: "lots".to_owned(),
                total: "infinity".to_owned(),
                swap: "0".to_owned(),
            },
            why: "lots is not a size",
        };
        assert!(matches!(
            containment_doctor(Some(&Err(refused))),
            Containment::Uncontained { why } if why.ends_with(": lots is not a size")
        ));
    }

    #[test]
    fn says_it_hasnt_checked_before_any_holder_terminal_needed_it() {
        assert_eq!(containment_doctor(None), Containment::Unchecked);
    }

    #[test]
    fn names_the_slice_and_every_cap_in_gib() {
        assert_eq!(
            containment_log(&containment_doctor(Some(&Ok(scoped(255))))),
            Some((
                false,
                "holder terminals each start in a scope of their own in bazhen-terminals.slice, at most 50% (31.0 GiB) each with 0 (none) of swap, and infinity (no cap) together".to_owned()
            ))
        );
    }

    #[test]
    fn warns_that_before_systemd_253_the_kernel_alone_decides_what_dies_past_a_cap() {
        let (warn, message) = containment_log(&containment_doctor(Some(&Ok(scoped(252))))).unwrap();
        assert!(warn);
        assert!(
            message.contains("systemd 252 predates OOMPolicy for scopes (253)"),
            "{message}"
        );
    }

    #[test]
    fn warns_when_terminals_arent_contained_saying_why() {
        assert_eq!(
            containment_log(&Containment::Uncontained {
                why: "no user manager".to_owned()
            }),
            Some((
                true,
                "holder terminals are not contained: no user manager".to_owned()
            ))
        );
    }

    #[test]
    fn finds_the_holder_built_beside_the_daemon_in_its_release_holder_profile() {
        assert_eq!(
            holder_source(Path::new("/r/target/release/bazhen-daemon")),
            PathBuf::from("/r/target/release-holder/bazhen-holder")
        );
    }

    #[test]
    fn answers_a_holder_this_build_cant_speak_to_as_one_to_restart_naming_what_it_speaks() {
        let err = RuntimeError::Unservable {
            terminal_id: bazhen_protocol::ids::TerminalId::parse(
                "term_01900000000070008000000000000001",
            )
            .unwrap(),
            protocol: Some(
                bazhen_holder_proto::body::Versions::new(vec![
                    bazhen_holder_proto::body::VersionText::new("0.9").unwrap(),
                ])
                .unwrap(),
            ),
            holder_pid: 77,
        };
        assert_eq!(
            terminal_error(&err),
            TerminalError::Unservable {
                protocol: vec!["0.9".to_owned()],
                holder_pid: Some(77)
            }
        );
    }

    #[test]
    fn answers_a_holder_out_of_reach_before_screen_reads_or_unable_to_read_one_by_what_it_met() {
        let terminal_id =
            bazhen_protocol::ids::TerminalId::parse("term_01900000000070008000000000000001")
                .unwrap();
        let unreachable = RuntimeError::Unreachable {
            terminal_id: terminal_id.clone(),
            source: bazhen_runtime_holder::ConnectError::Timeout {
                path: PathBuf::from("/run/h.sock"),
                after: std::time::Duration::from_secs(2),
            },
        };
        let predates = RuntimeError::Predates {
            terminal_id: terminal_id.clone(),
            what: "screen reads",
        };
        let unreadable = RuntimeError::ScreenUnreadable {
            terminal_id,
            reason: "the holder has no engine".to_owned(),
        };
        assert_eq!(
            [unreachable, predates, unreadable].map(|err| terminal_error(&err)),
            [
                TerminalError::Unreachable(
                    "terminal term_01900000000070008000000000000001: its holder runs but can't be reached"
                        .to_owned()
                ),
                TerminalError::Predates {
                    what: "screen reads".to_owned()
                },
                TerminalError::Unreadable {
                    reason: "the holder has no engine".to_owned()
                },
            ]
        );
    }

    #[test]
    fn answers_a_holder_gone_as_a_terminal_running_nothing_and_any_other_stale_one_as_stale() {
        let stale = |reason| {
            terminal_error(&RuntimeError::Stale {
                terminal_id: bazhen_protocol::ids::TerminalId::parse(
                    "term_01a20211782a7338a7c1cd3c3b942778",
                )
                .unwrap(),
                reason,
            })
        };
        assert!(
            matches!(stale(StaleReason::Gone), TerminalError::Gone(_)),
            "{:?}",
            stale(StaleReason::Gone)
        );
        for reason in [
            StaleReason::ServerReplaced,
            StaleReason::ProcessReplaced,
            StaleReason::Unnumbered,
        ] {
            assert!(
                matches!(stale(reason), TerminalError::Stale(_)),
                "{reason:?}"
            );
        }
    }

    fn holder_at(generation: u64) -> HolderRef {
        use bazhen_holder_proto::body::{Pid, StartTime};
        HolderRef {
            terminal_id: TerminalId::parse("term_0190a1b2c3d47abc8def0123456789ad").unwrap(),
            locator: HolderLocator {
                socket: PathBuf::from("/run/h/term.sock"),
                holder_pid: Pid::new(10).unwrap(),
                holder_start: StartTime::new(11).unwrap(),
                child_pid: Pid::new(12 + generation).unwrap(),
                child_start: StartTime::new(13).unwrap(),
                generation: Some(Generation::new(generation).unwrap()),
            },
        }
    }

    /// A receiver of `told` that reads `found` running whenever it falls behind.
    fn told_of(told: broadcast::Receiver<RuntimeEvent>, found: Vec<HolderRef>) -> HolderTold {
        HolderTold {
            told,
            respawned: Arc::default(),
            reread: Reread(Box::new(move || {
                let found = found.clone();
                Box::pin(async move { Ok(found) })
            })),
        }
    }

    fn exited_at(generation: u64) -> RuntimeEvent {
        RuntimeEvent::Exited {
            terminal_id: holder_at(0).terminal_id,
            generation: Generation::new(generation).unwrap(),
            status: bazhen_holder_proto::body::ExitStatus::Unknown,
        }
    }

    /// Every event `told` tells until its sender is gone.
    fn told_all(mut told: HolderTold) -> Vec<Event> {
        crate::testing::runtime().block_on(async {
            let mut seen = Vec::new();
            while let Some(event) = told.next().await {
                seen.push(event);
            }
            seen
        })
    }

    #[test]
    fn names_the_process_an_exit_ended_where_it_was_told_running_and_none_it_wasnt() {
        let (tx, rx) = broadcast::channel(16);
        let told = told_of(rx, Vec::new());
        for event in [
            exited_at(0),
            RuntimeEvent::Respawned {
                terminal: holder_at(1),
            },
            exited_at(2),
            exited_at(1),
            exited_at(1),
            RuntimeEvent::Lost {
                terminal: holder_at(1),
            },
        ] {
            tx.send(event).unwrap();
        }
        drop(tx);
        let seen = told_all(told);
        let at = |generation| recorded_of(&holder_at(generation)).unwrap();
        let exit = |generation, found| {
            Event::Exited(Exit {
                terminal_id: holder_at(0).terminal_id,
                generation,
                found,
            })
        };
        assert_eq!(
            seen,
            [
                exit(0, None),
                Event::Respawned(at(1)),
                exit(2, None),
                exit(1, Some(at(1))),
                exit(1, None),
                Event::Lost(at(1)),
            ]
        );
    }

    #[test]
    fn names_the_process_an_exit_ended_where_it_fell_behind_the_respawn_that_started_it() {
        let (tx, rx) = broadcast::channel(1);
        let told = told_of(rx, vec![holder_at(1)]);
        tx.send(RuntimeEvent::Respawned {
            terminal: holder_at(1),
        })
        .unwrap();
        tx.send(exited_at(1)).unwrap();
        drop(tx);
        assert_eq!(
            told_all(told),
            [Event::Exited(Exit {
                terminal_id: holder_at(0).terminal_id,
                generation: 1,
                found: recorded_of(&holder_at(1)),
            })]
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn forgets_the_process_told_running_in_a_terminal_once_it_is_closed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let dir = crate::testing::TempDir::new("holder-forget");
        let uid = rustix::process::getuid().as_raw();
        let root = bazhen_runtime_holder::HolderRoot::of(&dir.path().join("run"), uid);
        root.make_private(uid).unwrap();
        let holder = Holder::new(
            HolderRuntime::new(bazhen_runtime_holder::RuntimeOptions::new(root)),
            1000,
        );
        let (told, gone) = (holder.told(), holder.told());
        drop(gone);
        let terminal = holder_at(1);
        told.respawned()
            .insert(terminal.terminal_id.clone(), terminal.clone());
        // No holder answers for it, so it counts as closed, with nothing to end.
        let closed =
            crate::testing::runtime().block_on(holder.close(&recorded_of(&terminal).unwrap()));
        assert_eq!(closed, Ok(()));
        assert_eq!(told.respawned().len(), 0);
        assert_eq!(holder.told.lock().unwrap().len(), 1);
    }

    #[derive(Debug, thiserror::Error)]
    #[error("{0}")]
    struct Failed(String, #[source] std::io::Error);

    #[test]
    fn answers_a_failure_by_its_own_message_cut_to_500_characters_ending_where_it_was_cut() {
        let cause = || std::io::Error::other("the cause");
        let long = "é".repeat(DETAIL_MAX + 1);
        let cut = detail(&Failed(long, cause()));
        assert_eq!(
            [
                detail(&Failed("socket gone".to_owned(), cause())),
                detail(&Failed("x".repeat(DETAIL_MAX), cause())),
            ],
            ["socket gone".to_owned(), "x".repeat(DETAIL_MAX)]
        );
        assert_eq!(cut, format!("{}…", "é".repeat(DETAIL_MAX - 1)));
    }

    /// Shells on the real `bazhen-holder`: each test starts a holder and closes it, so each runs
    /// only in the sandbox.
    mod real {
        use std::os::unix::fs::PermissionsExt as _;
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use bazhen_protocol::shells::{CloseShellRequest, OpenShellRequest, TerminalState};
        use bazhen_runtime_holder::{HolderRoot, HolderRuntime, RuntimeOptions};
        use tokio_util::sync::CancellationToken;
        use tokio_util::task::TaskTracker;

        use super::super::Holder;
        use crate::budget::Budget;
        use crate::budget::tests::{Machine, roomy};
        use crate::shells::{Shells, ShellsDeps};
        use crate::terminals::Terminals;
        use crate::testing::{TempDir, runtime};
        use crate::writer::{Thread, Writer};

        /// The holder built into the target directory this test binary is somewhere under, as
        /// the workspace's tests build it.
        fn holder_binary() -> std::path::PathBuf {
            let exe = std::env::current_exe().unwrap();
            exe.ancestors()
                .skip(1)
                .map(|dir| dir.join("bazhen-holder"))
                .find(|holder| holder.is_file())
                .unwrap_or_else(|| panic!("no bazhen-holder above {}", exe.display()))
        }

        /// Shells running `shell` on real holders under `dir`, none contained.
        fn shells(dir: &TempDir, shell: &str) -> (Arc<Shells>, Writer, Thread) {
            let uid = rustix::process::getuid().as_raw();
            let root = HolderRoot::of(&dir.path().join("run"), uid);
            root.make_private(uid).unwrap();
            let mut options = RuntimeOptions::new(root);
            options.binary = Some(holder_binary());
            let terminals: Arc<dyn Terminals> =
                Arc::new(Holder::new(HolderRuntime::new(options), 1000));
            let path = dir.path().join("bazhen.db");
            let (store, thread) =
                crate::writer::start(bazhen_store::Store::open(&path).unwrap(), &path).unwrap();
            let budget = Budget::new(
                10,
                Arc::new(Machine(std::sync::Mutex::new(roomy()))),
                Box::new(|_| {}),
            );
            let shells = Shells::new(ShellsDeps {
                store: store.clone(),
                terminals,
                budget: Arc::new(budget),
                home: dir.path().to_string_lossy().into_owned(),
                shell: shell.to_owned(),
                socket: dir
                    .path()
                    .join("bazhen.sock")
                    .to_string_lossy()
                    .into_owned(),
                tracker: TaskTracker::new(),
                stop: CancellationToken::new(),
                integration: None,
            });
            (Arc::new(shells), store, thread)
        }

        fn opening(key: &str) -> OpenShellRequest {
            OpenShellRequest {
                idempotency_key: key.to_owned(),
                linked_agent_id: None,
                cwd: None,
                theme: None,
            }
        }

        fn state_of(store: &Writer, id: &str) -> Option<TerminalState> {
            let reader = store.reader().unwrap();
            reader.reads().shell(id).unwrap().map(|found| found.state)
        }

        #[test]
        #[ignore = "signals processes; runs in moon run :test-real -- rust"]
        fn opens_a_login_shell_on_a_holder_of_its_own_and_ends_that_holder_as_it_closes() {
            bazhen_test_signal::require_sandbox().unwrap();
            let dir = TempDir::new("real-shell");
            let (shells, store, thread) = shells(&dir, "/bin/sh");
            runtime().block_on(async {
                let id = shells.open(&opening("o"), None).await.unwrap().terminal_id;
                let running = (
                    state_of(&store, id.as_str()),
                    shells.terminals().holders().await,
                );
                let close = CloseShellRequest {
                    idempotency_key: "c".to_owned(),
                    generation: 0,
                    confirm_busy: Some(true),
                    confirmed_program: None,
                    force: None,
                };
                let closed = shells.close(id.as_str(), &close).await;
                let left = shells.terminals().holders().await;
                shells.terminals().shutdown().await;
                assert_eq!(running.0, Some(TerminalState::Running));
                assert_eq!(running.1.map(|holders| holders.len()), Ok(1));
                assert!(closed.is_ok(), "{closed:?}");
                assert_eq!(state_of(&store, id.as_str()), Some(TerminalState::Closed));
                assert_eq!(left, Ok(Vec::new()));
            });
            drop(shells);
            thread.finish();
        }

        #[test]
        #[ignore = "signals processes; runs in moon run :test-real -- rust"]
        fn closes_a_shell_on_a_holder_once_its_shell_exits() {
            bazhen_test_signal::require_sandbox().unwrap();
            let dir = TempDir::new("real-exit");
            let quits = dir.path().join("quits");
            std::fs::write(&quits, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&quits, std::fs::Permissions::from_mode(0o755)).unwrap();
            let (shells, store, thread) = shells(&dir, &quits.to_string_lossy());
            runtime().block_on(async {
                let (tracker, stop) = (TaskTracker::new(), CancellationToken::new());
                let events = shells.terminals().events();
                tracker.spawn(Arc::clone(&shells).watch(events, tracker.clone(), stop.clone()));
                let id = shells.open(&opening("o"), None).await.unwrap().terminal_id;
                let deadline = Instant::now() + Duration::from_secs(10);
                while state_of(&store, id.as_str()) != Some(TerminalState::Closed)
                    && Instant::now() < deadline
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                stop.cancel();
                let left = shells.terminals().holders().await;
                shells.terminals().shutdown().await;
                assert_eq!(state_of(&store, id.as_str()), Some(TerminalState::Closed));
                assert_eq!(left, Ok(Vec::new()));
            });
            drop(shells);
            thread.finish();
        }
        /// Shells with the integration on, on real holders, reporting over a socket served as the
        /// daemon serves its own (`tests/api/shell-integration.test.ts`): each runs real zsh, bash
        /// and fish, and starts and closes holders, so each runs only in the sandbox.
        mod integrated {
            use std::collections::BTreeMap;
            use std::path::{Path, PathBuf};

            use bazhen_holder_proto::body::Count;
            use bazhen_protocol::shells::RestartShellRequest;
            use bazhen_runtime_holder::{ClientOptions, HolderLocator, connect};

            use super::*;
            use crate::shells::integration::{Integration, install_shell_integration};
            use crate::shells::tests::Said;
            use crate::terminals::Recorded;

            const KINDS: [&str; 3] = ["zsh", "bash", "fish"];
            const TYPED: &str = r#"echo "$HOME" 'a  b'"#;
            const HIDDEN: &str = " export TOKEN=s3cret-kept-out";
            const DECLINED: &str = "the shell's integration said it can't take a line typed back";

            /// The line docs/shell-integration.md gives each shell's rc file.
            fn rc_line(kind: &str) -> &'static str {
                match kind {
                    "zsh" => {
                        r#"[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/zsh ]] && source "$BAZHEN_SHELL_INTEGRATION/zsh""#
                    }
                    "bash" => {
                        r#"[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/bash ]] && . "$BAZHEN_SHELL_INTEGRATION/bash""#
                    }
                    _ => {
                        r#"test -n "$BAZHEN_SHELL_INTEGRATION"; and test -r "$BAZHEN_SHELL_INTEGRATION/fish"; and source "$BAZHEN_SHELL_INTEGRATION/fish""#
                    }
                }
            }

            /// Each test shell's rc: a prompt showing the last line's status, around the
            /// integration's line, as a prompt framework would.
            fn rc(kind: &str) -> String {
                match kind {
                    "zsh" => format!("{}\nPS1='[st=%?] '", rc_line(kind)),
                    "bash" => [
                        "__before_hook() { __before=$?; return $__before; }",
                        "PROMPT_COMMAND='__before_hook;'",
                        rc_line(kind),
                        "PROMPT_COMMAND+=$'\\n''__after=$?'",
                        "PS1='[st=$(( __before < __after ? __before : __after ))] '",
                    ]
                    .join("\n"),
                    _ => format!(
                        "{}\nfunction fish_prompt; echo -n \"[st=$status] \"; end",
                        rc_line(kind)
                    ),
                }
            }

            /// Whether the integration types a line back into this kind of shell: fish only
            /// where its version has the check a paste needs.
            fn types_back(kind: &str) -> bool {
                if kind != "fish" {
                    return true;
                }
                let version = std::process::Command::new(program("fish"))
                    .arg("--version")
                    .output()
                    .unwrap();
                let version = String::from_utf8_lossy(&version.stdout).into_owned();
                version.starts_with("fish, version 3.7.")
                    || version.starts_with("fish, version 4.0.")
            }

            /// `name` as found on this test's PATH.
            fn program(name: &str) -> PathBuf {
                std::env::split_paths(&std::env::var_os("PATH").unwrap())
                    .map(|dir| dir.join(name))
                    .find(|path| path.is_file())
                    .unwrap_or_else(|| panic!("no {name} on PATH"))
            }

            /// The program built into the target directory this test binary is under.
            fn built(name: &str) -> PathBuf {
                let exe = std::env::current_exe().unwrap();
                exe.ancestors()
                    .skip(1)
                    .map(|dir| dir.join(name))
                    .find(|path| path.is_file())
                    .unwrap_or_else(|| panic!("no {name} above {}", exe.display()))
            }

            /// Whether `bash` is 4.4 or later, the oldest the integration runs in, so a test fails as
            /// that rather than as a line never reported: macOS's own bash is 3.2.
            fn integrated_bash(bash: &Path) -> Result<(), String> {
                let out = std::process::Command::new(bash)
                    .args(["-c", "echo ${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"])
                    .output()
                    .map_err(|e| e.to_string())?;
                let version = String::from_utf8_lossy(&out.stdout).into_owned();
                let mut parts = version.split_whitespace().map(str::parse::<u32>);
                match (parts.next(), parts.next()) {
                    (Some(Ok(major)), Some(Ok(minor))) if (major, minor) >= (4, 4) => Ok(()),
                    _ => Err(format!(
                        "{} is bash {}; the integration takes 4.4 or later",
                        bash.display(),
                        version.trim()
                    )),
                }
            }

            #[test]
            fn refuses_a_bash_older_than_the_integration_takes() {
                let dir = TempDir::new("integrated-old-bash");
                let bash = dir.path().join("bash");
                std::fs::write(&bash, "#!/bin/sh\necho 3 2\n").unwrap();
                std::fs::set_permissions(&bash, std::fs::Permissions::from_mode(0o755)).unwrap();
                assert_eq!(
                    integrated_bash(&bash),
                    Err(format!(
                        "{} is bash 3 2; the integration takes 4.4 or later",
                        bash.display()
                    ))
                );
            }

            /// A script starting `kind` interactive with `rc` alone, as `shellWithRc` does.
            fn shell_with_rc(dir: &Path, kind: &str, rc: &str) -> String {
                let rcs = dir.join(format!("rc-{kind}"));
                std::fs::create_dir_all(&rcs).unwrap();
                let file = rcs.join(if kind == "zsh" {
                    ".zshrc".to_owned()
                } else {
                    format!("{kind}rc")
                });
                std::fs::write(&file, format!("{rc}\n")).unwrap();
                if kind == "zsh" {
                    std::fs::write(rcs.join(".zshenv"), "unsetopt GLOBAL_RCS\n").unwrap();
                }
                let exe = program(kind);
                if kind == "bash" {
                    integrated_bash(&exe).unwrap();
                }
                let exe = exe.display().to_string();
                let start = match kind {
                    "zsh" => format!("ZDOTDIR='{}' exec {exe} -i", rcs.display()),
                    "bash" => format!("exec {exe} --rcfile '{}' -i", file.display()),
                    _ => format!("exec {exe} -i -C \"source '{}'\"", file.display()),
                };
                let script = rcs.join(format!("{kind}-shell"));
                // The token as the shell gets it, where this test alone reads it.
                let token = format!(
                    r#"printf '%s' "${{BAZHEN_SHELL_TOKEN-}}" > '{}/token-'"$BAZHEN_TERMINAL_ID""#,
                    dir.display()
                );
                std::fs::write(&script, format!("#!/bin/sh\n{token}\n{start}\n")).unwrap();
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
                script.to_string_lossy().into_owned()
            }

            /// A daemon of shells over real holders under `dir`, running `shell`, with the
            /// integration on and its socket served.
            struct Daemon {
                shells: Arc<Shells>,
                store: Writer,
                thread: Option<Thread>,
                stop: CancellationToken,
                tracker: TaskTracker,
                root: PathBuf,
                shell: String,
                db: PathBuf,
                said: Said,
            }

            impl Daemon {
                fn shells(
                    dir: &Path,
                    shell: &str,
                    store: &Writer,
                    stop: &CancellationToken,
                    tracker: &TaskTracker,
                ) -> Arc<Shells> {
                    let uid = rustix::process::getuid().as_raw();
                    let root = HolderRoot::of(&dir.join("run"), uid);
                    root.make_private(uid).unwrap();
                    let mut options = RuntimeOptions::new(root);
                    options.binary = Some(holder_binary());
                    options.env = BTreeMap::from([
                        ("PATH".to_owned(), std::env::var("PATH").unwrap()),
                        ("HOME".to_owned(), dir.to_string_lossy().into_owned()),
                        ("LANG".to_owned(), "C.UTF-8".to_owned()),
                    ]);
                    let terminals: Arc<dyn Terminals> =
                        Arc::new(Holder::new(HolderRuntime::new(options), 1000));
                    let snippets = dir.join("state/shell-integration");
                    install_shell_integration(&snippets, uid).unwrap();
                    Arc::new(Shells::new(ShellsDeps {
                        store: store.clone(),
                        terminals,
                        budget: Arc::new(Budget::new(
                            10,
                            Arc::new(Machine(std::sync::Mutex::new(roomy()))),
                            Box::new(|_| {}),
                        )),
                        home: dir.to_string_lossy().into_owned(),
                        shell: shell.to_owned(),
                        socket: dir.join("bazhen.sock").to_string_lossy().into_owned(),
                        tracker: tracker.clone(),
                        stop: stop.clone(),
                        integration: Some(Integration {
                            hook: built("bazhen-hook").to_string_lossy().into_owned(),
                            dir: snippets.to_string_lossy().into_owned(),
                        }),
                    }))
                }

                /// Starts it, within a runtime, serving its socket and closing shells as they exit.
                fn start(dir: &Path, shell: &str, said: &Said) -> Self {
                    let db = dir.join("bazhen.db");
                    let (store, thread) =
                        crate::writer::start(bazhen_store::Store::open(&db).unwrap(), &db).unwrap();
                    let (stop, tracker) = (CancellationToken::new(), TaskTracker::new());
                    let shells = Self::shells(dir, shell, &store, &stop, &tracker);
                    let daemon = Self {
                        shells,
                        store,
                        thread: Some(thread),
                        stop,
                        tracker,
                        root: dir.to_owned(),
                        shell: shell.to_owned(),
                        db,
                        said: said.clone(),
                    };
                    daemon.serve();
                    daemon
                }

                fn serve(&self) {
                    let socket = self.root.join("bazhen.sock");
                    drop(std::fs::remove_file(&socket));
                    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
                    let shared = crate::routes::Shared {
                        shells: Some(Arc::clone(&self.shells)),
                        ..crate::routes::Shared::new(
                            "f",
                            crate::routes::Stop::default(),
                            self.store.clone(),
                        )
                    };
                    self.tracker.spawn(crate::accept::serve_on(
                        listener,
                        crate::routes::socket_router(shared),
                        crate::accept::SOCKET,
                        self.stop.clone(),
                        self.tracker.clone(),
                        || {},
                    ));
                    let events = self.shells.terminals().events();
                    self.tracker.spawn(Arc::clone(&self.shells).watch(
                        events,
                        self.tracker.clone(),
                        self.stop.clone(),
                    ));
                }

                /// The daemon ends, and every holder with it, as a reboot would; another starts
                /// over the same store, and finds the shells it kept lost.
                /// Every shell's holder closed and provably gone, as a reboot leaves them, so the
                /// daemon that starts next finds them lost.
                async fn reboot(&mut self) {
                    for id in self.ids() {
                        if let Some(at) = self.recorded(&id) {
                            let terminals = self.shells.terminals();
                            if let Err(e) = terminals.close(&at).await {
                                panic!("{id}: its holder didn't close: {e}");
                            }
                            let deadline = Instant::now() + Duration::from_secs(10);
                            while !terminals.gone(&at).await {
                                assert!(Instant::now() < deadline, "{id}: its holder never went");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                    }
                    self.stop.cancel();
                    self.shells.terminals().shutdown().await;
                    self.tracker.close();
                    self.tracker.wait().await;
                    (self.stop, self.tracker) = (CancellationToken::new(), TaskTracker::new());
                    self.shells = Self::shells(
                        &self.root,
                        &self.shell,
                        &self.store,
                        &self.stop,
                        &self.tracker,
                    );
                    self.shells.reconcile().await.unwrap();
                    self.serve();
                }

                async fn end(mut self) {
                    for id in self.ids() {
                        if let Some(at) = self.recorded(&id) {
                            drop(self.shells.terminals().close(&at).await);
                        }
                    }
                    self.stop.cancel();
                    self.shells.terminals().shutdown().await;
                    self.tracker.close();
                    self.tracker.wait().await;
                    if let Some(thread) = self.thread.take() {
                        thread.finish();
                    }
                }

                fn ids(&self) -> Vec<String> {
                    rusqlite::Connection::open(&self.db)
                        .unwrap()
                        .prepare("SELECT id FROM terminals WHERE kind = 'shell'")
                        .unwrap()
                        .query_map((), |row| row.get(0))
                        .unwrap()
                        .map(Result::unwrap)
                        .collect()
                }

                fn recorded(&self, id: &str) -> Option<Recorded> {
                    let reader = self.store.reader().unwrap();
                    let found = reader.reads().shell(id).unwrap()?;
                    Some(Recorded {
                        terminal_id: found.id,
                        locator: found.locator?,
                    })
                }

                fn locator(&self, id: &str) -> HolderLocator {
                    HolderLocator::decode(&self.recorded(id).unwrap().locator).unwrap()
                }

                fn kept(&self, id: &str) -> Option<String> {
                    let reader = self.store.reader().unwrap();
                    reader.reads().last_shell_command(id).unwrap()
                }

                /// Opens a shell, once its first prompt is drawn.
                async fn driven(&self, key: &str) -> String {
                    let id = self
                        .shells
                        .open(&opening(key), None)
                        .await
                        .unwrap()
                        .terminal_id;
                    let id = id.as_str().to_owned();
                    self.until_screen(&id, |screen| screen.contains("[st=0]"))
                        .await;
                    id
                }

                /// Types `text` into the shell `id`, as a view driving it would.
                async fn types(&self, id: &str, text: &str) {
                    let options = ClientOptions {
                        writer: true,
                        ..ClientOptions::default()
                    };
                    let (client, events) =
                        connect(&self.locator(id).socket, &options).await.unwrap();
                    assert!(
                        client.hello().writer,
                        "{id}: the holder kept the writer slot for another connection"
                    );
                    client.input(text.as_bytes()).unwrap();
                    client.drained().await;
                    client.end();
                    client.closed().await;
                    drop(events);
                }

                async fn screen(&self, id: &str) -> String {
                    self.shown(id).await.unwrap()
                }

                async fn shown(&self, id: &str) -> Result<String, String> {
                    let at = self
                        .recorded(id)
                        .ok_or_else(|| "no holder is recorded".to_owned())?;
                    let locator = HolderLocator::decode(&at.locator).map_err(|e| e.to_string())?;
                    let (client, events) = connect(&locator.socket, &ClientOptions::default())
                        .await
                        .map_err(|e| e.to_string())?;
                    let screen = client.screen(Count::new(0).unwrap()).await;
                    client.end();
                    drop(events);
                    Ok(screen.map_err(|e| e.to_string())?.text().to_owned())
                }

                async fn last_line(&self, id: &str) -> String {
                    self.screen(id)
                        .await
                        .trim_end()
                        .lines()
                        .last()
                        .unwrap_or_default()
                        .to_owned()
                }

                async fn until_screen(&self, id: &str, done: impl Fn(&str) -> bool) {
                    let deadline = Instant::now() + Duration::from_secs(20);
                    loop {
                        let screen = self.screen(id).await;
                        if done(&screen) {
                            return;
                        }
                        assert!(
                            Instant::now() < deadline,
                            "the screen still shows:\n{screen}"
                        );
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }

                async fn until_kept(&self, id: &str, line: Option<&str>) {
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while self.kept(id).as_deref() != line {
                        if Instant::now() >= deadline {
                            let screen =
                                match tokio::time::timeout(Duration::from_secs(5), self.shown(id))
                                    .await
                                {
                                    Ok(Ok(screen)) => screen,
                                    Ok(Err(e)) => format!("(no screen: {e})"),
                                    Err(_) => {
                                        "(no screen: the holder didn't answer in 5 s)".to_owned()
                                    }
                                };
                            let said = self.said.text();
                            let lines: Vec<&str> = said.lines().collect();
                            let tail = lines[lines.len().saturating_sub(200)..].join("\n");
                            panic!(
                                "kept {:?}, not {line:?}\nthe screen shows:\n{screen}\nthe daemon's last 200 lines said:\n{tail}",
                                self.kept(id),
                            );
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }

                /// The shell's own token, as its start script found it in its environment.
                fn token(&self, id: &str) -> String {
                    std::fs::read_to_string(self.root.join(format!("token-{id}"))).unwrap()
                }

                /// Everything a client sees: the state and every event.
                fn seen(&self) -> String {
                    let view = bazhen_store::SnapshotView {
                        host: "h".to_owned(),
                        restart_holders: std::collections::HashMap::new(),
                        shells_report: true,
                    };
                    let reader = self.store.reader().unwrap();
                    let state =
                        serde_json::to_string(&reader.reads().snapshot(&view).unwrap()).unwrap();
                    let events: Vec<String> = rusqlite::Connection::open(&self.db)
                        .unwrap()
                        .prepare("SELECT payload FROM events")
                        .unwrap()
                        .query_map((), |row| row.get(0))
                        .unwrap()
                        .map(Result::unwrap)
                        .collect();
                    format!("{state}\n{}", events.join("\n"))
                }

                /// Restarts the lost shell `id`, asking for its line typed back.
                async fn retyped(&self, id: &str) -> String {
                    let req = RestartShellRequest {
                        idempotency_key: format!("retype-{id}"),
                        generation: 0,
                        theme: None,
                        retype: Some(true),
                    };
                    let restarted = self.shells.restart(id, &req, None).await.unwrap();
                    restarted.terminal_id.as_str().to_owned()
                }
            }

            /// Runs `test` against a daemon whose shells are `kind` with `rc`, once for each kind.
            fn each_kind<F>(name: &str, rc: fn(&str) -> String, test: &F)
            where
                F: AsyncFn(&mut Daemon, &str, &Said),
            {
                for kind in KINDS {
                    let dir = TempDir::new(&format!("{name}-{kind}"));
                    let shell = shell_with_rc(dir.path(), kind, &rc(kind));
                    let said = Said::default();
                    let _logging = said.logging();
                    runtime().block_on(async {
                        let mut daemon = Daemon::start(dir.path(), &shell, &said);
                        test(&mut daemon, kind, &said).await;
                        daemon.end().await;
                    });
                }
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn keeps_the_line_as_typed_and_puts_neither_it_nor_the_shell_s_token_where_a_client_or_log_sees()
             {
                bazhen_test_signal::require_sandbox().unwrap();
                each_kind("integrated-keeps", rc, &async |daemon, kind, said| {
                    let id = daemon.driven("o").await;
                    daemon.types(&id, &format!("{TYPED}\r")).await;
                    daemon.until_kept(&id, Some(TYPED)).await;
                    daemon.types(&id, &format!("{HIDDEN}\r")).await;
                    daemon.types(&id, "true\r").await;
                    daemon.until_kept(&id, Some("true")).await;
                    let token = daemon.token(&id);
                    let seen = format!("{}\n{}", daemon.seen(), said.text());
                    let found: Vec<&str> = ["a  b", "s3cret", token.as_str()]
                        .into_iter()
                        .filter(|secret| seen.contains(secret))
                        .collect();
                    assert_eq!((token.len(), found), (43, Vec::<&str>::new()), "{kind}");
                });
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn leaves_the_prompt_the_status_of_the_line_that_ran() {
                bazhen_test_signal::require_sandbox().unwrap();
                each_kind("integrated-status", rc, &async |daemon, _, _| {
                    let id = daemon.driven("o").await;
                    daemon.types(&id, "false\r").await;
                    daemon
                        .until_screen(&id, |screen| screen.contains("[st=1]"))
                        .await;
                    daemon.types(&id, "true\r").await;
                    daemon
                        .until_screen(&id, |screen| {
                            screen.trim_end().lines().last() == Some("[st=0]")
                        })
                        .await;
                });
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn forgets_the_shell_s_line_once_it_exits() {
                bazhen_test_signal::require_sandbox().unwrap();
                each_kind("integrated-exits", rc, &async |daemon, kind, _| {
                    let id = daemon.driven("o").await;
                    daemon.types(&id, "echo kept-until-exit\r").await;
                    daemon.until_kept(&id, Some("echo kept-until-exit")).await;
                    daemon.types(&id, "exit\r").await;
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while state_of(&daemon.store, &id) != Some(TerminalState::Closed) {
                        assert!(Instant::now() < deadline, "{kind}: the shell never closed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    assert_eq!(daemon.kept(&id), None, "{kind}");
                });
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn leaves_the_user_s_last_background_job_as_the_shell_s_own() {
                bazhen_test_signal::require_sandbox().unwrap();
                each_kind("integrated-job", rc, &async |daemon, kind, _| {
                    let (start, show) = if kind == "fish" {
                        ("sleep 1 &; echo bg=$last_pid", "echo now=$last_pid")
                    } else {
                        ("sleep 1 & echo bg=$!", "echo now=$!")
                    };
                    let id = daemon.driven("o").await;
                    daemon.types(&id, &format!("{start}\r")).await;
                    let shown = |screen: &str, label: &str| {
                        screen.lines().find_map(|line| {
                            line.strip_prefix(label)
                                .filter(|pid| {
                                    !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())
                                })
                                .map(str::to_owned)
                        })
                    };
                    daemon
                        .until_screen(&id, |screen| shown(screen, "bg=").is_some())
                        .await;
                    daemon.types(&id, "true\r").await;
                    daemon.types(&id, &format!("{show}\r")).await;
                    daemon
                        .until_screen(&id, |screen| shown(screen, "now=").is_some())
                        .await;
                    let screen = daemon.screen(&id).await;
                    assert_eq!(shown(&screen, "now="), shown(&screen, "bg="), "{kind}");
                });
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn types_the_line_back_at_a_restarted_shell_s_prompt_exactly_and_without_running_it_or_says_why_not()
             {
                bazhen_test_signal::require_sandbox().unwrap();
                each_kind("integrated-retype", rc, &async |daemon, kind, said| {
                    let id = daemon.driven("o").await;
                    daemon.types(&id, &format!("{TYPED}\r")).await;
                    daemon.until_kept(&id, Some(TYPED)).await;
                    let ran = format!("{} a  b", daemon.root.display());
                    daemon.reboot().await;
                    assert_eq!(
                        state_of(&daemon.store, &id),
                        Some(TerminalState::Lost),
                        "{kind}"
                    );
                    let next = daemon.retyped(&id).await;
                    if types_back(kind) {
                        let typed = format!("[st=0] {TYPED}");
                        daemon
                            .until_screen(&next, |screen| {
                                screen.trim_end().lines().last() == Some(typed.as_str())
                            })
                            .await;
                        // Had Enter been pressed, the line's output and a new prompt would follow.
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        assert_eq!(daemon.last_line(&next).await, typed, "{kind}");
                        assert!(!daemon.screen(&next).await.contains(&ran), "{kind}");
                    } else {
                        let declined =
                            format!("shell {next}: last command not retyped: {DECLINED}");
                        let deadline = Instant::now() + Duration::from_secs(15);
                        while said.times(&declined) == 0 {
                            assert!(Instant::now() < deadline, "{kind}: never said it declined");
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        assert_eq!(daemon.last_line(&next).await, "[st=0]", "{kind}");
                    }
                    let seen = format!("{}\n{}", daemon.seen(), said.text());
                    assert!(!seen.contains("a  b"), "{kind}: the line is seen");
                    assert_eq!(
                        (daemon.kept(&id), daemon.kept(&next)),
                        (None, None),
                        "{kind}"
                    );
                });
            }

            /// Each test shell's rc with the line editor told to take no bracketed paste, in a
            /// UTF-8 locale and, once `marker` exists, a C locale, as a daemon a service manager
            /// started without LANG gives its shells: there the line can only arrive as keys.
            fn keys_rc(kind: &str, marker: &Path) -> String {
                let locale = format!(
                    "if [[ -e '{}' ]]; then export LC_ALL=C; else export LC_ALL=C.UTF-8; fi",
                    marker.display()
                );
                match kind {
                    "zsh" => [
                        rc_line(kind),
                        "PS1='[st=%?] '",
                        "zmodload zsh/zle",
                        "unset zle_bracketed_paste",
                        "bindkey -r '^[[200~'",
                        &locale,
                    ]
                    .join("\n"),
                    _ => [
                        rc_line(kind),
                        "PS1='[st=0] '",
                        "bind 'set enable-bracketed-paste off'",
                        &locale,
                    ]
                    .join("\n"),
                }
            }

            #[test]
            #[ignore = "signals processes; runs in moon run :test-real -- rust"]
            fn types_a_printable_ascii_line_back_as_keys_and_no_line_beyond_it_where_the_editor_takes_no_paste()
             {
                bazhen_test_signal::require_sandbox().unwrap();
                for kind in ["zsh", "bash"] {
                    let dir = TempDir::new(&format!("integrated-keys-{kind}"));
                    let marker = dir.path().join("marked");
                    let shell = shell_with_rc(dir.path(), kind, &keys_rc(kind, &marker));
                    let said = Said::default();
                    let _logging = said.logging();
                    runtime().block_on(async {
                        let mut daemon = Daemon::start(dir.path(), &shell, &said);
                        let plain = daemon.driven("plain").await;
                        daemon.types(&plain, "echo plain-ascii\r").await;
                        daemon.until_kept(&plain, Some("echo plain-ascii")).await;
                        let accented = daemon.driven("accented").await;
                        daemon.types(&accented, "echo café\r").await;
                        daemon.until_kept(&accented, Some("echo café")).await;
                        std::fs::write(&marker, "").unwrap();
                        daemon.reboot().await;
                        let plain = daemon.retyped(&plain).await;
                        let accented = daemon.retyped(&accented).await;
                        daemon
                            .until_screen(&plain, |screen| {
                                screen.trim_end().lines().last() == Some("[st=0] echo plain-ascii")
                            })
                            .await;
                        let screen = daemon.screen(&plain).await;
                        assert!(
                            !screen.contains("200~") && !screen.contains("201~"),
                            "{kind}: {screen}"
                        );
                        let refused = format!("shell {accented}: last command not retyped");
                        let deadline = Instant::now() + Duration::from_secs(20);
                        while said.times(&refused) == 0 {
                            assert!(Instant::now() < deadline, "{kind}: never said why");
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        assert_eq!(daemon.last_line(&accented).await, "[st=0]", "{kind}");
                        assert_eq!(said.times("café"), 0, "{kind}");
                        daemon.end().await;
                    });
                }
            }
        }
    }
}
