//! Notices for the human that no agent raised, and the devices paired to the daemon.

use serde::{Deserialize, Serialize};

use crate::ids::{DeviceId, NoticeId};

/// RFC 4648 base32: what a pairing code is drawn from.
pub const PAIRING_ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
pub const PAIRING_CODE_LENGTH: usize = 8;

/// The most characters a device's name holds, as JavaScript counts them: UTF-16 code units.
pub const DEVICE_NAME_MAX: usize = 64;

/// The one kind of notice a daemon opens today: a device paired.
pub const DEVICE_PAIRED: &str = "device_paired";

/// Why a notice closed: the human put it away, or the device it is about was revoked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeCloseReason {
    Dismissed,
    Revoked,
}

impl NoticeCloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dismissed => "dismissed",
            Self::Revoked => "revoked",
        }
    }
}

/// Who closed a notice: the owner on the Unix socket, the owner from a loopback browser where no
/// device must pair, or the device's revocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeCloser {
    OwnerSocket,
    OwnerLoopback,
    Revoke,
}

impl NoticeCloser {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnerSocket => "owner-socket",
            Self::OwnerLoopback => "owner-loopback",
            Self::Revoke => "revoke",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeState {
    Open,
    Closed,
}

/// The device a notice is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeDevice {
    pub id: DeviceId,
    pub name: String,
    pub origin: String,
    pub address: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosedFrom {
    pub id: DeviceId,
    pub name: String,
}

/// A notice. `kind`, `close_reason` and `actions` are strings, not enums: a value a later daemon
/// adds must not fail an older client's whole snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: NoticeId,
    pub kind: String,
    pub state: NoticeState,
    pub close_reason: Option<String>,
    pub summary: String,
    pub opened_at: String,
    pub device: Option<NoticeDevice>,
    pub actions: Vec<String>,
    pub closed_by: Option<String>,
    pub closed_from: Option<ClosedFrom>,
}

/// `POST /v1/notices/:id/dismiss`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissNoticeRequest {
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissNoticeResponse {
    pub event_ids: Vec<u64>,
}

/// `POST /v1/pairing`: a browser trades a code for a device cookie. The code is as typed: case,
/// spaces and dashes don't matter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The token itself travels only in the `Set-Cookie` header of this response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: DeviceId,
    pub name: String,
}

/// The LAN listener a pairing code names, with the certificate's fingerprint to check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLan {
    pub url: String,
    pub fingerprint: String,
    pub expires_at: String,
}

/// `POST /v1/pairing/codes`: a fresh code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeResponse {
    pub code: String,
    pub expires_at: String,
    pub origins: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan: Option<PairingLan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: DeviceId,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
}

/// `GET /v1/devices`: every device not revoked, expired ones too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesResponse {
    pub devices: Vec<Device>,
}

/// `POST /v1/devices/:id/revoke`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RevokeDeviceResponse {}
