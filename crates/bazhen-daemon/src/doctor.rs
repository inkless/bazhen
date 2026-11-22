//! `GET /v1/daemon/doctor` (`socket/routes.ts`): what `bazhen doctor` shows of the daemon, its
//! settings, its terminals and the holders they run on, and the environment it captured.

use std::path::Path;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use bazhen_protocol::daemon::{
    AgentShell, AgentsSettings, CapturedEnv, ConfigFile, DoctorResponse, EnvSource, HookClient,
    OriginsFrom, Pairing, PairingMode, RuntimeHealthReport, Web,
};
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::record::Record;

use crate::budget::Counts;
use crate::env::Capture;
use crate::holder::{Install, holder_doctor};
use crate::routes::{Shared, internal};

/// What doctor says that is settled once the daemon starts.
#[derive(Debug, Clone)]
pub(crate) struct Settled {
    pub(crate) hook_client: HookClient,
    pub(crate) config: ConfigFile,
    pub(crate) agents: AgentsSettings,
    pub(crate) web: Web,
    pub(crate) install: Install,
    pub(crate) env: CapturedEnv,
}

/// What the start-up settings say, for [`Settled`].
#[derive(Debug)]
pub(crate) struct Settings<'a> {
    pub(crate) exe: &'a Path,
    pub(crate) config: &'a crate::config::Settings,
    pub(crate) install: Install,
    pub(crate) capture: &'a Capture,
}

/// The hook client agents run beside this daemon: `bazhen-hook`, built beside it, or, before it
/// is, the curl script in the crate's source.
fn hook_client(exe: &Path) -> HookClient {
    let dir = exe.parent().unwrap_or_else(|| Path::new("/"));
    let built = dir.join("bazhen-hook");
    if built.exists() {
        return HookClient {
            path: built.to_string_lossy().into_owned(),
            fallback: false,
        };
    }
    HookClient {
        path: dir
            .join("../../crates/bazhen-hook/bazhen-hook.sh")
            .to_string_lossy()
            .into_owned(),
        fallback: true,
    }
}

impl Settled {
    pub(crate) fn of(settings: Settings<'_>) -> Self {
        let config = &settings.config.config;
        let capture = settings.capture;
        Self {
            hook_client: hook_client(settings.exe),
            config: ConfigFile {
                path: settings.config.config_file.path.clone(),
                found: settings.config.config_file.found,
            },
            agents: AgentsSettings {
                shell: if config.login_shell.is_some() {
                    AgentShell::Login
                } else {
                    AgentShell::Direct
                },
                login_shell: config.login_shell.clone(),
            },
            web: Web {
                external_origins: config.external_origins.clone(),
                from: config.external_origins_from.map(|from| match from {
                    crate::config::OriginsFrom::Environment => OriginsFrom::Environment,
                    crate::config::OriginsFrom::Config => OriginsFrom::Config,
                }),
                allow_insecure_origins: config.allow_insecure_origins,
                pairing: Some(Pairing {
                    mode: match config.pairing {
                        crate::config::PairingMode::Auto => PairingMode::Auto,
                        crate::config::PairingMode::Always => PairingMode::Always,
                    },
                    required: config.pairing_required,
                }),
                // This daemon serves no web client and no LAN listener yet, so says nothing of
                // either, as a daemon older than them.
                app: Nullable::Absent,
                lan: Nullable::Absent,
            },
            install: settings.install,
            env: CapturedEnv {
                captured_at: capture.at.clone(),
                source: EnvSource::Start,
                kept: u64::try_from(capture.env.len()).unwrap_or(u64::MAX),
                removed: Record::new(capture.removed.clone()),
            },
        }
    }
}

/// What doctor shows now: the runtime and its holders read as it is asked.
pub(crate) async fn doctor(State(shared): State<Shared>) -> Response {
    let (Some(shells), Some(settled)) = (&shared.shells, &shared.doctor) else {
        return internal(&"doctor asked of a daemon that runs no terminals");
    };
    let counts = shared
        .store
        .run(|store| -> rusqlite::Result<Counts> {
            let reads = store.reads();
            Ok(Counts {
                open: reads.open_terminals()?,
                starting: reads.starting_terminals()?,
            })
        })
        .await;
    let counts = match counts {
        Ok(Ok(counts)) => counts,
        Ok(Err(err)) => return internal(&err),
        Err(err) => return internal(&err),
    };
    let terminals = shells.terminals();
    // A doctor that can't list the holders fails, as `holderDoctor` throws.
    let holders = match terminals.holders().await {
        Ok(holders) => holders,
        Err(why) => return internal(&format!("the holders can't be listed: {why}")),
    };
    // Doctor lists each runtime's workarounds, none included.
    let runtimes = crate::holder::routed(terminals.health().await)
        .into_iter()
        .map(|mut report: RuntimeHealthReport| {
            report.workarounds.get_or_insert_with(Vec::new);
            report
        })
        .collect();
    let settled = settled.as_ref().clone();
    let answer = DoctorResponse {
        app_version: shared.health.app_version.clone(),
        protocol_id: shared.health.protocol_id.clone(),
        runtimes,
        hook_client: settled.hook_client,
        // This daemon reads its callers without the peer reader's program, so says nothing of
        // one, as a daemon older than it.
        peer_reader: Nullable::Absent,
        agent_cli: None,
        config: settled.config,
        agents: settled.agents,
        codex: None,
        web: Some(settled.web),
        notifications: None,
        terminals: Some(shells.budget().report(counts)),
        holder: Some(holder_doctor(&settled.install, holders)),
        containment: Some(terminals.containment()),
        env: settled.env,
    };
    axum::Json(answer).into_response()
}
