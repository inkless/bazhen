//! A terminal's stream, `/v1/terminals/:id/stream`: the text frames a view and the daemon send
//! each other over its WebSocket. The terminal's output, and a view's keystrokes, are binary
//! frames, never one of these.

use serde::{Deserialize, Serialize};

use crate::agents::ExitStatus;
use crate::ids::AttachmentId;

/// The largest frame a view may send.
pub const STREAM_FRAME_MAX_BYTES: usize = 1 << 20;

/// The history each new terminal keeps, in lines, when its config names none.
pub const HISTORY_LINES: u32 = 10_000;

/// Whether a view may drive the terminal, or only watches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum AttachmentMode {
    Observe,
    Interactive,
}

impl AttachmentMode {
    /// The mode as the protocol spells it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Interactive => "interactive",
        }
    }
}

/// A view's own earlier attachment, which it ends as it reattaches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Resumes {
    pub attachment_id: AttachmentId,
    #[cfg_attr(feature = "schema", schemars(length(max = 64)))]
    pub token: String,
}

/// A text frame a view sends. `Hello` comes first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamClientFrame {
    #[serde(rename_all = "camelCase")]
    Hello {
        /// The build the view is from; a daemon of another refuses it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "String"))]
        protocol_id: Option<String>,
        mode: AttachmentMode,
        #[cfg_attr(feature = "schema", schemars(range(min = 2, max = 1000)))]
        cols: u16,
        #[cfg_attr(feature = "schema", schemars(range(min = 2, max = 1000)))]
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "Resumes"))]
        resumes: Option<Resumes>,
    },
    Resize {
        #[cfg_attr(feature = "schema", schemars(range(min = 2, max = 1000)))]
        cols: u16,
        #[cfg_attr(feature = "schema", schemars(range(min = 2, max = 1000)))]
        rows: u16,
    },
    /// Takes the lease, as a click in the web app does.
    Engage,
    /// The lease epoch the view's following input is typed under.
    Epoch {
        epoch: u64,
    },
    Ping,
}

/// Why the daemon ended a view while the terminal goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EndedReason {
    /// It fell too far behind the terminal's output.
    EvictedSlow,
    /// The daemon's client lost the terminal.
    Disconnected,
}

/// A text frame the daemon sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamServerFrame {
    #[serde(rename_all = "camelCase")]
    Attached {
        attachment_id: AttachmentId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "String"))]
        resume_token: Option<String>,
    },
    /// Who drives now.
    #[serde(rename_all = "camelCase")]
    Lease {
        driver: bool,
        epoch: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "bool"))]
        driven: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "String"))]
        driver_device: Option<String>,
    },
    Pong,
    /// The binary frames until `SnapshotEnd` are the terminal's history and screen.
    #[serde(rename_all = "camelCase")]
    SnapshotStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "schema", schemars(with = "u64"))]
        history_lines: Option<u64>,
    },
    SnapshotEnd,
    Geometry {
        #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 1000)))]
        cols: u16,
        #[cfg_attr(feature = "schema", schemars(range(min = 1, max = 1000)))]
        rows: u16,
    },
    /// Input from a view that wasn't driving was dropped.
    InputDropped,
    Screen {
        alternate: bool,
    },
    /// The terminal's process of `generation` exited, after the last of its output. The
    /// terminal goes on.
    Exited {
        generation: u64,
        exit: ExitStatus,
    },
    /// The terminal closed, and the view with it.
    Closed,
    Ended {
        reason: EndedReason,
    },
    /// The view can't go on.
    Error {
        message: String,
    },
    /// Something went wrong that the view can live with.
    Notice {
        message: String,
    },
}
