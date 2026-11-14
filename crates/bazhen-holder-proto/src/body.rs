//! The JSON bodies of `holder/1`, each as its zod schema in `packages/protocol/src/holder.ts`
//! defines it. Every constraint a schema puts on a field is a type here, checked as the field is
//! read, so a value that exists is valid and encoding it can't fail on a field.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::json;

/// The largest integer a JSON number holds exactly for a JavaScript peer, `2^53 - 1`. Every
/// integer in `holder/1` is at most this, a binary frame's u64 offset included.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub const VERSION_MAX_BYTES: usize = 32;
pub const TAG_NAME_MAX_BYTES: usize = 64;
pub const TAG_VALUE_MAX_BYTES: usize = 1024;
pub const MAX_COLS: u64 = 1000;
pub const MAX_ROWS: u64 = 1000;
pub const MAX_HISTORY_LINES: u64 = 100_000;
pub const DEFAULT_HISTORY_LINES: u64 = 10_000;
/// Refused as tag names by every peer, because a JavaScript object would drop or misread them.
pub const RESERVED_TAG_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// A value outside what its field allows, as a field's type says why.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct Invalid(String);

/// An integer in `MIN..=MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Bounded<const MIN: u64, const MAX: u64>(u64);

impl<const MIN: u64, const MAX: u64> Bounded<MIN, MAX> {
    /// # Errors
    ///
    /// When `n` is outside `MIN..=MAX`.
    pub fn new(n: u64) -> Result<Self, Invalid> {
        if (MIN..=MAX).contains(&n) {
            Ok(Self(n))
        } else {
            Err(Invalid(format!("{n} is outside {MIN}..={MAX}")))
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<const MIN: u64, const MAX: u64> TryFrom<u64> for Bounded<MIN, MAX> {
    type Error = Invalid;

    fn try_from(n: u64) -> Result<Self, Invalid> {
        Self::new(n)
    }
}

impl<const MIN: u64, const MAX: u64> From<Bounded<MIN, MAX>> for u64 {
    fn from(n: Bounded<MIN, MAX>) -> Self {
        n.0
    }
}

pub type Count = Bounded<0, MAX_SAFE_INTEGER>;
/// A byte offset in the terminal's output since its generation began.
pub type Offset = Count;
pub type Generation = Count;
/// Epoch seconds, as `ps -o lstart` gives a process's start, so a pid can be checked for reuse.
pub type StartTime = Count;
pub type Pid = Bounded<1, MAX_SAFE_INTEGER>;
/// Up to the maximum; the holder clamps a size too small to use, a zero included.
pub type Cols = Bounded<0, MAX_COLS>;
pub type Rows = Bounded<0, MAX_ROWS>;
pub type HistoryLines = Bounded<0, MAX_HISTORY_LINES>;

/// An exit code: any integer a JavaScript peer holds exactly, negative ones included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct ExitCode(i64);

impl ExitCode {
    /// # Errors
    ///
    /// When `code` is past `±MAX_SAFE_INTEGER`.
    pub fn new(code: i64) -> Result<Self, Invalid> {
        if code.unsigned_abs() <= MAX_SAFE_INTEGER {
            Ok(Self(code))
        } else {
            Err(Invalid(format!("{code} is past ±(2^53 - 1)")))
        }
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

impl TryFrom<i64> for ExitCode {
    type Error = Invalid;

    fn try_from(code: i64) -> Result<Self, Invalid> {
        Self::new(code)
    }
}

impl From<ExitCode> for i64 {
    fn from(code: ExitCode) -> Self {
        code.0
    }
}

/// A string of `MIN..=MAX` UTF-8 bytes. The TypeScript peer counts the same bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Utf8<const MAX: usize, const MIN: usize = 0>(String);

impl<const MAX: usize, const MIN: usize> Utf8<MAX, MIN> {
    /// # Errors
    ///
    /// When `text` is shorter than `MIN` or longer than `MAX` bytes.
    pub fn new(text: impl Into<String>) -> Result<Self, Invalid> {
        let text = text.into();
        if (MIN..=MAX).contains(&text.len()) {
            Ok(Self(text))
        } else {
            Err(Invalid(format!(
                "{} bytes is outside {MIN}..={MAX}",
                text.len()
            )))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MAX: usize, const MIN: usize> TryFrom<String> for Utf8<MAX, MIN> {
    type Error = Invalid;

    fn try_from(text: String) -> Result<Self, Invalid> {
        Self::new(text)
    }
}

impl<const MAX: usize, const MIN: usize> From<Utf8<MAX, MIN>> for String {
    fn from(text: Utf8<MAX, MIN>) -> Self {
        text.0
    }
}

/// A string of at least one character.
pub type NonEmpty = Utf8<{ usize::MAX }, 1>;
pub type TagName = Utf8<TAG_NAME_MAX_BYTES, 1>;
pub type TagValue = Utf8<TAG_VALUE_MAX_BYTES>;
/// One entry of a version list, read leniently: one this build can't parse is skipped when
/// negotiating, not refused with the frame.
pub type VersionText = Utf8<VERSION_MAX_BYTES>;

/// The highest version a peer speaks in each major it supports, 1 to 16 of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<VersionText>", into = "Vec<VersionText>")]
pub struct Versions(Vec<VersionText>);

impl Versions {
    /// # Errors
    ///
    /// When there are no versions, or more than 16.
    pub fn new(versions: Vec<VersionText>) -> Result<Self, Invalid> {
        if (1..=16).contains(&versions.len()) {
            Ok(Self(versions))
        } else {
            Err(Invalid(format!(
                "{} versions is outside 1..=16",
                versions.len()
            )))
        }
    }

    pub fn as_slice(&self) -> &[VersionText] {
        &self.0
    }

    pub(crate) fn texts(&self) -> Vec<&str> {
        self.0.iter().map(Utf8::as_str).collect()
    }
}

impl TryFrom<Vec<VersionText>> for Versions {
    type Error = Invalid;

    fn try_from(versions: Vec<VersionText>) -> Result<Self, Invalid> {
        Self::new(versions)
    }
}

impl From<Versions> for Vec<VersionText> {
    fn from(versions: Versions) -> Self {
        versions.0
    }
}

impl AsRef<str> for Utf8<VERSION_MAX_BYTES> {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// `major.minor` in ASCII digits, as an agreed version is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ProtocolVersion(String);

impl ProtocolVersion {
    /// # Errors
    ///
    /// When `text` isn't digits, a dot and digits.
    pub fn new(text: impl Into<String>) -> Result<Self, Invalid> {
        let text = text.into();
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        match text.split_once('.') {
            Some((major, minor)) if digits(major) && digits(minor) => Ok(Self(text)),
            _ => Err(Invalid(format!("{text:?} is not major.minor"))),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ProtocolVersion {
    type Error = Invalid;

    fn try_from(text: String) -> Result<Self, Invalid> {
        Self::new(text)
    }
}

impl From<ProtocolVersion> for String {
    fn from(version: ProtocolVersion) -> Self {
        version.0
    }
}

/// Names the holder's socket file, so it stays a plain file name: 1 to 64 of `[A-Za-z0-9_-]`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TerminalId(String);

impl TerminalId {
    /// # Errors
    ///
    /// When `text` isn't 1 to 64 of `[A-Za-z0-9_-]`.
    pub fn new(text: impl Into<String>) -> Result<Self, Invalid> {
        let text = text.into();
        let plain = text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if plain && (1..=64).contains(&text.len()) {
            Ok(Self(text))
        } else {
            Err(Invalid(format!("{text:?} is not a terminal id")))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for TerminalId {
    type Error = Invalid;

    fn try_from(text: String) -> Result<Self, Invalid> {
        Self::new(text)
    }
}

impl From<TerminalId> for String {
    fn from(id: TerminalId) -> Self {
        id.0
    }
}

/// Whatever the daemon writes beside a terminal: the holder stores and echoes them, and reads
/// none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    try_from = "BTreeMap<TagName, TagValue>",
    into = "BTreeMap<TagName, TagValue>"
)]
pub struct Tags(BTreeMap<TagName, TagValue>);

impl Tags {
    /// # Errors
    ///
    /// When a tag name is one of `RESERVED_TAG_NAMES`.
    pub fn new(tags: BTreeMap<TagName, TagValue>) -> Result<Self, Invalid> {
        match tags
            .keys()
            .find(|name| RESERVED_TAG_NAMES.contains(&name.as_str()))
        {
            Some(name) => Err(Invalid(format!("tag name {} is reserved", name.as_str()))),
            None => Ok(Self(tags)),
        }
    }

    pub fn as_map(&self) -> &BTreeMap<TagName, TagValue> {
        &self.0
    }
}

impl TryFrom<BTreeMap<TagName, TagValue>> for Tags {
    type Error = Invalid;

    fn try_from(tags: BTreeMap<TagName, TagValue>) -> Result<Self, Invalid> {
        Self::new(tags)
    }
}

impl From<Tags> for BTreeMap<TagName, TagValue> {
    fn from(tags: Tags) -> Self {
        tags.0
    }
}

/// Refused as environment names by every peer, because a JavaScript record drops them.
pub const RESERVED_ENV_NAMES: [&str; 1] = ["__proto__"];

/// A program's environment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    try_from = "BTreeMap<String, String>",
    into = "BTreeMap<String, String>"
)]
pub struct Env(BTreeMap<String, String>);

impl Env {
    /// # Errors
    ///
    /// When a name is one of `RESERVED_ENV_NAMES`.
    pub fn new(env: BTreeMap<String, String>) -> Result<Self, Invalid> {
        match env
            .keys()
            .find(|name| RESERVED_ENV_NAMES.contains(&name.as_str()))
        {
            Some(name) => Err(Invalid(format!("environment name {name} is reserved"))),
            None => Ok(Self(env)),
        }
    }

    pub fn as_map(&self) -> &BTreeMap<String, String> {
        &self.0
    }
}

impl TryFrom<BTreeMap<String, String>> for Env {
    type Error = Invalid;

    fn try_from(env: BTreeMap<String, String>) -> Result<Self, Invalid> {
        Self::new(env)
    }
}

impl From<Env> for BTreeMap<String, String> {
    fn from(env: Env) -> Self {
        env.0
    }
}

/// A program's argv: at least its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct Argv(Vec<String>);

impl Argv {
    /// # Errors
    ///
    /// When `argv` is empty.
    pub fn new(argv: Vec<String>) -> Result<Self, Invalid> {
        if argv.is_empty() {
            Err(Invalid("argv is empty".to_owned()))
        } else {
            Ok(Self(argv))
        }
    }

    pub fn as_slice(&self) -> &[String] {
        &self.0
    }
}

impl TryFrom<Vec<String>> for Argv {
    type Error = Invalid;

    fn try_from(argv: Vec<String>) -> Result<Self, Invalid> {
        Self::new(argv)
    }
}

impl From<Argv> for Vec<String> {
    fn from(argv: Argv) -> Self {
        argv.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub cols: Cols,
    pub rows: Rows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Signal {
    Sigint,
    Sigterm,
    Sighup,
    Sigkill,
}

/// The background a program is told it is drawn on, when it asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
}

/// How a child ended: with a code, by a signal named as in `SIGTERM`, or in a way not known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExitStatus {
    Exited { code: ExitCode },
    Signalled { signal: String },
    Unknown,
}

/// What a terminal runs. `respawn` replaces it, keeping the terminal, its tags and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessSpec {
    pub argv: Argv,
    pub cwd: NonEmpty,
    pub env: Env,
    pub generation: Generation,
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme: Option<Theme>,
}

fn default_history_lines() -> HistoryLines {
    Bounded(DEFAULT_HISTORY_LINES)
}

/// What a holder reads from its stdin when the daemon starts it; `decode_spawn_spec` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub argv: Argv,
    pub cwd: NonEmpty,
    pub env: Env,
    pub generation: Generation,
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme: Option<Theme>,
    /// The daemon's versions.
    pub protocol: Versions,
    pub terminal_id: TerminalId,
    pub socket: NonEmpty,
    pub tags: Tags,
    #[serde(deserialize_with = "json::object")]
    pub size: Size,
    #[serde(default = "default_history_lines")]
    pub history_lines: HistoryLines,
}

/// What every major reads of a spawn spec or a `hello` request first: the frozen `protocol`.
#[derive(Debug, Deserialize)]
pub(crate) struct FrozenProtocol {
    pub(crate) protocol: Versions,
}

/// Opens every connection, with the versions the client speaks; `writer` asks for the slot whose
/// `input` the holder takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloRequest {
    pub protocol: Versions,
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub writer: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeFrom {
    pub generation: Generation,
    pub offset: Offset,
}

/// Output from `from` on, or from the holder's offset as it reads the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeRequest {
    #[serde(
        default,
        deserialize_with = "json::optional_object",
        skip_serializing_if = "Option::is_none"
    )]
    pub from: Option<SubscribeFrom>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalRequest {
    pub signal: Signal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetTagsRequest {
    pub tags: Tags,
}

/// `None` tells a program that asks nothing of the holder's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetThemeRequest {
    #[serde(deserialize_with = "json::nullable")]
    pub theme: Option<Theme>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloReply {
    /// The version agreed on, in which both sides speak from here on.
    pub version: ProtocolVersion,
    /// Every version the holder speaks.
    pub protocol: Versions,
    pub terminal_id: TerminalId,
    pub tags: Tags,
    pub generation: Generation,
    pub holder_pid: Pid,
    pub holder_start: StartTime,
    pub child_pid: Pid,
    pub child_start: StartTime,
    /// How the child ended; `None` while it runs.
    #[serde(deserialize_with = "json::nullable_object")]
    pub exit: Option<ExitStatus>,
    #[serde(deserialize_with = "json::object")]
    pub size: Size,
    pub offset: Offset,
    pub title: String,
    pub alternate: bool,
    pub history_lines: Count,
    pub writer: bool,
}

/// What every major reads of a hello reply first, to know which major's schema the rest is in.
#[derive(Debug, Deserialize)]
pub(crate) struct FrozenHelloReply {
    pub(crate) version: ProtocolVersion,
}

/// Memory per terminal. `rss` is `None` where the OS won't say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub engine_bytes: Count,
    #[serde(deserialize_with = "json::nullable")]
    pub rss: Option<Count>,
    pub ring_bytes: Count,
    pub history_lines: Count,
}

/// The PTY's foreground group, from its master, with start times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreground {
    pub child_pid: Pid,
    pub child_start: StartTime,
    pub pgid: Pid,
    pub pgid_start: StartTime,
}

/// The ring no longer holds `[from, to)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gap {
    pub from: Offset,
    pub to: Offset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resized {
    pub offset: Offset,
    pub cols: Cols,
    pub rows: Rows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Title {
    pub offset: Offset,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alternate {
    pub offset: Offset,
    pub on: bool,
}

/// The child of `generation` ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exited {
    pub generation: Generation,
    #[serde(deserialize_with = "json::object")]
    pub status: ExitStatus,
}

/// A new child runs on the same PTY.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Respawned {
    pub generation: Generation,
    pub child_pid: Pid,
    pub child_start: StartTime,
}

/// The `request` of `ok` and `error` names the request answered, for logs: its id says which.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OkBody {
    pub request: String,
}

/// The codes `error` carries in this version. A peer meets newer ones, so `code` is a string and
/// an unknown one is read as `failed`.
pub const ERROR_CODES: [&str; 10] = [
    "unknown-request",
    "stale-generation",
    "out-of-range",
    "invalid",
    "no-shared-version",
    "not-writer",
    "input-full",
    "exited",
    "snapshot-too-large",
    "failed",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub request: String,
    pub code: String,
    pub message: String,
    /// The holder's versions, with `no-shared-version`.
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub protocol: Option<Versions>,
}

#[cfg(test)]
mod tests {
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::*;

    fn read<T: DeserializeOwned>(value: Value) -> Result<T, serde_json::Error> {
        json::from_value(value)
    }

    #[test]
    fn an_optional_field_may_be_left_out_but_is_never_null() {
        let left_out = read::<HelloRequest>(json!({ "protocol": ["1.0"] })).unwrap();
        assert_eq!(left_out.writer, None);
        assert!(read::<HelloRequest>(json!({ "protocol": ["1.0"], "writer": null })).is_err());
    }

    #[test]
    fn a_nullable_field_may_be_null_but_is_never_left_out() {
        assert_eq!(
            read::<SetThemeRequest>(json!({ "theme": null }))
                .unwrap()
                .theme,
            None
        );
        assert!(read::<SetThemeRequest>(json!({})).is_err());
    }

    #[test]
    fn a_struct_is_never_read_from_an_array() {
        assert!(read::<Size>(json!([80, 24])).is_err());
        assert!(read::<SubscribeRequest>(json!({ "from": [0, 5] })).is_err());
        assert!(read::<Exited>(json!({ "generation": 0, "status": ["exited", 1] })).is_err());
    }

    #[test]
    fn a_nullable_struct_field_is_null_or_an_object_and_never_left_out() {
        let hello = |exit: Option<Value>| {
            let mut body = json!({
                "version": "1.0", "protocol": ["1.0"], "terminalId": "t", "tags": {},
                "generation": 0, "holderPid": 1, "holderStart": 0, "childPid": 2,
                "childStart": 0, "size": { "cols": 1, "rows": 1 }, "offset": 0, "title": "",
                "alternate": false, "historyLines": 0, "writer": false,
            });
            if let (Some(exit), Some(map)) = (exit, body.as_object_mut()) {
                map.insert("exit".to_owned(), exit);
            }
            read::<HelloReply>(body).map(|reply| reply.exit)
        };
        assert_eq!(hello(Some(Value::Null)).unwrap(), None);
        assert_eq!(
            hello(Some(json!({ "type": "unknown" }))).unwrap(),
            Some(ExitStatus::Unknown)
        );
        assert!(hello(Some(json!(["unknown"]))).is_err());
        assert!(hello(None).is_err());
    }

    #[test]
    fn limits_count_utf8_bytes() {
        assert!(TagValue::new("é".repeat(512)).is_ok());
        assert!(TagValue::new(format!("{}a", "é".repeat(512))).is_err());
        assert!(TagName::new("").is_err());
    }

    #[test]
    fn integers_stop_at_the_largest_safe_one() {
        assert!(Offset::new(MAX_SAFE_INTEGER).is_ok());
        assert!(Offset::new(MAX_SAFE_INTEGER + 1).is_err());
        assert!(Pid::new(0).is_err());
        assert!(ExitCode::new(-9_007_199_254_740_991).is_ok());
        assert!(ExitCode::new(-9_007_199_254_740_992).is_err());
    }

    #[test]
    fn refuses_a_reserved_tag_name() {
        for name in RESERVED_TAG_NAMES {
            assert!(
                read::<SetTagsRequest>(json!({ "tags": { name: "x" } })).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn a_spawn_spec_without_a_history_depth_gets_the_default() {
        let spec = read::<SpawnSpec>(json!({
            "argv": ["sh"], "cwd": "/", "env": {}, "generation": 0, "protocol": ["1.0"],
            "terminalId": "t", "socket": "/s", "tags": {}, "size": { "cols": 1, "rows": 1 },
        }))
        .unwrap();
        assert_eq!(spec.history_lines.get(), DEFAULT_HISTORY_LINES);
    }
}
