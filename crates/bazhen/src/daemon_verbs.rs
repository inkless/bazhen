//! The verbs on the daemon itself: start it, stop it, say how it is, refresh the environment it
//! gives agents, and pair and list the browsers that may reach it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::daemon::{
    DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, HealthResponse, StopResponse,
};
use bazhen_protocol::notices::{
    DevicesResponse, DismissNoticeRequest, DismissNoticeResponse, NoticeState, PairingCodeResponse,
    RevokeDeviceResponse,
};
use bazhen_protocol::record::Record;

use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::{encode_uri_component, local, printable, uuid};
use crate::out::Out;
use crate::{Exit, doctor};

/// How long a stopped daemon may take to stop answering.
const STOPPED_WITHIN: Duration = Duration::from_secs(5);
/// How long the daemon may take to take a stop, or a new environment, before it is wedged.
const SLOW_CALL: Duration = Duration::from_secs(30);

/// Runs the daemon's own start-up, which detaches it and reports whether it came up. The daemon
/// is the checkout's this binary was built in: `<checkout>/target/<profile>/bazhen`.
pub(crate) fn start(p: &Parsed, out: &mut Out) -> Exit {
    let entry = checkout().map(|root| root.join("apps/daemon/src/start.ts"));
    let Some(entry) = entry.filter(|e| e.is_file()) else {
        out.err(
            "bazhen start runs the daemon of the checkout it was built in, and finds none here",
        );
        return Exit::Failed;
    };
    let mut node = Command::new("node");
    node.arg(&entry);
    if let Some(home) = p.value("home") {
        node.env("BAZHEN_HOME", home);
    }
    if let Some(port) = p.value("port") {
        node.env("BAZHEN_PORT", port);
    }
    match node.status() {
        Ok(status) => status
            .code()
            .and_then(|c| u8::try_from(c).ok())
            .map_or(Exit::Failed, Exit::Code),
        Err(e) => {
            out.err(&format!("can't run node to start the daemon: {e}"));
            Exit::Failed
        }
    }
}

/// The checkout this binary was built in, three directories above it.
fn checkout() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    exe.ancestors().nth(3).map(Path::to_path_buf)
}

/// Idempotent: a daemon that isn't running is already stopped.
pub(crate) fn stop(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    if !daemon.answers()? {
        out.line("bazhen is not running");
        return Ok(Exit::Done);
    }
    let _: StopResponse = daemon.post_empty("/v1/daemon/stop", SLOW_CALL)?;
    let begun = Instant::now();
    while begun.elapsed() < STOPPED_WITHIN {
        if !daemon.answers()? {
            out.line("bazhen stopped; agents keep running");
            return Ok(Exit::Done);
        }
        sleep(Duration::from_millis(100));
    }
    out.err("bazhen is still answering after 5 s");
    Ok(Exit::Failed)
}

pub(crate) fn status(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    let health: HealthResponse = daemon.get("/v1/health", CALL)?;
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    let mut by_state: Vec<(&str, usize)> = Vec::new();
    for agent in &state.agents {
        let s = agent.state.as_str();
        match by_state.iter_mut().find(|(k, _)| *k == s) {
            Some(group) => group.1 += 1,
            None => by_state.push((s, 1)),
        }
    }
    let agents: Vec<String> = by_state.iter().map(|(s, n)| format!("{n} {s}")).collect();
    let agents = if agents.is_empty() {
        "none".to_owned()
    } else {
        agents.join(", ")
    };
    for line in doctor::build_lines(&health.app_version, &health.protocol_id, ", running") {
        out.line(&line);
    }
    let reports = doctor::reports(
        health.runtimes.as_ref(),
        health.runtime.state,
        health.runtime.version.as_ref(),
    );
    for r in &reports {
        out.line(&doctor::runtime_line(r));
    }
    out.line(&format!("agents: {agents}"));
    Ok(Exit::Done)
}

/// What the daemon runs with, for diagnosing it. Fails when the daemon or any of its runtimes
/// can't be reached; a missing hook binary is a warning.
pub(crate) fn doctor(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    if !daemon.answers()? {
        out.line(&format!(
            "daemon: not running (no answer on {})",
            daemon.socket()
        ));
        return Ok(Exit::Failed);
    }
    let d: DoctorResponse = daemon.get("/v1/daemon/doctor", CALL)?;
    for line in doctor::lines(&d, std::env::consts::OS == "macos") {
        out.line(&line);
    }
    let reports = doctor::reports(
        d.runtimes.as_ref(),
        d.runtime.state,
        d.runtime.version.as_ref(),
    );
    Ok(if doctor::any_unreachable(&reports) {
        Exit::Failed
    } else {
        Exit::Done
    })
}

/// Gives agents started from now on this shell's environment.
pub(crate) fn env_refresh(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    let env = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let request = EnvRefreshRequest {
        env: Record::new(env),
    };
    let r: EnvRefreshResponse = daemon.post("/v1/daemon/env", &request, SLOW_CALL)?;
    let removed: Vec<String> = r
        .removed
        .entries()
        .iter()
        .map(|(rule, count)| format!("{rule} {count}"))
        .collect();
    let removed = if removed.is_empty() {
        "none".to_owned()
    } else {
        removed.join(", ")
    };
    out.line(&format!(
        "environment refreshed: {} variables kept; removed: {removed}",
        r.kept
    ));
    if !r.refused.is_empty() {
        out.line(&format!(
            "  left as they were (tmux can't take them as data): {}",
            r.refused.join(", ")
        ));
    }
    if !r.unchanged.is_empty() {
        out.line(&format!(
            "  {} running agents keep their environment until respawned:",
            r.unchanged.len()
        ));
        for id in &r.unchanged {
            out.line(&format!("    {id}"));
        }
    }
    Ok(Exit::Done)
}

/// A code for pairing a browser: shown to whoever ran this, and nowhere else.
pub(crate) fn pair(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    let r: PairingCodeResponse = daemon.post_empty("/v1/pairing/codes", CALL)?;
    let (first, second) = r.code.split_at_checked(4).unwrap_or((r.code.as_str(), ""));
    out.line(&format!("pairing code: {first}-{second}"));
    out.line(&format!(
        "enter it in the browser to pair; it works once, until {}",
        local(&r.expires_at, "%H:%M:%S")
    ));
    for origin in &r.origins {
        out.line(&format!("  open {origin}"));
    }
    if let Some(lan) = &r.lan {
        out.line(&format!("  on the LAN, open {}", lan.url));
        out.line("  before trusting its certificate, check that its SHA-256 is");
        out.line(&format!("    {}", lan.fingerprint));
        out.line(&format!(
            "  (the certificate lasts until {})",
            local(&lan.expires_at, "%Y-%m-%d")
        ));
        out.line("  and if it isn't, don't trust it or pair");
    }
    Ok(Exit::Done)
}

/// Each device whose pairing notice is still open, with that notice's id.
fn open_pairings(daemon: &Daemon) -> Result<Vec<(String, String)>, Failed> {
    let state: StateSnapshot = daemon.get("/v1/state", CALL)?;
    Ok(state
        .notices
        .iter()
        .filter(|n| n.state == NoticeState::Open)
        .filter_map(|n| {
            n.device
                .as_ref()
                .map(|d| (d.id.to_string(), n.id.to_string()))
        })
        .collect())
}

pub(crate) fn devices(
    p: &Parsed,
    daemon: &Daemon,
    now_ms: i64,
    out: &mut Out,
) -> Result<Exit, Failed> {
    match p.word(1) {
        Some("dismiss") => {
            let Some(id) = p.word(2) else {
                out.err("usage: bazhen devices dismiss <id>");
                return Ok(Exit::Usage);
            };
            let pending = open_pairings(daemon)?;
            let Some((_, notice)) = pending.iter().find(|(device, _)| device == id) else {
                out.err(&format!("no open pairing notice for {id}"));
                return Ok(Exit::Failed);
            };
            let key = uuid().map_err(|e| Failed::Unsendable(e.to_string()))?;
            let _: DismissNoticeResponse = daemon.post(
                &format!("/v1/notices/{}/dismiss", encode_uri_component(notice)),
                &DismissNoticeRequest {
                    idempotency_key: key,
                },
                CALL,
            )?;
            out.line(&format!("dismissed the pairing notice of {id}"));
            Ok(Exit::Done)
        }
        Some("revoke") => {
            let Some(id) = p.word(2) else {
                out.err("usage: bazhen devices revoke <id>");
                return Ok(Exit::Usage);
            };
            let _: RevokeDeviceResponse = daemon.post_empty(
                &format!("/v1/devices/{}/revoke", encode_uri_component(id)),
                CALL,
            )?;
            out.line(&format!("revoked {id}; its open views are closed"));
            Ok(Exit::Done)
        }
        _ => {
            let r: DevicesResponse = daemon.get("/v1/devices", CALL)?;
            let pending = open_pairings(daemon)?;
            if r.devices.is_empty() {
                out.line("no paired devices; pair one with `bazhen devices pair`");
            }
            for d in &r.devices {
                let expires = bazhen_protocol::time::timestamp_ms(&d.expires_at);
                let lapsed = if expires.is_some_and(|ms| ms <= now_ms) {
                    " (expired)"
                } else {
                    ""
                };
                let fresh = if pending.iter().any(|(device, _)| *device == d.id.as_str()) {
                    " (new: `bazhen devices dismiss` once you know it)"
                } else {
                    ""
                };
                out.line(&format!(
                    "{}  {}  paired {}, last used {}{lapsed}{fresh}",
                    d.id,
                    printable(&d.name),
                    d.paired_at,
                    d.last_seen_at
                ));
            }
            Ok(Exit::Done)
        }
    }
}
