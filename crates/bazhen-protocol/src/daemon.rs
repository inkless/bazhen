//! The daemon's own answers: its health, what `bazhen doctor` shows, an environment refresh and a
//! stop.

use serde::{Deserialize, Serialize};

use crate::ids::AgentId;
use crate::nullable::Nullable;
use crate::record::Record;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeHealthState {
    Healthy,
    Unreachable,
    NotRunning,
}

/// One runtime's health, as `bazhen status` and `bazhen doctor` show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeHealthReport {
    pub kind: String,
    pub state: RuntimeHealthState,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tmux {
    Tmux,
}

/// tmux's health, the first runtime, as every daemon reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TmuxHealth {
    pub kind: Tmux,
    pub state: RuntimeHealthState,
    pub version: Option<String>,
}

/// `GET /v1/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub app_version: String,
    pub protocol_version: String,
    pub schema_version: u64,
    pub runtime: TmuxHealth,
    /// Every runtime, each read by itself; absent from a daemon before 1.49.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtimes: Option<Vec<RuntimeHealthReport>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorRuntime {
    pub state: RuntimeHealthState,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookClient {
    pub path: String,
    pub fallback: bool,
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
    /// The built web client, null before `pnpm build`; absent from a daemon before 1.33.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub app: Nullable<String>,
    /// The LAN listener, null without one; absent from a daemon before 1.36.
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
    /// Whether it runs in a scope of its own: null where that can't be told, absent before 1.53.
    #[serde(
        default,
        skip_serializing_if = "Nullable::is_absent",
        deserialize_with = "Nullable::present"
    )]
    pub contained: Nullable<bool>,
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
    pub protocol_version: String,
    pub runtime: DoctorRuntime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtimes: Option<Vec<RuntimeHealthReport>>,
    pub hook_client: HookClient,
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
