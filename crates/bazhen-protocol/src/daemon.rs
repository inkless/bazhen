//! The daemon's own answers: its health, what `bazhen doctor` shows, an environment refresh and a
//! stop.

use serde::{Deserialize, Serialize};

use crate::ids::AgentId;
use crate::nullable::Nullable;
use crate::record::Record;
use crate::shells::BusyShell;

/// A runtime's state as the daemon reports it: its health when it was read, or `Unused` when it
/// wasn't, since it is not the default and no terminal is open on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeReportState {
    Healthy,
    Unreachable,
    NotRunning,
    Unused,
}

/// One runtime's health, as `bazhen status` and `bazhen doctor` show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeHealthReport {
    pub kind: String,
    pub state: RuntimeReportState,
    pub version: Option<String>,
    /// Each defect of this runtime's that Bazhen works around.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workarounds: Option<Vec<String>>,
}

/// A health answer's status, which is only ever "ok".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
}

/// `GET /v1/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub app_version: String,
    /// The protocol the daemon speaks: a client of another is another build, to restart.
    pub protocol_id: String,
    /// Every runtime, each read by itself.
    pub runtimes: Vec<RuntimeHealthReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookClient {
    pub path: String,
    pub fallback: bool,
}

/// The program the daemon reads which process calls on its socket with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerReader {
    pub path: String,
}

/// The `bazhen` agents run: the first on the PATH the daemon captured for them, and the one built
/// beside the daemon, each as a resolved path, none as null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCli {
    pub expected: Option<String>,
    pub on_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigFile {
    pub path: String,
    pub found: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentShell {
    Direct,
    Login,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSettings {
    pub shell: AgentShell,
    pub login_shell: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Codex {
    pub daemon: Option<String>,
    pub cli: Option<String>,
    /// Whether the peer reader knows the app-server for Codex's, read while a Codex agent is live;
    /// null otherwise, and absent from an older daemon.
    #[serde(
        rename = "toolCalls",
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub tool_calls: Nullable<ToolCalls>,
}

/// What the peer reader made of Codex's app-server, whose commands it must tell from the human's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolCalls {
    /// It reads the server as Codex's.
    Marked,
    /// It reads the server as no Codex app-server: a Codex agent's commands could read as yours.
    Unmarked,
    /// It couldn't read the server.
    Unread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OriginsFrom {
    #[serde(rename = "BAZHEN_EXTERNAL_ORIGINS")]
    Environment,
    #[serde(rename = "config")]
    Config,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairingMode {
    Auto,
    Always,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pairing {
    pub mode: PairingMode,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub fingerprint: String,
    pub path: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subnet {
    pub interface: String,
    pub cidr: String,
}

/// The LAN listener, where one is configured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lan {
    pub url: String,
    pub allow: Vec<String>,
    pub certificate: Option<Certificate>,
    pub error: Option<String>,
    pub subnets: Vec<Subnet>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Web {
    pub external_origins: Vec<String>,
    pub from: Option<OriginsFrom>,
    pub allow_insecure_origins: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<Pairing>,
    /// The built web client, null before `moon run :build`; absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub app: Nullable<String>,
    /// Why the build where the daemon looks isn't served, `app` null then; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_refused: Option<String>,
    /// The LAN listener, null without one; absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub lan: Nullable<Lan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notifications {
    pub desktop: bool,
    pub notifier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPtys {
    pub used: u64,
    pub max: u64,
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Refusing {
    Budget,
    Host,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Terminals {
    pub open: u64,
    pub max: u64,
    pub host: Option<HostPtys>,
    pub refusing: Option<Refusing>,
}

/// A holder that answered, the build it runs, and the holder/1 versions it speaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningHolder {
    pub terminal_id: String,
    pub build: Option<String>,
    pub protocol: Vec<String>,
    /// Whether it runs in a scope of its own: null where that can't be told, absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub contained: Nullable<bool>,
    /// The socket it answers on; absent from an older daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
    /// Its process: null for one that shares no protocol with this build, which names none;
    /// absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub holder_pid: Nullable<u64>,
    /// Its memory, as it reports it: null where it didn't; absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub stats: Nullable<HolderStats>,
}

/// A holder's memory, in bytes, and the lines of history it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolderStats {
    pub engine_bytes: u64,
    /// Null where the OS won't say.
    pub rss: Option<u64>,
    pub ring_bytes: u64,
    pub history_lines: u64,
    /// Attempts to replace a failed engine; absent from a holder before 1.2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_resets: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holder {
    pub binary: Option<String>,
    pub build: Option<String>,
    pub reason: Option<String>,
    pub holders: Vec<RunningHolder>,
}

/// A memory cap as configured, and the bytes it came to, null for no cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCap {
    pub asked: String,
    pub bytes: Option<u64>,
}

impl MemoryCap {
    /// The cap as people read it: `50% (31.0 GiB)`, `0 (none)`, or `infinity (no cap)`
    /// (`memoryCapText`).
    pub fn text(&self) -> String {
        let size = match self.bytes {
            None => "no cap".to_owned(),
            Some(0) => "none".to_owned(),
            Some(bytes) => format!("{} GiB", gib(bytes)),
        };
        format!("{} ({size})", self.asked)
    }
}

/// `bytes` in GiB to one decimal, rounded as JavaScript's `toFixed(1)` rounds: a tie upward, where
/// Rust's `{:.1}` would round it to even.
fn gib(bytes: u64) -> String {
    let unit: u128 = 1 << 30;
    let tenths = (u128::from(bytes) * 20 + unit) / (2 * unit);
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// Whether new holder terminals start in a systemd scope of their own, and with what caps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Containment {
    #[serde(rename_all = "camelCase")]
    Scoped {
        systemd: u64,
        oom_policy: bool,
        terminal: MemoryCap,
        total: MemoryCap,
        swap: MemoryCap,
    },
    Uncontained {
        why: String,
    },
    Unchecked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvSource {
    Start,
    Refresh,
}

/// The environment the daemon captured, counted, never listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedEnv {
    pub captured_at: String,
    pub source: EnvSource,
    pub kept: u64,
    pub removed: Record<u64>,
}

/// `GET /v1/daemon/doctor`: what `bazhen doctor` shows. Each optional part is absent from a daemon
/// older than it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResponse {
    pub app_version: String,
    pub protocol_id: String,
    pub runtimes: Vec<RuntimeHealthReport>,
    pub hook_client: HookClient,
    /// Null when none is installed, an incomplete install; absent from an older daemon.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub peer_reader: Nullable<PeerReader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_cli: Option<AgentCli>,
    pub config: ConfigFile,
    pub agents: AgentsSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<Codex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<Web>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<Notifications>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminals: Option<Terminals>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<Holder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub containment: Option<Containment>,
    pub env: CapturedEnv,
}

/// `POST /v1/daemon/env`: the environment of the shell running `bazhen env refresh`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvRefreshRequest {
    pub env: Record<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvRefreshResponse {
    pub captured_at: String,
    pub kept: u64,
    pub removed: Record<u64>,
    /// Names left as they were, because tmux can't take their name or value as data.
    pub refused: Vec<String>,
    /// Agents running now, which keep the environment they started with until respawned.
    pub unchanged: Vec<AgentId>,
}

/// `POST /v1/daemon/stop`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StopResponse {}

/// What every refused request answers, whatever the route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: ErrorCode,
    pub message: String,
    /// With `busy`: each shell, and what runs in it, that the close would end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub busy: Option<Vec<BusyShell>>,
}

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    Unsupported,
    /// The agent's process could not be started; repeating won't help until the reason changes.
    LaunchFailed,
    Conflict,
    StaleGeneration,
    NotResumable,
    Unavailable,
    /// A close found no terminal, but the server it ran on may still run it.
    ServerUnconfirmed,
    /// A close reached a holder this build can't speak to.
    NeedsRestart,
    /// A shell close found a program other than the shell running.
    Busy,
    NotFound,
    OriginNotAllowed,
    HostNotAllowed,
    Forbidden,
    /// No device cookie, or one revoked or expired: the browser must pair.
    Unpaired,
    /// The code was wrong, expired, used or burned; which one is not said.
    PairingFailed,
    RateLimited,
    /// A new agent or shell refused: as many terminals are open as the daemon allows.
    TerminalLimit,
}
