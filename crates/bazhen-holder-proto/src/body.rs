//! The JSON bodies of `holder/1`, each as its zod schema in `packages/protocol/src/holder.ts`
//! defines it. Every constraint a schema puts on a field is a type here, checked as the field is
//! read, so a value that exists is valid and encoding it can't fail on a field.

use std::collections::BTreeMap;
use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::json;
use crate::version::{PROTOCOL_VERSION, Version};

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

/// An integer in `MIN..=MAX`. `K` tells apart integers with the same bounds and other meanings,
/// so an offset can't be passed where a generation is wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64", bound = "K: Copy")]
pub struct Bounded<const MIN: u64, const MAX: u64, K = ()>(u64, PhantomData<K>);

impl<const MIN: u64, const MAX: u64, K> Bounded<MIN, MAX, K> {
    /// # Errors
    ///
    /// When `n` is outside `MIN..=MAX`.
    pub fn new(n: u64) -> Result<Self, Invalid> {
        if (MIN..=MAX).contains(&n) {
            Ok(Self(n, PhantomData))
        } else {
            Err(Invalid(format!("{n} is outside {MIN}..={MAX}")))
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl<const MIN: u64, const MAX: u64, K> TryFrom<u64> for Bounded<MIN, MAX, K> {
    type Error = Invalid;

    fn try_from(n: u64) -> Result<Self, Invalid> {
        Self::new(n)
    }
}

impl<const MIN: u64, const MAX: u64, K> From<Bounded<MIN, MAX, K>> for u64 {
    fn from(n: Bounded<MIN, MAX, K>) -> Self {
        n.0
    }
}

/// Tells an `Offset` apart from other integers with its bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OffsetKind;
/// Tells a `Generation` apart from other integers with its bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GenerationKind;
/// Tells a `StartTime` apart from other integers with its bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StartTimeKind;
/// Tells `Cols` apart from `Rows`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ColsKind;
/// Tells `Rows` apart from `Cols`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RowsKind;

pub type Count = Bounded<0, MAX_SAFE_INTEGER>;
/// A byte offset in the terminal's output since its generation began.
pub type Offset = Bounded<0, MAX_SAFE_INTEGER, OffsetKind>;
pub type Generation = Bounded<0, MAX_SAFE_INTEGER, GenerationKind>;
/// Epoch seconds, as `ps -o lstart` gives a process's start, so a pid can be checked for reuse.
pub type StartTime = Bounded<0, MAX_SAFE_INTEGER, StartTimeKind>;
pub type Pid = Bounded<1, MAX_SAFE_INTEGER>;
/// Up to the maximum; the holder clamps a size too small to use, a zero included.
pub type Cols = Bounded<0, MAX_COLS, ColsKind>;
pub type Rows = Bounded<0, MAX_ROWS, RowsKind>;
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

    /// The versions this build speaks, as a holder lists them in its hello reply.
    pub fn spoken() -> Self {
        Self(vec![Utf8(PROTOCOL_VERSION.to_owned())])
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

impl<const MAX: usize, const MIN: usize> AsRef<str> for Utf8<MAX, MIN> {
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

impl From<Version> for ProtocolVersion {
    fn from(version: Version) -> Self {
        Self(version.to_string())
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
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    try_from = "BTreeMap<String, String>",
    into = "BTreeMap<String, String>"
)]
pub struct Env(BTreeMap<String, String>);

/// By name alone: a value may be a secret, as a shell's report token is.
impl std::fmt::Debug for Env {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Env")
            .field(&self.0.keys().collect::<Vec<_>>())
            .finish()
    }
}

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
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSize")
)]
pub struct Size {
    pub cols: Cols,
    pub rows: Rows,
}

/// Read from a JSON string only: serde would also read an enum from a one-key object
/// (`{"SIGINT": null}`), which zod refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "&'static str")]
pub enum Signal {
    Sigint,
    Sigterm,
    Sighup,
    Sigkill,
}

impl Signal {
    pub const ALL: [Self; 4] = [Self::Sigint, Self::Sigterm, Self::Sighup, Self::Sigkill];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sigint => "SIGINT",
            Self::Sigterm => "SIGTERM",
            Self::Sighup => "SIGHUP",
            Self::Sigkill => "SIGKILL",
        }
    }
}

impl TryFrom<String> for Signal {
    type Error = Invalid;

    fn try_from(text: String) -> Result<Self, Invalid> {
        Self::ALL
            .into_iter()
            .find(|signal| signal.as_str() == text)
            .ok_or_else(|| Invalid(format!("{text:?} is not a holder/1 signal")))
    }
}

impl From<Signal> for &'static str {
    fn from(signal: Signal) -> Self {
        signal.as_str()
    }
}

/// The background a program is told it is drawn on, when it asks (OSC 10 and 11), in the colours
/// [`Theme::colours`] gives it. A terminal with no theme is told dark. Read from a JSON string
/// only, as `Signal` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "&'static str")]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub const ALL: [Self; 2] = [Self::Light, Self::Dark];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    /// The text and background a terminal in this theme is drawn in, which a program that asks is
    /// told: `HOLDER_THEME_COLOURS`, as the daemon and the web client draw them.
    pub const fn colours(self) -> ThemeColours {
        match self {
            Self::Light => ThemeColours {
                text: [0x20, 0x22, 0x25],
                background: [0xfd, 0xfd, 0xfd],
            },
            Self::Dark => ThemeColours {
                text: [0xea, 0xeb, 0xee],
                background: [0x0f, 0x0f, 0x10],
            },
        }
    }
}

/// A theme's colours, each as red, green and blue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeColours {
    pub text: [u8; 3],
    pub background: [u8; 3],
}

impl TryFrom<String> for Theme {
    type Error = Invalid;

    fn try_from(text: String) -> Result<Self, Invalid> {
        Self::ALL
            .into_iter()
            .find(|theme| theme.as_str() == text)
            .ok_or_else(|| Invalid(format!("{text:?} is not a holder/1 theme")))
    }
}

impl From<Theme> for &'static str {
    fn from(theme: Theme) -> Self {
        theme.as_str()
    }
}

/// How a child ended: with a code, by a signal named as in `SIGTERM`, or in a way not known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderExitStatus")
)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExitStatus {
    Exited { code: ExitCode },
    Signalled { signal: String },
    Unknown,
}

/// What a terminal runs. `respawn` replaces it, keeping the terminal, its tags and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderProcessSpec")
)]
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
    #[cfg_attr(feature = "schema", schemars(with = "Theme"))]
    pub theme: Option<Theme>,
}

fn default_history_lines() -> HistoryLines {
    Bounded(DEFAULT_HISTORY_LINES, PhantomData)
}

/// What a holder reads from its stdin when the daemon starts it; `decode_spawn_spec` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSpawnSpec")
)]
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
    #[cfg_attr(feature = "schema", schemars(with = "Theme"))]
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

impl SpawnSpec {
    /// What the terminal runs, as a `respawn` would give it.
    pub fn process(&self) -> ProcessSpec {
        ProcessSpec {
            argv: self.argv.clone(),
            cwd: self.cwd.clone(),
            env: self.env.clone(),
            generation: self.generation,
            theme: self.theme,
        }
    }
}

/// What every major reads of a spawn spec or a `hello` request first: the frozen `protocol`.
#[derive(Debug, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderHelloFrozen")
)]
pub(crate) struct FrozenProtocol {
    pub(crate) protocol: Versions,
}

/// Opens every connection, with the versions the client speaks; `writer` asks for the slot whose
/// `input` the holder takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderHelloRequest")
)]
pub struct HelloRequest {
    pub protocol: Versions,
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub writer: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSubscribeFrom")
)]
pub struct SubscribeFrom {
    pub generation: Generation,
    pub offset: Offset,
}

/// Output from `from` on. Without it, from the offset of a `snapshot` the connection was answered
/// just before, refused `stale-generation` if a respawn has since overtaken it; with no snapshot
/// just before, from the holder's offset as it reads the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSubscribeRequest")
)]
pub struct SubscribeRequest {
    #[serde(
        default,
        deserialize_with = "json::optional_object",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "SubscribeFrom"))]
    pub from: Option<SubscribeFrom>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSignalRequest")
)]
pub struct SignalRequest {
    pub signal: Signal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSetTagsRequest")
)]
pub struct SetTagsRequest {
    pub tags: Tags,
}

/// `None` is a terminal with no theme, which is told dark, as at spawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderSetThemeRequest")
)]
pub struct SetThemeRequest {
    #[serde(deserialize_with = "json::nullable")]
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Required<Theme>"))]
    pub theme: Option<Theme>,
}

/// Types text into the child as a paste, only if the program would read it as text now: see
/// `HolderPasteRequest` in `holder.ts` for the answers and their order. The text holds no C0 or
/// C1 control or DEL, and, unless marked with `brackets`, nothing beyond printable ASCII. Why a
/// text is refused never quotes it. Since 1.3.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderPasteRequest")
)]
#[serde(try_from = "PasteFields", into = "PasteFields")]
pub struct PasteRequest(PasteFields);

/// The text may hold a secret typed at a shell's prompt, so it is never shown.
impl std::fmt::Debug for PasteRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasteRequest")
            .field("generation", &self.0.generation)
            .field("brackets", &self.0.brackets)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderPasteFields")
)]
struct PasteFields {
    generation: Generation,
    text: String,
    brackets: bool,
}

impl PasteRequest {
    /// # Errors
    ///
    /// When `text` holds a control, or is unmarked and holds anything beyond printable ASCII.
    pub fn new(
        generation: Generation,
        text: impl Into<String>,
        brackets: bool,
    ) -> Result<Self, Invalid> {
        let text = text.into();
        if text
            .chars()
            .any(|c| c < ' ' || ('\u{7f}'..='\u{9f}').contains(&c))
        {
            return Err(Invalid("the text holds a control character".to_owned()));
        }
        if !brackets && !text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
            return Err(Invalid(
                "unmarked text holds more than printable ASCII".to_owned(),
            ));
        }
        Ok(Self(PasteFields {
            generation,
            text,
            brackets,
        }))
    }

    pub const fn generation(&self) -> Generation {
        self.0.generation
    }

    pub fn text(&self) -> &str {
        &self.0.text
    }

    /// Marked with the bracketed-paste sequences whether or not the program asked.
    pub const fn brackets(&self) -> bool {
        self.0.brackets
    }
}

impl TryFrom<PasteFields> for PasteRequest {
    type Error = Invalid;

    fn try_from(fields: PasteFields) -> Result<Self, Invalid> {
        Self::new(fields.generation, fields.text, fields.brackets)
    }
}

impl From<PasteRequest> for PasteFields {
    fn from(paste: PasteRequest) -> Self {
        paste.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderHelloReply")
)]
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
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<ExitStatus>")
    )]
    pub exit: Option<ExitStatus>,
    #[serde(deserialize_with = "json::object")]
    pub size: Size,
    pub offset: Offset,
    pub title: String,
    pub alternate: bool,
    pub history_lines: Count,
    pub writer: bool,
    /// False once the holder's terminal engine has failed for good: the terminal still runs, but
    /// the holder answers no program's queries and serves no `snapshot`. Since 1.2; a holder of
    /// 1.1 leaves it out.
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub engine: Option<bool>,
}

/// What every major reads of a hello reply first, to know which major's schema the rest is in.
#[derive(Debug, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderHelloReplyFrozen")
)]
pub(crate) struct FrozenHelloReply {
    pub(crate) version: ProtocolVersion,
}

/// Memory per terminal. `rss` is `None` where the OS won't say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderStats")
)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub engine_bytes: Count,
    #[serde(deserialize_with = "json::nullable")]
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Required<Count>"))]
    pub rss: Option<Count>,
    pub ring_bytes: Count,
    pub history_lines: Count,
    /// Attempts to replace a failed terminal engine with an empty one, at most the holder's
    /// `MOST_ENGINE_RESETS`: a failure after those is given up on, which `HelloReply::engine`
    /// false marks. Since 1.2.
    #[serde(
        default,
        deserialize_with = "json::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Count"))]
    pub engine_resets: Option<Count>,
}

/// The PTY's foreground group, from its master, with start times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderForeground")
)]
#[serde(rename_all = "camelCase")]
pub struct Foreground {
    pub child_pid: Pid,
    pub child_start: StartTime,
    pub pgid: Pid,
    pub pgid_start: StartTime,
}

/// Reads the screen shown as plain text, after the newest `history` rows of the main screen's
/// history: see `HolderScreenRequest` in `holder.ts` for the answers. Since 1.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderScreenRequest")
)]
pub struct ScreenRequest {
    pub history: Count,
}

/// The screen as text: a line a row, each ended by `\n`, with no other control, so it can be
/// printed to a terminal as it is. `history` is how many rows of the text are history. Since 1.4.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderScreen")
)]
#[serde(try_from = "ScreenFields", into = "ScreenFields")]
pub struct Screen(ScreenFields);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderScreenFields")
)]
struct ScreenFields {
    text: String,
    history: Count,
}

impl Screen {
    /// # Errors
    ///
    /// When `text` holds a control but a newline.
    pub fn new(text: impl Into<String>, history: Count) -> Result<Self, Invalid> {
        let text = text.into();
        if text.chars().any(|c| c != '\n' && c.is_control()) {
            return Err(Invalid("the text holds a control character".to_owned()));
        }
        Ok(Self(ScreenFields { text, history }))
    }

    pub fn text(&self) -> &str {
        &self.0.text
    }

    pub const fn history(&self) -> Count {
        self.0.history
    }
}

impl TryFrom<ScreenFields> for Screen {
    type Error = Invalid;

    fn try_from(fields: ScreenFields) -> Result<Self, Invalid> {
        Self::new(fields.text, fields.history)
    }
}

impl From<Screen> for ScreenFields {
    fn from(screen: Screen) -> Self {
        screen.0
    }
}

/// The subscriber isn't sent `[from, to)`: the ring no longer holds it, or the subscriber was
/// owed more `resized` than the holder keeps for one that lags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderGap")
)]
pub struct Gap {
    pub from: Offset,
    pub to: Offset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderResized")
)]
pub struct Resized {
    pub offset: Offset,
    pub cols: Cols,
    pub rows: Rows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderTitle")
)]
pub struct Title {
    pub offset: Offset,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderAlternate")
)]
pub struct Alternate {
    pub offset: Offset,
    pub on: bool,
}

/// The child of `generation` ended. A subscription ends with it, after the last of the output:
/// a connection sent it before subscribing, as every open one is when the exit is published, is
/// sent it again after its subscription's `ok`, and output can follow the first. A consumer takes
/// the first of a generation's and ignores the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderExited")
)]
pub struct Exited {
    pub generation: Generation,
    #[serde(deserialize_with = "json::object")]
    pub status: ExitStatus,
}

/// A new child runs on the same PTY. The holder's screen leaves the alternate screen, pushes the
/// main screen into history as `CSI 2 J` does, and resets as RIS does but keeps the history; a
/// mirror whose reset clears its history snapshots again instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderRespawned")
)]
#[serde(rename_all = "camelCase")]
pub struct Respawned {
    pub generation: Generation,
    pub child_pid: Pid,
    pub child_start: StartTime,
}

/// The `request` of `ok` and `error` names the request answered, for logs: its id says which.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderOk")
)]
pub struct OkBody {
    pub request: String,
}

/// The codes `error` carries in this version. A peer meets newer ones, so `ErrorBody::code` is a
/// string, and `ErrorBody::known_code` reads one this build doesn't know as `Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// The holder doesn't know the request's type.
    UnknownRequest,
    /// A `subscribe` that crossed a respawn, or a `respawn` not above the current generation.
    StaleGeneration,
    /// `subscribe` from past the holder's offset.
    OutOfRange,
    /// The request's body failed its schema.
    Invalid,
    /// `hello` found no major both sides speak.
    NoSharedVersion,
    /// `input` or `resize` from a connection without the writer slot.
    NotWriter,
    /// `input` past what the holder queues for a program that isn't reading. Every later `input`
    /// is refused too until the program has read what is queued.
    InputFull,
    /// The request needs a child, and it has exited.
    Exited,
    /// A snapshot over the reply cap even with all its history left out.
    SnapshotTooLarge,
    /// The holder tried and the system refused.
    Failed,
    /// The request needs the child to have exited, and it still runs: a `respawn`.
    Running,
    /// The holder's terminal engine has failed for good, so it has no screen: a `snapshot`, or an
    /// unmarked `paste`, which needs to know whether the program asked for bracketed paste.
    Unavailable,
    /// A `paste` the program wouldn't read as text now; the message says which check failed.
    NotReady,
}

impl ErrorCode {
    pub const ALL: [Self; 13] = [
        Self::UnknownRequest,
        Self::StaleGeneration,
        Self::OutOfRange,
        Self::Invalid,
        Self::NoSharedVersion,
        Self::NotWriter,
        Self::InputFull,
        Self::Exited,
        Self::SnapshotTooLarge,
        Self::Failed,
        Self::Running,
        Self::Unavailable,
        Self::NotReady,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnknownRequest => "unknown-request",
            Self::StaleGeneration => "stale-generation",
            Self::OutOfRange => "out-of-range",
            Self::Invalid => "invalid",
            Self::NoSharedVersion => "no-shared-version",
            Self::NotWriter => "not-writer",
            Self::InputFull => "input-full",
            Self::Exited => "exited",
            Self::SnapshotTooLarge => "snapshot-too-large",
            Self::Failed => "failed",
            Self::Running => "running",
            Self::Unavailable => "unavailable",
            Self::NotReady => "not-ready",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "schema",
    derive(schemars::JsonSchema),
    schemars(rename = "HolderError")
)]
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
    #[cfg_attr(feature = "schema", schemars(with = "Versions"))]
    pub protocol: Option<Versions>,
}

impl ErrorBody {
    /// An `error` answering the request `request` names, as `crate::request_name` gives it.
    pub fn new(request: impl Into<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            request: request.into(),
            code: code.as_str().to_owned(),
            message: message.into(),
            protocol: None,
        }
    }

    /// `code` as this build knows it: a code from a newer peer is read as `Failed`.
    pub fn known_code(&self) -> ErrorCode {
        ErrorCode::ALL
            .into_iter()
            .find(|code| code.as_str() == self.code)
            .unwrap_or(ErrorCode::Failed)
    }
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
    fn a_paste_takes_text_but_never_a_key_and_unmarked_only_printable_ascii() {
        let paste = |text: &str, brackets| {
            read::<PasteRequest>(json!({ "generation": 0, "text": text, "brackets": brackets }))
                .map(|paste| paste.text().to_owned())
                .map_err(|e| e.to_string())
        };
        assert_eq!(
            [
                paste("echo 你好 Å", true),
                paste(" !~ $HOME", false),
                paste("make\r", true),
                paste("a\u{1b}[201~", true),
                paste("a\u{7f}", true),
                paste("\u{9b}2J", true),
                paste("echo Å", false),
            ]
            .map(|read| read.map_err(|e| e
                .split(" at line")
                .next()
                .unwrap_or_default()
                .to_owned())),
            [
                Ok("echo 你好 Å".to_owned()),
                Ok(" !~ $HOME".to_owned()),
                Err("the text holds a control character".to_owned()),
                Err("the text holds a control character".to_owned()),
                Err("the text holds a control character".to_owned()),
                Err("the text holds a control character".to_owned()),
                Err("unmarked text holds more than printable ASCII".to_owned()),
            ]
        );
        assert!(read::<PasteRequest>(json!({ "generation": 0, "text": "make" })).is_err());
    }

    #[test]
    fn a_paste_shows_its_generation_and_brackets_but_never_its_text() {
        let generation = Generation::new(7).unwrap();
        let shown = format!(
            "{:?}",
            PasteRequest::new(generation, "export TOKEN=hunter2", true).unwrap()
        );
        assert!(!shown.contains("hunter2"), "{shown}");
        assert_eq!(
            shown,
            format!("PasteRequest {{ generation: {generation:?}, brackets: true, .. }}")
        );
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
    fn an_enum_is_read_from_its_string_and_never_from_a_one_key_object() {
        assert_eq!(
            read::<SignalRequest>(json!({ "signal": "SIGHUP" }))
                .unwrap()
                .signal,
            Signal::Sighup
        );
        assert!(read::<SignalRequest>(json!({ "signal": { "SIGHUP": null } })).is_err());
        assert!(read::<SetThemeRequest>(json!({ "theme": { "dark": null } })).is_err());
    }

    #[test]
    fn an_error_names_its_code_and_reads_a_newer_one_as_failed() {
        let error = ErrorBody::new("input", ErrorCode::NotWriter, "no slot");
        assert_eq!(
            (error.code.as_str(), error.known_code()),
            ("not-writer", ErrorCode::NotWriter)
        );
        let newer = ErrorBody {
            code: "from-a-later-minor".to_owned(),
            ..error
        };
        assert_eq!(newer.known_code(), ErrorCode::Failed);
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
