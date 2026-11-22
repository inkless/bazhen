//! The verbs on the daemon itself: start it, stop it, say how it is, refresh the environment it
//! gives agents, and pair and list the browsers that may reach it.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use bazhen_client::paths::LOCK_WAIT;
use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::daemon::{
    DoctorResponse, EnvRefreshRequest, EnvRefreshResponse, HealthResponse, StopResponse,
};
use bazhen_protocol::notices::{
    DevicesResponse, DismissNoticeRequest, DismissNoticeResponse, NoticeState, PairingCodeResponse,
    RevokeDeviceResponse,
};
use bazhen_protocol::record::Record;

use crate::absent::{Presence, presence, unanswering_text, unbound_text};
use crate::args::Parsed;
use crate::call::{CALL, Daemon, Failed};
use crate::fmt::{encode_uri_component, local, printable, uuid};
use crate::out::Out;
use crate::{Exit, doctor};

/// How long a stopped daemon may take to stop answering.
const STOPPED_WITHIN: Duration = Duration::from_secs(5);
/// How long the daemon may take to take a stop, or a new environment, before it is wedged.
const SLOW_CALL: Duration = Duration::from_secs(30);

/// The variable that names the Rust daemon's binary for `start`, while both daemons are built.
const TEST_DAEMON_BIN: &str = "BAZHEN_TEST_DAEMON_BIN";

/// The daemon binary `value`, `TEST_DAEMON_BIN`'s, names: none when it is unset or empty, and an
/// error for a path that isn't absolute, which would be looked up on `PATH` or the directory.
fn test_daemon_bin(value: Option<OsString>) -> Result<Option<PathBuf>, String> {
    let Some(bin) = value.filter(|b| !b.is_empty()).map(PathBuf::from) else {
        return Ok(None);
    };
    if bin.is_absolute() {
        Ok(Some(bin))
    } else {
        Err(format!(
            "{TEST_DAEMON_BIN} names {}, which isn't an absolute path",
            bin.display()
        ))
    }
}

/// Runs the daemon's own start-up, which detaches it and reports whether it came up. The daemon
/// is the Rust daemon's binary `TEST_DAEMON_BIN` names, when it names one, saying so; else the
/// TypeScript one of the checkout this binary was built in: `<checkout>/target/<profile>/bazhen`.
pub(crate) fn start(p: &Parsed, out: &mut Out) -> Exit {
    let rust = match test_daemon_bin(std::env::var_os(TEST_DAEMON_BIN)) {
        Ok(rust) => rust,
        Err(message) => {
            out.err(&message);
            return Exit::Failed;
        }
    };
    let mut daemon = if let Some(bin) = rust {
        out.err(&format!(
            "bazhen start: starting the daemon at {}, as {TEST_DAEMON_BIN} names",
            bin.display()
        ));
        let mut rust = Command::new(bin);
        rust.arg("start");
        rust
    } else {
        let entry = checkout().map(|root| root.join("apps/daemon/src/start.ts"));
        let Some(entry) = entry.filter(|e| e.is_file()) else {
            out.err(
                "bazhen start runs the daemon of the checkout it was built in, and finds none here",
            );
            return Exit::Failed;
        };
        let mut node = Command::new("node");
        node.arg(&entry);
        node
    };
    if let Some(home) = p.value("home") {
        daemon.env("BAZHEN_HOME", home);
    }
    if let Some(port) = p.value("port") {
        daemon.env("BAZHEN_PORT", port);
    }
    match daemon.status() {
        Ok(status) => status
            .code()
            .and_then(|c| u8::try_from(c).ok())
            .map_or(Exit::Failed, Exit::Code),
        Err(e) => {
            out.err(&format!("can't run the daemon to start it: {e}"));
            Exit::Failed
        }
    }
}

/// The checkout this binary was built in, three directories above it.
fn checkout() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    exe.ancestors().nth(3).map(Path::to_path_buf)
}

/// Idempotent: a daemon that isn't running is already stopped. One that holds the start-up lock
/// with no socket is stopping or still starting, so `stop` waits, for as long as a stopping daemon
/// drains and a little more, until the lock frees, or the socket answers and it can be told to stop.
pub(crate) fn stop(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    let socket = daemon.socket();
    let begun = Instant::now();
    let mut waited = false;
    let mut doubted = false;
    while !daemon.answers()? {
        match presence(Path::new(&socket)) {
            Presence::Absent => {
                out.line(if waited {
                    "bazhen stopped; agents keep running"
                } else {
                    "bazhen is not running"
                });
                return Ok(Exit::Done);
            }
            Presence::Unbound { lock } => {
                if begun.elapsed() >= LOCK_WAIT {
                    out.err(&unbound_text(&lock));
                    return Ok(Exit::Failed);
                }
                waited = true;
                sleep(Duration::from_millis(100));
            }
            // A daemon that bound its socket between the health call and the look has not been
            // given time to answer: only one that stays silent is stuck.
            Presence::Unanswering(_) if !doubted => {
                doubted = true;
                sleep(Duration::from_millis(100));
                continue;
            }
            Presence::Unanswering(why) => {
                out.err(&unanswering_text(Path::new(&socket), &why));
                return Ok(Exit::Failed);
            }
        }
        doubted = false;
    }
    let _: StopResponse = daemon.post_empty("/v1/daemon/stop", SLOW_CALL)?;
    let begun = Instant::now();
    while begun.elapsed() < STOPPED_WITHIN {
        if !daemon.answers()? {
            // A daemon stops answering as its drain begins, and is stopped when it lets go of the lock.
            if let Err(lock) = wait_for_lock(Path::new(&socket)) {
                out.err(&unbound_text(&lock));
                return Ok(Exit::Failed);
            }
            out.line("bazhen stopped; agents keep running");
            return Ok(Exit::Done);
        }
        sleep(Duration::from_millis(100));
    }
    out.err("bazhen is still answering after 5 s");
    Ok(Exit::Failed)
}

/// Waits while a daemon holds the lock with no socket, for at most `LOCK_WAIT`. The lock is the
/// one still held when that runs out.
fn wait_for_lock(socket: &Path) -> Result<(), PathBuf> {
    let begun = Instant::now();
    loop {
        match presence(socket) {
            Presence::Unbound { lock } if begun.elapsed() >= LOCK_WAIT => return Err(lock),
            Presence::Unbound { .. } => sleep(Duration::from_millis(100)),
            Presence::Absent | Presence::Unanswering(_) => return Ok(()),
        }
    }
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
    for r in &health.runtimes {
        out.line(&doctor::runtime_line(r));
    }
    out.line(&format!("agents: {agents}"));
    Ok(Exit::Done)
}

/// What the daemon runs with, for diagnosing it. Fails when the daemon or a runtime it read can't
/// be reached; an unused runtime isn't read, and a missing hook binary is a warning.
pub(crate) fn doctor(daemon: &Daemon, out: &mut Out) -> Result<Exit, Failed> {
    if !daemon.answers()? {
        let socket = daemon.socket();
        out.line(&match presence(Path::new(&socket)) {
            Presence::Absent => format!("daemon: not running (no answer on {socket})"),
            Presence::Unbound { lock } => format!(
                "daemon: stopping or still starting (holds {}, has no socket)",
                lock.display()
            ),
            Presence::Unanswering(why) => {
                format!("daemon: not answering on {socket}; it may be stuck or busy ({why})")
            }
        });
        return Ok(Exit::Failed);
    }
    let d: DoctorResponse = daemon.get("/v1/daemon/doctor", CALL)?;
    for line in doctor::lines(&d, std::env::consts::OS == "macos") {
        out.line(&line);
    }
    Ok(if doctor::any_unreachable(&d.runtimes) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_test_daemon_only_by_an_absolute_path_and_none_unset_or_empty() {
        let named = |v: &str| test_daemon_bin(Some(OsString::from(v)));
        assert_eq!(
            [
                test_daemon_bin(None),
                named(""),
                named("/opt/bazhen-daemon"),
                named("bin/bazhen-daemon"),
            ],
            [
                Ok(None),
                Ok(None),
                Ok(Some(PathBuf::from("/opt/bazhen-daemon"))),
                Err(
                    "BAZHEN_TEST_DAEMON_BIN names bin/bazhen-daemon, which isn't an absolute path"
                        .into()
                ),
            ]
        );
    }
}
