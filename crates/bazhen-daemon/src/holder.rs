//! The daemon's terminals on `bazhen-holder`, as `main.ts` sets them up with
//! `terminals/holder.ts`, `terminals/containment.ts` and `terminals/runtimes.ts`: the build new
//! holders run, installed where it can't be written over, the runtime over it, and what `bazhen
//! doctor` says of both.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use bazhen_holder_proto::body::{Cols, Generation, HistoryLines, Rows, Size, Theme};
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
    runtime: HolderRuntime,
    history_lines: u32,
    /// Whether containment has been said, once the first start decided it.
    told_containment: AtomicBool,
}

impl Holder {
    pub(crate) fn new(runtime: HolderRuntime, history_lines: u32) -> Self {
        Self {
            runtime,
            history_lines,
            told_containment: AtomicBool::new(false),
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

/// The events a holder runtime tells.
#[derive(Debug)]
struct HolderTold {
    told: broadcast::Receiver<RuntimeEvent>,
    /// The process each terminal was last told running since the daemon started it, which an
    /// exit at that generation names.
    respawned: HashMap<TerminalId, HolderRef>,
}

impl HolderTold {
    /// The process of `generation` the terminal was told running, if it was.
    fn ended(&mut self, terminal_id: &TerminalId, generation: Generation) -> Option<Recorded> {
        let told = self.respawned.get(terminal_id)?;
        if told.locator.generation != Some(generation) {
            return None;
        }
        recorded_of(&self.respawned.remove(terminal_id)?)
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
                            self.respawned
                                .insert(terminal.terminal_id.clone(), terminal);
                            return Some(Event::Respawned(recorded));
                        }
                    }
                    Ok(RuntimeEvent::Lost { terminal }) => {
                        self.respawned.remove(&terminal.terminal_id);
                        if let Some(recorded) = recorded_of(&terminal) {
                            return Some(Event::Lost(recorded));
                        }
                    }
                    // A title isn't followed yet. An event missed while behind is seen again by
                    // what reads the terminal next: a close finds what is left of it.
                    Ok(RuntimeEvent::Title { .. })
                    | Err(broadcast::error::RecvError::Lagged(_)) => {}
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
                .map_err(|e| terminal_error(&e))
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
            // it again, which only `reachable`, at start, does.
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
        Box::new(HolderTold {
            told: self.runtime.events(),
            respawned: HashMap::new(),
        })
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

    #[test]
    fn names_the_process_an_exit_ended_where_it_was_told_running_and_none_it_wasnt() {
        let (tx, rx) = broadcast::channel(16);
        let mut told = HolderTold {
            told: rx,
            respawned: HashMap::new(),
        };
        let exited = |generation| RuntimeEvent::Exited {
            terminal_id: holder_at(0).terminal_id,
            generation: Generation::new(generation).unwrap(),
            status: bazhen_holder_proto::body::ExitStatus::Unknown,
        };
        for event in [
            exited(0),
            RuntimeEvent::Respawned {
                terminal: holder_at(1),
            },
            exited(2),
            exited(1),
            exited(1),
            RuntimeEvent::Lost {
                terminal: holder_at(1),
            },
        ] {
            tx.send(event).unwrap();
        }
        drop(tx);
        let seen = crate::testing::runtime().block_on(async {
            let mut seen = Vec::new();
            while let Some(event) = told.next().await {
                seen.push(event);
            }
            seen
        });
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
                let exits = shells.terminals().events();
                tracker.spawn(Arc::clone(&shells).watch(exits, tracker.clone(), stop.clone()));
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
    }
}
