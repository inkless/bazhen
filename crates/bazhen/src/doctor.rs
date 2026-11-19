//! What `bazhen status` and `bazhen doctor` say of the daemon, as lines.

use bazhen_protocol::daemon::{
    AgentCli, AgentShell, Containment, DoctorResponse, EnvSource, Holder, Lan, MemoryCap,
    OriginsFrom, Refusing, RunningHolder, RuntimeHealthReport, RuntimeReportState, Terminals,
    ToolCalls, Web,
};
use bazhen_protocol::id::PROTOCOL_ID;
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::text::is_plain_remote;

use crate::call::ANOTHER_BUILD;
use crate::fmt::{gib, mib};

fn state(s: RuntimeReportState) -> &'static str {
    match s {
        RuntimeReportState::Healthy => "healthy",
        RuntimeReportState::Unreachable => "unreachable",
        RuntimeReportState::NotRunning => "not-running",
        RuntimeReportState::Unused => "unused",
    }
}

/// A runtime as a line: its kind, its state, and its version when it has one.
pub(crate) fn runtime_line(r: &RuntimeHealthReport) -> String {
    match r.version.as_deref() {
        Some(v) if !v.is_empty() => format!("{}: {} {v}", r.kind, state(r.state)),
        _ => format!("{}: {}", r.kind, state(r.state)),
    }
}

/// Whether a runtime can't be read: then doctor fails.
pub(crate) fn any_unreachable(reports: &[RuntimeHealthReport]) -> bool {
    reports
        .iter()
        .any(|r| r.state == RuntimeReportState::Unreachable)
}

/// As much of a protocol id as a person compares by eye.
fn short_id(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}

/// What `bazhen status` and `doctor` first say of the daemon: its version and protocol, and, when
/// that protocol isn't this build's, that the daemon is another build to restart.
pub(crate) fn build_lines(app_version: &str, protocol_id: &str, state: &str) -> Vec<String> {
    let head = format!(
        "bazhen {app_version} (protocol {}){state}",
        short_id(protocol_id)
    );
    if protocol_id == PROTOCOL_ID {
        return vec![head];
    }
    vec![
        head,
        format!(
            "  warning: this CLI speaks protocol {}; {ANOTHER_BUILD}",
            short_id(PROTOCOL_ID)
        ),
    ]
}

/// Everything `bazhen doctor` prints of `d`.
pub(crate) fn lines(d: &DoctorResponse, macos: bool) -> Vec<String> {
    let mut out = build_lines(&d.app_version, &d.protocol_id, "");
    for r in &d.runtimes {
        out.push(runtime_line(r));
        for w in r.workarounds.iter().flatten() {
            out.push(format!("  warning: {w}"));
        }
    }
    out.push(format!("hook client: {}", d.hook_client.path));
    if d.hook_client.fallback {
        out.push(
            "  warning: bazhen-hook is not built; hooks use the slower curl script".to_owned(),
        );
    }
    out.extend(peer_reader_lines(&d.peer_reader));
    if let Some(cli) = &d.agent_cli {
        out.extend(agent_cli_lines(cli, d.agents.shell == AgentShell::Login));
    }
    out.extend(settings_lines(d));
    if let Some(codex) = &d.codex {
        let server = codex.daemon.as_ref().map_or_else(
            || "not connected yet".to_owned(),
            |v| format!("{v} (as last connected)"),
        );
        let cli = codex.cli.as_deref().unwrap_or("not found");
        out.push(format!("codex: app-server {server}, cli {cli}"));
        match codex.tool_calls.value() {
            Some(ToolCalls::Unmarked) => out.push(
                "  warning: the peer reader doesn't know this app-server for Codex's, so a live \
                 Codex agent's commands could pass as yours"
                    .to_owned(),
            ),
            Some(ToolCalls::Unread) => out.push(
                "  warning: the peer reader can't read Codex's app-server, so whether a live \
                 Codex agent's commands pass as yours is unknown"
                    .to_owned(),
            ),
            Some(ToolCalls::Marked) | None => {}
        }
    }
    if let Some(web) = &d.web {
        out.extend(web_lines(web));
    }
    if let Some(n) = &d.notifications {
        out.push(format!(
            "desktop notifications: {}",
            if n.desktop { "on" } else { "off" }
        ));
        if macos && n.notifier.is_none() {
            out.push(
                "  warning: Bazhen.app is not built; run pnpm build:notify for macOS notifications"
                    .to_owned(),
            );
        }
    }
    if let Some(t) = &d.terminals {
        out.extend(terminal_lines(t));
    }
    if let Some(h) = &d.holder {
        out.extend(holder_lines(h));
    }
    if let Some(c) = &d.containment {
        let holders = d.holder.as_ref().map_or(&[][..], |h| h.holders.as_slice());
        let tmux = d
            .runtimes
            .iter()
            .any(|r| r.kind == "tmux" && r.state != RuntimeReportState::Unused);
        out.extend(containment_lines(c, holders, tmux));
    }
    let source = match d.env.source {
        EnvSource::Start => "at start",
        EnvSource::Refresh => "by bazhen env refresh",
    };
    out.push(format!(
        "environment: captured {} {source}, {} variables kept",
        d.env.captured_at, d.env.kept
    ));
    let removed: Vec<String> = d
        .env
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
    out.push(format!("  removed: {removed}"));
    out
}

/// The program the daemon reads its callers with, or a warning that there is none.
fn peer_reader_lines(reader: &Nullable<bazhen_protocol::daemon::PeerReader>) -> Vec<String> {
    match reader {
        Nullable::Null => vec![
            "peer reader: none".to_owned(),
            "  warning: the daemon can't read which process calls on its socket, so a call from \
             inside an agent that presents nothing passes as yours; pnpm build builds \
             bazhen-peer, so this install is incomplete"
                .to_owned(),
        ],
        Nullable::Value(reader) => vec![format!("peer reader: {}", reader.path)],
        Nullable::Absent => vec![],
    }
}

/// The `bazhen` agents find on their PATH, and a warning when there is none or it isn't the build
/// beside the daemon. A login shell's rc can add to the PATH after the daemon captured it, so it is said.
fn agent_cli_lines(cli: &AgentCli, login_shell: bool) -> Vec<String> {
    let rc = if login_shell {
        " (agents.shell = login: a PATH its rc adds is not in the one captured, so this may be wrong)"
    } else {
        ""
    };
    match (&cli.on_path, &cli.expected) {
        (Some(found), Some(built)) if found != built => vec![
            format!("agent CLI: {found}"),
            format!(
                "  warning: that is not the bazhen built with this daemon ({built}), so agents may \
                 speak another protocol; link {built} into a directory on the PATH agents start \
                 with{rc}"
            ),
        ],
        (Some(found), _) => vec![format!("agent CLI: {found}")],
        (None, built) => {
            let fix = match built {
                Some(built) => format!("link {built} into a directory on it"),
                None => "run pnpm build, then link target/release/bazhen into a directory on it"
                    .to_owned(),
            };
            vec![
                "agent CLI: none".to_owned(),
                format!(
                    "  warning: no bazhen on the PATH agents start with, so they can't run it; \
                     {fix}{rc}"
                ),
            ]
        }
    }
}

/// The config file, and the shell agents start through.
fn settings_lines(d: &DoctorResponse) -> Vec<String> {
    let found = if d.config.found {
        ""
    } else {
        " (none; defaults)"
    };
    let shell = match d.agents.shell {
        AgentShell::Direct => "direct",
        AgentShell::Login => "login",
    };
    let login = match d.agents.login_shell.as_deref() {
        Some(s) if !s.is_empty() => format!(" ({s})"),
        _ => String::new(),
    };
    vec![
        format!("config: {}{found}", d.config.path),
        format!("agents.shell: {shell}{login}"),
    ]
}

/// The origins the daemon admits besides loopback, whether browsers must pair, and the risks.
fn web_lines(web: &Web) -> Vec<String> {
    let mut out = vec![match web.from {
        None => "external origins: none (loopback only)".to_owned(),
        Some(from) => {
            let from = match from {
                OriginsFrom::Environment => "BAZHEN_EXTERNAL_ORIGINS",
                OriginsFrom::Config => "config",
            };
            format!(
                "external origins: {} (from {from})",
                web.external_origins.join(", ")
            )
        }
    }];
    let plain: Vec<&str> = web
        .external_origins
        .iter()
        .map(String::as_str)
        .filter(|o| is_plain_remote(o))
        .collect();
    if !plain.is_empty() {
        out.push(format!(
            "  warning: plain HTTP to another host ({}); anyone on the network can read the \
             traffic, device tokens included",
            plain.join(", ")
        ));
    }
    match &web.app {
        Nullable::Null => out.push(
            "web app: not built; `pnpm build` builds it, and the daemon serves only the API until \
             then"
                .to_owned(),
        ),
        Nullable::Value(app) => out.push(format!("web app: served from {app}")),
        Nullable::Absent => {}
    }
    if let Nullable::Value(lan) = &web.lan {
        out.extend(lan_lines(lan));
    }
    let Some(pairing) = &web.pairing else {
        return out;
    };
    let mode = match pairing.mode {
        bazhen_protocol::daemon::PairingMode::Auto => "auto",
        bazhen_protocol::daemon::PairingMode::Always => "always",
    };
    if pairing.required {
        out.push(format!(
            "pairing: required on every origin (web.pairing = \"{mode}\"); `bazhen devices pair`"
        ));
        return out;
    }
    out.push(format!(
        "pairing: not required on loopback (web.pairing = \"{mode}\", no external origins); a \
         request a proxy forwards from another machine must still pair"
    ));
    out.push(
        "  warning: any local process or other user of this machine who can reach the daemon's \
         port on 127.0.0.1 controls the agents; set web.pairing = \"always\" on a shared machine"
            .to_owned(),
    );
    out
}

/// The LAN listener: where it serves, to whom, and the certificate a browser must trust. A
/// listener that stopped says so first, though its certificate is loaded.
fn lan_lines(lan: &Lan) -> Vec<String> {
    let mut out = vec![format!("LAN: {}, to {}", lan.url, lan.allow.join(", "))];
    if let Some(error) = &lan.error {
        out.push(format!("  not serving: {error}"));
    }
    if let Some(c) = &lan.certificate {
        out.push(format!("  certificate SHA-256: {}", c.fingerprint));
        out.push(format!(
            "  certificate: {}, expires {}",
            c.path, c.expires_at
        ));
    }
    let subnets: Vec<String> = lan
        .subnets
        .iter()
        .map(|s| format!("{} ({})", s.cidr, s.interface))
        .collect();
    let subnets = if subnets.is_empty() {
        "none".to_owned()
    } else {
        subnets.join(", ")
    };
    out.push(format!("  this host's subnets: {subnets}"));
    out
}

/// The terminal budget and the machine's PTYs behind it.
fn terminal_lines(t: &Terminals) -> Vec<String> {
    let mut out = vec![format!(
        "terminals: {} open, at most {} (terminals.max_open)",
        t.open, t.max
    )];
    match t.refusing {
        Some(Refusing::Budget) => {
            out.push("  new agents and shells are refused until one is closed".to_owned());
        }
        Some(Refusing::Host) => {
            out.push(
                "  new agents and shells are refused: the machine is short of PTYs".to_owned(),
            );
        }
        None => {}
    }
    out.push(match &t.host {
        None => "  machine PTYs: can't be counted here".to_owned(),
        Some(h) if h.exact => format!("  machine PTYs: {} of {} in use", h.used, h.max),
        Some(h) => format!(
            "  machine PTYs: as many as {} of {} in use (the count includes closed ones)",
            h.used, h.max
        ),
    });
    out
}

/// Holder builds: the one new terminals run, and how many terminals run each.
fn holder_lines(h: &Holder) -> Vec<String> {
    let mut out = vec![match &h.build {
        None => format!(
            "holder: none installed ({})",
            h.reason.as_deref().unwrap_or("no reason given")
        ),
        Some(build) => format!(
            "holder: build {build} ({})",
            h.binary.as_deref().unwrap_or("no path")
        ),
    }];
    let mut groups: Vec<(String, usize)> = Vec::new();
    for holder in &h.holders {
        let named = match &holder.build {
            None => "an unknown build".to_owned(),
            Some(b) if Some(b) == h.build.as_ref() => b.clone(),
            Some(b) => format!("{b} (older build; restart to upgrade)"),
        };
        let key = format!("on {named}, protocol {}", holder.protocol.join(", "));
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some(group) => group.1 += 1,
            None => groups.push((key, 1)),
        }
    }
    for (key, count) in groups {
        let noun = if count == 1 { "terminal" } else { "terminals" };
        out.push(format!("  {count} {noun} {key}"));
    }
    out.extend(h.holders.iter().filter_map(holder_line));
    out
}

/// One holder: its process, its memory and its socket; none from a daemon that doesn't say.
fn holder_line(h: &RunningHolder) -> Option<String> {
    let socket = h.socket.as_deref()?;
    let Nullable::Value(pid) = h.holder_pid else {
        return Some(format!(
            "  {}: shares no protocol with this build; restart it ({socket})",
            h.terminal_id
        ));
    };
    let memory = match &h.stats {
        Nullable::Value(s) => {
            let resident = s.rss.map_or_else(
                || "resident size unknown".to_owned(),
                |b| format!("{} MiB resident", mib(b)),
            );
            format!(
                "{resident} (engine {} MiB, ring {} MiB), {} history lines",
                mib(s.engine_bytes),
                mib(s.ring_bytes),
                s.history_lines
            )
        }
        Nullable::Null | Nullable::Absent => "memory not reported".to_owned(),
    };
    Some(format!(
        "  {}: pid {pid}, {memory} ({socket})",
        h.terminal_id
    ))
}

/// A cap as people read it: `50% (31.0 GiB)`, `0 (none)`, or `infinity (no cap)`.
fn cap(c: &MemoryCap) -> String {
    let size = match c.bytes {
        None => "no cap".to_owned(),
        Some(0) => "none".to_owned(),
        Some(b) => format!("{} GiB", gib(b)),
    };
    format!("{} ({size})", c.asked)
}

/// Whether new holder terminals start in a scope of their own, with what caps, and which
/// terminals run outside one.
fn containment_lines(c: &Containment, holders: &[RunningHolder], tmux: bool) -> Vec<String> {
    let mut out = match c {
        Containment::Unchecked => vec![
            "containment: not checked yet (no holder terminal has started since the daemon did)"
                .to_owned(),
        ],
        Containment::Uncontained { why } => vec![
            format!("containment: none ({why})"),
            "  warning: one terminal's runaway memory can end every other terminal".to_owned(),
        ],
        Containment::Scoped {
            systemd,
            oom_policy,
            terminal,
            total,
            swap,
        } => {
            let mut lines = vec![format!(
                "containment: each holder terminal in a systemd scope of its own, at most {} each \
                 with {} of swap, and {} together",
                cap(terminal),
                cap(swap),
                cap(total)
            )];
            if !oom_policy {
                lines.push(format!(
                    "  note: systemd {systemd} predates OOMPolicy for scopes (253), so the kernel \
                     alone decides what dies past a cap"
                ));
            }
            lines
        }
    };
    let outside = holders
        .iter()
        .filter(|h| h.contained == Nullable::Value(false))
        .count();
    if outside > 0 {
        let which = if outside == 1 {
            "1 holder terminal runs".to_owned()
        } else {
            format!("{outside} holder terminals run")
        };
        let fix = match (c, outside) {
            (Containment::Scoped { .. }, 1) => "; restart it to contain it",
            (Containment::Scoped { .. }, _) => "; restart them to contain them",
            _ => "",
        };
        out.push(format!("  {which} outside a scope{fix}"));
    }
    if tmux {
        out.push("  tmux terminals are not contained".to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use bazhen_client::sha256::{hex, sha256};
    use std::path::PathBuf;

    /// The id is what `protocolId()` makes of the committed schema, hashed here by the Rust side's
    /// own reading of the contract: each `name\0content\0`, in name order.
    #[test]
    fn speaks_the_protocol_the_committed_schema_hashes_to() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/schema");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| {
                std::path::Path::new(n)
                    .extension()
                    .is_some_and(|e| e == "json")
            })
            .collect();
        names.sort();
        let mut text = Vec::new();
        for name in &names {
            text.extend_from_slice(name.as_bytes());
            text.push(0);
            text.extend_from_slice(&std::fs::read(dir.join(name)).unwrap());
            text.push(0);
        }
        assert!(names.iter().any(|n| n == "semantics.json"), "{names:?}");
        assert_eq!(hex(&sha256(&text)), PROTOCOL_ID);
    }

    #[test]
    fn warns_of_a_daemon_that_speaks_another_protocol() {
        let ours = build_lines("0.1.0", PROTOCOL_ID, ", running");
        let theirs = build_lines("0.1.0", &"f".repeat(64), "");
        assert_eq!(
            ours,
            [format!(
                "bazhen 0.1.0 (protocol {}), running",
                short_id(PROTOCOL_ID)
            )]
        );
        assert_eq!(
            theirs,
            [
                "bazhen 0.1.0 (protocol ffffffffffff)".to_owned(),
                format!(
                    "  warning: this CLI speaks protocol {}; {ANOTHER_BUILD}",
                    short_id(PROTOCOL_ID)
                ),
            ]
        );
    }

    fn cli(expected: Option<&str>, on_path: Option<&str>) -> AgentCli {
        AgentCli {
            expected: expected.map(str::to_owned),
            on_path: on_path.map(str::to_owned),
        }
    }

    #[test]
    fn says_which_bazhen_agents_find_and_warns_of_another_build() {
        let same = agent_cli_lines(&cli(Some("/r/bazhen"), Some("/r/bazhen")), false);
        let unbuilt = agent_cli_lines(&cli(None, Some("/h/bazhen")), false);
        let other = agent_cli_lines(&cli(Some("/r/bazhen"), Some("/h/bazhen")), false);
        assert_eq!(same, ["agent CLI: /r/bazhen"]);
        assert_eq!(unbuilt, ["agent CLI: /h/bazhen"]);
        assert_eq!(
            other,
            [
                "agent CLI: /h/bazhen",
                "  warning: that is not the bazhen built with this daemon (/r/bazhen), so agents \
                 may speak another protocol; link /r/bazhen into a directory on the PATH agents \
                 start with"
            ]
        );
    }

    #[test]
    fn warns_when_the_path_agents_start_with_holds_no_bazhen() {
        let built = agent_cli_lines(&cli(Some("/r/bazhen"), None), false);
        let unbuilt = agent_cli_lines(&cli(None, None), false);
        assert_eq!(
            built,
            [
                "agent CLI: none",
                "  warning: no bazhen on the PATH agents start with, so they can't run it; link \
                 /r/bazhen into a directory on it"
            ]
        );
        assert_eq!(
            unbuilt[1],
            "  warning: no bazhen on the PATH agents start with, so they can't run it; run pnpm build, \
             then link target/release/bazhen into a directory on it"
        );
    }

    #[test]
    fn says_a_login_shells_rc_may_change_the_path() {
        let lines = agent_cli_lines(&cli(Some("/r/bazhen"), None), true);
        assert!(
            lines[1].ends_with(
                "on it (agents.shell = login: a PATH its rc adds is not in the one captured, so this may be wrong)"
            ),
            "{lines:?}"
        );
    }
}
