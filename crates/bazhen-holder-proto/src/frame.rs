//! The frame: a u32 big-endian length, then a type byte, then the payload; the length counts the
//! type byte and the payload. A request's payload, and a reply's to a request, starts with the
//! request's u32 id. This is `packages/protocol/src/holder-frame.ts`, which each rule here
//! follows: the layout holds in every major.

use std::borrow::Cow;

use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;

use crate::body::{
    Alternate, ErrorBody, Exited, Foreground, FrozenHelloReply, FrozenProtocol, Gap, HelloReply,
    HelloRequest, MAX_SAFE_INTEGER, Offset, OkBody, ProcessSpec, Resized, Respawned,
    SetTagsRequest, SetThemeRequest, SignalRequest, Size, Stats, SubscribeRequest, Title,
};
use crate::json;
use crate::version::speaks;

/// The most a frame to a holder may hold, its type byte included.
pub const MAX_REQUEST_BYTES: usize = 1 << 20;
/// The most a frame from a holder may hold.
pub const MAX_REPLY_BYTES: usize = 64 << 20;

/// Each request's type byte. A request with a reply of its own is `0x01`–`0x3f`; one without,
/// `0x40`–`0x7f`. A type byte means the same in every version.
pub mod request_code {
    pub const HELLO: u8 = 0x01;
    pub const SNAPSHOT: u8 = 0x02;
    pub const STATS: u8 = 0x03;
    pub const FOREGROUND: u8 = 0x04;
    pub const SUBSCRIBE: u8 = 0x40;
    pub const INPUT: u8 = 0x41;
    pub const RESIZE: u8 = 0x42;
    pub const CLOSE: u8 = 0x43;
    pub const SIGNAL: u8 = 0x44;
    pub const RESPAWN: u8 = 0x45;
    pub const SET_TAGS: u8 = 0x46;
    pub const SET_THEME: u8 = 0x47;
}

/// Each reply's and event's type byte. A request's own reply is its type with the top bit set
/// (`0x81`–`0xbf`); events, which carry no id, are `0xc0`–`0xef`; `ok` and `error`, which answer
/// any request, are `0xf0`–`0xff`.
pub mod reply_code {
    pub const HELLO: u8 = 0x81;
    pub const SNAPSHOT: u8 = 0x82;
    pub const STATS: u8 = 0x83;
    pub const FOREGROUND: u8 = 0x84;
    pub const DATA: u8 = 0xc0;
    pub const GAP: u8 = 0xc1;
    pub const RESIZED: u8 = 0xc2;
    pub const TITLE: u8 = 0xc3;
    pub const ALTERNATE: u8 = 0xc4;
    pub const EXITED: u8 = 0xc5;
    pub const RESPAWNED: u8 = 0xc6;
    pub const OK: u8 = 0xf0;
    pub const ERROR: u8 = 0xf1;
}

const HEADER: usize = 4;
/// What a decoder's buffer keeps allocated between reads.
const KEPT_CAPACITY: usize = 64 << 10;
const LAST_REQUEST: u8 = 0x7f;
const FIRST_REPLY: u8 = 0x81;
const EVENTS: std::ops::RangeInclusive<u8> = 0xc0..=0xef;

/// A request's name as `ok` and `error` give it in their `request`, from its type byte: one this
/// build doesn't know is named by the byte, as `0x2a`.
pub fn request_name(code: u8) -> Cow<'static, str> {
    let name = match code {
        request_code::HELLO => "hello",
        request_code::SNAPSHOT => "snapshot",
        request_code::STATS => "stats",
        request_code::FOREGROUND => "foreground",
        request_code::SUBSCRIBE => "subscribe",
        request_code::INPUT => "input",
        request_code::RESIZE => "resize",
        request_code::CLOSE => "close",
        request_code::SIGNAL => "signal",
        request_code::RESPAWN => "respawn",
        request_code::SET_TAGS => "set-tags",
        request_code::SET_THEME => "set-theme",
        _ => return Cow::Owned(format!("{code:#04x}")),
    };
    Cow::Borrowed(name)
}

/// The id a client gives a request, which the reply to it carries back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RequestId(pub u32);

/// What a holder reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Hello {
        id: RequestId,
        body: HelloRequest,
    },
    Snapshot {
        id: RequestId,
    },
    Stats {
        id: RequestId,
    },
    Foreground {
        id: RequestId,
    },
    Subscribe {
        id: RequestId,
        body: SubscribeRequest,
    },
    Input {
        id: RequestId,
        bytes: Vec<u8>,
    },
    Resize {
        id: RequestId,
        body: Size,
    },
    Close {
        id: RequestId,
    },
    Signal {
        id: RequestId,
        body: SignalRequest,
    },
    Respawn {
        id: RequestId,
        body: ProcessSpec,
    },
    SetTags {
        id: RequestId,
        body: SetTagsRequest,
    },
    SetTheme {
        id: RequestId,
        body: SetThemeRequest,
    },
    /// A type in the requests' range this build doesn't know: answered `unknown-request`.
    Unknown {
        code: u8,
        id: RequestId,
    },
}

/// What a holder's client reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Hello {
        id: RequestId,
        body: HelloReply,
    },
    Snapshot {
        id: RequestId,
        offset: Offset,
        dropped_lines: u32,
        bytes: Vec<u8>,
    },
    Stats {
        id: RequestId,
        body: Stats,
    },
    Foreground {
        id: RequestId,
        body: Foreground,
    },
    Data {
        offset: Offset,
        bytes: Vec<u8>,
    },
    Gap(Gap),
    Resized(Resized),
    Title(Title),
    Alternate(Alternate),
    Exited(Exited),
    Respawned(Respawned),
    Ok {
        id: RequestId,
        body: OkBody,
    },
    Error {
        id: RequestId,
        body: ErrorBody,
    },
    /// A type this build doesn't know, from a newer peer: skipped, its payload never read. Its
    /// type byte says whether it answers a request, and so whether it has an id.
    Unknown {
        code: u8,
        id: Option<RequestId>,
    },
}

/// The most of a refusal's reason kept, in characters: a reason can quote the peer's bytes, and a
/// holder may log it.
const REASON_MAX_CHARS: usize = 200;

/// Why a frame was refused. A decoder that met one decodes nothing more: its connection can't be
/// trusted to be in step, so the caller closes it.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{reason}")]
pub struct Malformed {
    reason: String,
    invalid_request: Option<(u8, RequestId)>,
}

impl Malformed {
    /// The reason escaped and cut short, so a peer's control bytes never reach a log raw.
    pub(crate) fn new(reason: impl AsRef<str>) -> Self {
        Self {
            reason: reason
                .as_ref()
                .escape_debug()
                .take(REASON_MAX_CHARS)
                .collect(),
            invalid_request: None,
        }
    }

    fn of_request(self, code: u8, id: RequestId) -> Self {
        Self {
            invalid_request: Some((code, id)),
            ..self
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// The request whose body failed, by type byte and id, when its id could be read. `holder/1`
    /// answers that request `error` coded `invalid` and then closes the connection; any other
    /// refusal closes it at once.
    pub fn invalid_request(&self) -> Option<(u8, RequestId)> {
        self.invalid_request
    }
}

/// Why a frame can't be encoded.
#[derive(Debug, Error)]
pub enum EncodeError {
    #[error("{length} bytes is over the {max} cap")]
    OverCap { length: usize, max: usize },
    #[error("an unknown frame, type {0:#04x}, has nothing to encode")]
    Unknown(u8),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// One frame's bytes: the header for `payload`, then `payload`.
fn frame(code: u8, payload: &[u8], max: usize) -> Result<Vec<u8>, EncodeError> {
    let length = payload.len() + 1;
    if length > max {
        return Err(EncodeError::OverCap { length, max });
    }
    let header = u32::try_from(length).map_err(|_| EncodeError::OverCap { length, max })?;
    let mut out = Vec::with_capacity(HEADER + length);
    out.extend_from_slice(&header.to_be_bytes());
    out.push(code);
    out.extend_from_slice(payload);
    Ok(out)
}

fn with_json(head: &[u8], body: &impl Serialize) -> Result<Vec<u8>, EncodeError> {
    let mut out = head.to_vec();
    serde_json::to_writer(&mut out, body)?;
    Ok(out)
}

fn with_offset(head: &[u8], offset: Offset) -> Vec<u8> {
    let mut out = head.to_vec();
    out.extend_from_slice(&offset.get().to_be_bytes());
    out
}

impl Request {
    /// The request as `ok` and `error` name it in their `request`.
    pub fn name(&self) -> Cow<'static, str> {
        request_name(self.code())
    }

    pub fn code(&self) -> u8 {
        match self {
            Self::Hello { .. } => request_code::HELLO,
            Self::Snapshot { .. } => request_code::SNAPSHOT,
            Self::Stats { .. } => request_code::STATS,
            Self::Foreground { .. } => request_code::FOREGROUND,
            Self::Subscribe { .. } => request_code::SUBSCRIBE,
            Self::Input { .. } => request_code::INPUT,
            Self::Resize { .. } => request_code::RESIZE,
            Self::Close { .. } => request_code::CLOSE,
            Self::Signal { .. } => request_code::SIGNAL,
            Self::Respawn { .. } => request_code::RESPAWN,
            Self::SetTags { .. } => request_code::SET_TAGS,
            Self::SetTheme { .. } => request_code::SET_THEME,
            Self::Unknown { code, .. } => *code,
        }
    }

    pub fn id(&self) -> RequestId {
        match self {
            Self::Hello { id, .. }
            | Self::Snapshot { id }
            | Self::Stats { id }
            | Self::Foreground { id }
            | Self::Subscribe { id, .. }
            | Self::Input { id, .. }
            | Self::Resize { id, .. }
            | Self::Close { id }
            | Self::Signal { id, .. }
            | Self::Respawn { id, .. }
            | Self::SetTags { id, .. }
            | Self::SetTheme { id, .. }
            | Self::Unknown { id, .. } => *id,
        }
    }

    /// # Errors
    ///
    /// When the frame is over `MAX_REQUEST_BYTES`, or is `Unknown`.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        let id = self.id().0.to_be_bytes();
        let payload = match self {
            Self::Unknown { code, .. } => return Err(EncodeError::Unknown(*code)),
            Self::Snapshot { .. }
            | Self::Stats { .. }
            | Self::Foreground { .. }
            | Self::Close { .. } => id.to_vec(),
            Self::Input { bytes, .. } => [id.as_slice(), bytes].concat(),
            Self::Hello { body, .. } => with_json(&id, body)?,
            Self::Subscribe { body, .. } => with_json(&id, body)?,
            Self::Resize { body, .. } => with_json(&id, body)?,
            Self::Signal { body, .. } => with_json(&id, body)?,
            Self::Respawn { body, .. } => with_json(&id, body)?,
            Self::SetTags { body, .. } => with_json(&id, body)?,
            Self::SetTheme { body, .. } => with_json(&id, body)?,
        };
        frame(self.code(), &payload, MAX_REQUEST_BYTES)
    }
}

impl Reply {
    pub fn code(&self) -> u8 {
        match self {
            Self::Hello { .. } => reply_code::HELLO,
            Self::Snapshot { .. } => reply_code::SNAPSHOT,
            Self::Stats { .. } => reply_code::STATS,
            Self::Foreground { .. } => reply_code::FOREGROUND,
            Self::Data { .. } => reply_code::DATA,
            Self::Gap(_) => reply_code::GAP,
            Self::Resized(_) => reply_code::RESIZED,
            Self::Title(_) => reply_code::TITLE,
            Self::Alternate(_) => reply_code::ALTERNATE,
            Self::Exited(_) => reply_code::EXITED,
            Self::Respawned(_) => reply_code::RESPAWNED,
            Self::Ok { .. } => reply_code::OK,
            Self::Error { .. } => reply_code::ERROR,
            Self::Unknown { code, .. } => *code,
        }
    }

    /// # Errors
    ///
    /// When the frame is over `MAX_REPLY_BYTES`, or is `Unknown`.
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        let payload = match self {
            Self::Unknown { code, .. } => return Err(EncodeError::Unknown(*code)),
            Self::Hello { id, body } => with_json(&id.0.to_be_bytes(), body)?,
            Self::Stats { id, body } => with_json(&id.0.to_be_bytes(), body)?,
            Self::Foreground { id, body } => with_json(&id.0.to_be_bytes(), body)?,
            Self::Ok { id, body } => with_json(&id.0.to_be_bytes(), body)?,
            Self::Error { id, body } => with_json(&id.0.to_be_bytes(), body)?,
            Self::Snapshot {
                id,
                offset,
                dropped_lines,
                bytes,
            } => {
                let mut out = with_offset(&id.0.to_be_bytes(), *offset);
                out.extend_from_slice(&dropped_lines.to_be_bytes());
                out.extend_from_slice(bytes);
                out
            }
            Self::Data { offset, bytes } => [with_offset(&[], *offset).as_slice(), bytes].concat(),
            Self::Gap(body) => with_json(&[], body)?,
            Self::Resized(body) => with_json(&[], body)?,
            Self::Title(body) => with_json(&[], body)?,
            Self::Alternate(body) => with_json(&[], body)?,
            Self::Exited(body) => with_json(&[], body)?,
            Self::Respawned(body) => with_json(&[], body)?,
        };
        frame(self.code(), &payload, MAX_REPLY_BYTES)
    }
}

fn split_u32<'a>(what: &str, name: &str, payload: &'a [u8]) -> Result<(u32, &'a [u8]), Malformed> {
    payload
        .split_first_chunk::<4>()
        .map(|(n, rest)| (u32::from_be_bytes(*n), rest))
        .ok_or_else(|| Malformed::new(format!("{what} has no {name}")))
}

fn split_id<'a>(what: &str, payload: &'a [u8]) -> Result<(RequestId, &'a [u8]), Malformed> {
    split_u32(what, "id", payload).map(|(id, rest)| (RequestId(id), rest))
}

fn split_offset<'a>(what: &str, payload: &'a [u8]) -> Result<(Offset, &'a [u8]), Malformed> {
    let (offset, rest) = payload
        .split_first_chunk::<8>()
        .ok_or_else(|| Malformed::new(format!("{what} is too short for its offset")))?;
    let offset = u64::from_be_bytes(*offset);
    let offset = Offset::new(offset).map_err(|_| {
        Malformed::new(format!("{what} offset {offset} is past {MAX_SAFE_INTEGER}"))
    })?;
    Ok((offset, rest))
}

fn parse(what: &str, body: &[u8]) -> Result<serde_json::Value, Malformed> {
    serde_json::from_slice(body).map_err(|e| Malformed::new(format!("{what}: {e}")))
}

fn read<T: DeserializeOwned>(what: &str, value: serde_json::Value) -> Result<T, Malformed> {
    json::from_value(value).map_err(|e| Malformed::new(format!("{what}: {e}")))
}

/// The frozen part of a body, read from a borrow so the rest isn't copied to read it.
fn read_frozen<T: DeserializeOwned>(what: &str, value: &serde_json::Value) -> Result<T, Malformed> {
    json::from_ref(value).map_err(|e| Malformed::new(format!("{what}: {e}")))
}

fn body<T: DeserializeOwned>(what: &str, payload: &[u8]) -> Result<T, Malformed> {
    read(what, parse(what, payload)?)
}

/// A `hello` request read as every major reads it: the frozen `protocol` first. One sharing no
/// major with this build gets `no-shared-version`, so the rest of it, in a schema this build
/// doesn't know, is left unread rather than refused.
fn hello_request(payload: &[u8]) -> Result<HelloRequest, Malformed> {
    let value = parse("hello", payload)?;
    let frozen: FrozenProtocol = read_frozen("hello", &value)?;
    if !speaks(&frozen.protocol.texts()) {
        return Ok(HelloRequest {
            protocol: frozen.protocol,
            writer: None,
        });
    }
    read("hello", value)
}

/// A hello reply: its frozen `version` first, which says which major's schema the rest is in.
fn hello_reply(payload: &[u8]) -> Result<HelloReply, Malformed> {
    let value = parse("hello", payload)?;
    let frozen: FrozenHelloReply = read_frozen("hello", &value)?;
    if !speaks(&[frozen.version.as_str()]) {
        return Err(Malformed::new(format!(
            "hello agrees on {}, a major this build doesn't speak",
            frozen.version.as_str()
        )));
    }
    read("hello", value)
}

fn decode_request(code: u8, payload: &[u8]) -> Result<Request, Malformed> {
    if code == 0 || code > LAST_REQUEST {
        return Err(Malformed::new(format!("{code:#x} is no request's type")));
    }
    let (id, rest) = split_id(&format!("request {code:#x}"), payload)?;
    request_body(code, id, rest).map_err(|e| e.of_request(code, id))
}

fn request_body(code: u8, id: RequestId, rest: &[u8]) -> Result<Request, Malformed> {
    Ok(match code {
        request_code::HELLO => Request::Hello {
            id,
            body: hello_request(rest)?,
        },
        request_code::SNAPSHOT => Request::Snapshot { id },
        request_code::STATS => Request::Stats { id },
        request_code::FOREGROUND => Request::Foreground { id },
        request_code::CLOSE => Request::Close { id },
        request_code::INPUT => Request::Input {
            id,
            bytes: rest.to_vec(),
        },
        request_code::SUBSCRIBE => Request::Subscribe {
            id,
            body: body("subscribe", rest)?,
        },
        request_code::RESIZE => Request::Resize {
            id,
            body: body("resize", rest)?,
        },
        request_code::SIGNAL => Request::Signal {
            id,
            body: body("signal", rest)?,
        },
        request_code::RESPAWN => Request::Respawn {
            id,
            body: body("respawn", rest)?,
        },
        request_code::SET_TAGS => Request::SetTags {
            id,
            body: body("set-tags", rest)?,
        },
        request_code::SET_THEME => Request::SetTheme {
            id,
            body: body("set-theme", rest)?,
        },
        _ => Request::Unknown { code, id },
    })
}

fn decode_reply(code: u8, payload: &[u8]) -> Result<Reply, Malformed> {
    let answer = |name: &str| split_id(name, payload);
    Ok(match code {
        reply_code::HELLO => {
            let (id, rest) = answer("hello")?;
            Reply::Hello {
                id,
                body: hello_reply(rest)?,
            }
        }
        reply_code::SNAPSHOT => {
            let (id, rest) = answer("snapshot")?;
            let (offset, rest) = split_offset("snapshot", rest)?;
            let (dropped_lines, bytes) = split_u32("snapshot", "dropped lines", rest)?;
            Reply::Snapshot {
                id,
                offset,
                dropped_lines,
                bytes: bytes.to_vec(),
            }
        }
        reply_code::STATS => {
            let (id, rest) = answer("stats")?;
            Reply::Stats {
                id,
                body: body("stats", rest)?,
            }
        }
        reply_code::FOREGROUND => {
            let (id, rest) = answer("foreground")?;
            Reply::Foreground {
                id,
                body: body("foreground", rest)?,
            }
        }
        reply_code::OK => {
            let (id, rest) = answer("ok")?;
            Reply::Ok {
                id,
                body: body("ok", rest)?,
            }
        }
        reply_code::ERROR => {
            let (id, rest) = answer("error")?;
            Reply::Error {
                id,
                body: body("error", rest)?,
            }
        }
        reply_code::DATA => {
            let (offset, bytes) = split_offset("data", payload)?;
            Reply::Data {
                offset,
                bytes: bytes.to_vec(),
            }
        }
        reply_code::GAP => Reply::Gap(body("gap", payload)?),
        reply_code::RESIZED => Reply::Resized(body("resized", payload)?),
        reply_code::TITLE => Reply::Title(body("title", payload)?),
        reply_code::ALTERNATE => Reply::Alternate(body("alternate", payload)?),
        reply_code::EXITED => Reply::Exited(body("exited", payload)?),
        reply_code::RESPAWNED => Reply::Respawned(body("respawned", payload)?),
        _ if code < FIRST_REPLY => {
            return Err(Malformed::new(format!("{code:#x} is no reply's type")));
        }
        _ if EVENTS.contains(&code) => Reply::Unknown { code, id: None },
        _ => Reply::Unknown {
            code,
            id: Some(answer(&format!("reply {code:#x}"))?.0),
        },
    })
}

/// Turns one connection's bytes, in whatever chunks they arrive, back into frames.
#[derive(Debug)]
pub struct FrameDecoder<F> {
    buffer: Vec<u8>,
    /// Where the next frame starts in `buffer`: frames are read from here, and the bytes before it
    /// dropped once per `push`, so many small frames in one read cost one copy, not one each.
    start: usize,
    max: usize,
    refused: Option<Malformed>,
    decode: fn(u8, &[u8]) -> Result<F, Malformed>,
}

/// Decodes what a holder reads: requests, up to `MAX_REQUEST_BYTES` each.
pub fn request_decoder() -> FrameDecoder<Request> {
    FrameDecoder::new(MAX_REQUEST_BYTES, decode_request)
}

/// Decodes what a holder's client reads: replies and events, up to `MAX_REPLY_BYTES` each.
pub fn reply_decoder() -> FrameDecoder<Reply> {
    FrameDecoder::new(MAX_REPLY_BYTES, decode_reply)
}

impl<F> FrameDecoder<F> {
    fn new(max: usize, decode: fn(u8, &[u8]) -> Result<F, Malformed>) -> Self {
        Self {
            buffer: Vec::new(),
            start: 0,
            max,
            refused: None,
            decode,
        }
    }

    /// Takes the next bytes the connection read, to be drained with `next_frame` before the next
    /// read. Ignored once a frame has been refused.
    pub fn push(&mut self, chunk: &[u8]) {
        if self.refused.is_some() {
            return;
        }
        if self.start > 0 {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
        // A near-cap frame leaves its capacity behind, held for the connection's life otherwise.
        if self.buffer.len() <= KEPT_CAPACITY {
            self.buffer.shrink_to(KEPT_CAPACITY);
        }
        self.buffer.extend_from_slice(chunk);
    }

    /// The next whole frame, or `None` until more bytes come.
    ///
    /// # Errors
    ///
    /// When a frame is malformed, and on every call after.
    pub fn next_frame(&mut self) -> Result<Option<F>, Malformed> {
        if let Some(refused) = &self.refused {
            return Err(refused.clone());
        }
        let next = self.take();
        if let Err(refused) = &next {
            self.refused = Some(refused.clone());
            self.buffer = Vec::new();
            self.start = 0;
        }
        next
    }

    fn take(&mut self) -> Result<Option<F>, Malformed> {
        let pending = self.buffer.get(self.start..).unwrap_or_default();
        let Some((header, rest)) = pending.split_first_chunk::<HEADER>() else {
            return Ok(None);
        };
        let length = u32::from_be_bytes(*header);
        // Refused from the header alone, so a peer can't make this side buffer what it refuses.
        let length = usize::try_from(length)
            .ok()
            .filter(|n| *n <= self.max)
            .ok_or_else(|| {
                Malformed::new(format!(
                    "a frame of {length} bytes, over the {} cap",
                    self.max
                ))
            })?;
        let Some((code, payload)) = rest.get(..length).and_then(<[u8]>::split_first) else {
            return if length == 0 {
                Err(Malformed::new("a frame of length 0"))
            } else {
                Ok(None)
            };
        };
        let frame = (self.decode)(*code, payload);
        self.start += HEADER + length;
        frame.map(Some)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;

    use super::*;
    use crate::body::{
        Bounded, SetThemeRequest, Signal, SubscribeFrom, TagName, TagValue, Tags, Theme,
        VersionText, Versions,
    };

    /// Every frame `chunks` hold. A frame is at least 5 bytes, so a decoder that returns more
    /// frames than bytes were sent isn't consuming what it decodes, and would otherwise be read
    /// until memory runs out.
    fn decode_all<F>(mut decoder: FrameDecoder<F>, chunks: &[&[u8]]) -> Result<Vec<F>, Malformed> {
        let sent: usize = chunks.iter().map(|chunk| chunk.len()).sum();
        let mut frames = Vec::new();
        for chunk in chunks {
            decoder.push(chunk);
            while let Some(frame) = decoder.next_frame()? {
                frames.push(frame);
                assert!(
                    frames.len() <= sent,
                    "decoded more frames than the {sent} bytes sent hold"
                );
            }
        }
        Ok(frames)
    }

    #[test]
    fn refuses_a_frame_over_the_cap_from_its_header_alone() {
        let header = u32::try_from(MAX_REQUEST_BYTES + 1).unwrap().to_be_bytes();
        let mut decoder = request_decoder();
        decoder.push(&header);
        assert!(
            decoder
                .next_frame()
                .unwrap_err()
                .reason()
                .contains("over the")
        );
    }

    #[test]
    fn takes_a_frame_at_the_cap() {
        let bytes = vec![7; MAX_REQUEST_BYTES - 5];
        let frame = Request::Input {
            id: RequestId(1),
            bytes,
        };
        let encoded = frame.encode().unwrap();
        assert_eq!(
            decode_all(request_decoder(), &[&encoded]).unwrap(),
            vec![frame]
        );
    }

    #[test]
    fn encodes_nothing_over_the_cap() {
        let frame = Request::Input {
            id: RequestId(1),
            bytes: vec![7; MAX_REQUEST_BYTES - 4],
        };
        assert!(matches!(frame.encode(), Err(EncodeError::OverCap { .. })));
    }

    #[test]
    fn takes_a_reply_over_the_request_cap_up_to_its_own() {
        let frame = Reply::Data {
            offset: Bounded::new(0).unwrap(),
            bytes: vec![7; MAX_REQUEST_BYTES],
        };
        let encoded = frame.encode().unwrap();
        assert_eq!(
            decode_all(reply_decoder(), &[&encoded]).unwrap(),
            vec![frame]
        );
    }

    #[test]
    fn names_the_request_to_answer_invalid_when_only_its_body_failed() {
        let body = [
            &[0, 0, 0, 12, request_code::SET_THEME, 0, 0, 0, 9][..],
            b"{\"x\":1}",
        ]
        .concat();
        let mut decoder = request_decoder();
        decoder.push(&body);
        let refused = decoder.next_frame().unwrap_err();
        assert_eq!(
            refused.invalid_request(),
            Some((request_code::SET_THEME, RequestId(9)))
        );
        let mut decoder = request_decoder();
        decoder.push(&[0, 0, 0, 3, request_code::SET_THEME, 0, 0]);
        assert_eq!(decoder.next_frame().unwrap_err().invalid_request(), None);
    }

    #[test]
    fn escapes_and_cuts_short_the_peer_bytes_a_reason_quotes() {
        let signal = format!("\u{1b}[2J{}", "x".repeat(10_000));
        let json = serde_json::to_vec(&serde_json::json!({ "signal": signal })).unwrap();
        let length = u32::try_from(json.len() + 5).unwrap().to_be_bytes();
        let mut decoder = request_decoder();
        decoder.push(&[&length[..], &[request_code::SIGNAL, 0, 0, 0, 1], &json].concat());
        let reason = decoder.next_frame().unwrap_err().reason().to_owned();
        assert!(!reason.contains('\u{1b}'), "{reason}");
        assert!(reason.chars().count() <= 200, "{}", reason.len());
    }

    #[test]
    fn decodes_nothing_more_once_a_frame_is_refused() {
        let good = Request::Close { id: RequestId(2) }.encode().unwrap();
        let mut decoder = request_decoder();
        decoder.push(&[0, 0, 0, 0]);
        assert!(decoder.next_frame().is_err());
        decoder.push(&good);
        assert!(decoder.next_frame().is_err());
    }

    #[test]
    fn skips_an_unknown_event_by_its_length_and_reads_the_frame_after() {
        let unknown = [0, 0, 0, 4, 0xc7, b'{', b'[', 0xff];
        let data = Reply::Data {
            offset: Bounded::new(3).unwrap(),
            bytes: vec![1],
        };
        let frames = decode_all(reply_decoder(), &[&unknown, &data.encode().unwrap()]).unwrap();
        assert_eq!(
            frames,
            vec![
                Reply::Unknown {
                    code: 0xc7,
                    id: None
                },
                data
            ]
        );
    }

    #[test]
    fn answers_an_unknown_request_in_range_by_its_id() {
        let frames = decode_all(request_decoder(), &[&[0, 0, 0, 5, 0x05, 0, 0, 1, 0]]).unwrap();
        assert_eq!(
            frames,
            vec![Request::Unknown {
                code: 0x05,
                id: RequestId(256)
            }]
        );
    }

    fn id() -> impl Strategy<Value = RequestId> {
        any::<u32>().prop_map(RequestId)
    }

    fn count<K: Copy + std::fmt::Debug + 'static>()
    -> impl Strategy<Value = Bounded<0, MAX_SAFE_INTEGER, K>> {
        (0..=MAX_SAFE_INTEGER).prop_map(|n| Bounded::new(n).unwrap())
    }

    fn size() -> impl Strategy<Value = Size> {
        (0..=1000_u64, 0..=1000_u64).prop_map(|(cols, rows)| Size {
            cols: Bounded::new(cols).unwrap(),
            rows: Bounded::new(rows).unwrap(),
        })
    }

    fn tags() -> impl Strategy<Value = Tags> {
        prop::collection::btree_map("[a-z\u{e9}]{1,8}", "\\PC{0,8}", 0..4).prop_map(|tags| {
            let tags: BTreeMap<TagName, TagValue> = tags
                .into_iter()
                .map(|(name, value)| (TagName::new(name).unwrap(), TagValue::new(value).unwrap()))
                .collect();
            Tags::new(tags).unwrap()
        })
    }

    fn request() -> impl Strategy<Value = Request> {
        prop_oneof![
            (id(), any::<Option<bool>>()).prop_map(|(id, writer)| Request::Hello {
                id,
                body: HelloRequest {
                    protocol: Versions::new(vec![VersionText::new("1.0").unwrap()]).unwrap(),
                    writer,
                },
            }),
            id().prop_map(|id| Request::Snapshot { id }),
            id().prop_map(|id| Request::Close { id }),
            (id(), prop::collection::vec(any::<u8>(), 0..64))
                .prop_map(|(id, bytes)| Request::Input { id, bytes }),
            (id(), size()).prop_map(|(id, body)| Request::Resize { id, body }),
            (id(), prop::option::of((count(), count()))).prop_map(|(id, from)| {
                Request::Subscribe {
                    id,
                    body: SubscribeRequest {
                        from: from.map(|(generation, offset)| SubscribeFrom { generation, offset }),
                    },
                }
            }),
            (
                id(),
                prop::sample::select(vec![Signal::Sigint, Signal::Sigkill])
            )
                .prop_map(|(id, signal)| Request::Signal {
                    id,
                    body: SignalRequest { signal }
                }),
            (id(), tags()).prop_map(|(id, tags)| Request::SetTags {
                id,
                body: SetTagsRequest { tags }
            }),
            (
                id(),
                prop::option::of(prop::sample::select(vec![Theme::Light, Theme::Dark]))
            )
                .prop_map(|(id, theme)| Request::SetTheme {
                    id,
                    body: SetThemeRequest { theme }
                }),
        ]
    }

    fn reply() -> impl Strategy<Value = Reply> {
        prop_oneof![
            (count(), prop::collection::vec(any::<u8>(), 0..64))
                .prop_map(|(offset, bytes)| Reply::Data { offset, bytes }),
            (
                id(),
                count(),
                any::<u32>(),
                prop::collection::vec(any::<u8>(), 0..64)
            )
                .prop_map(|(id, offset, dropped_lines, bytes)| Reply::Snapshot {
                    id,
                    offset,
                    dropped_lines,
                    bytes
                }),
            (count(), "\\PC{0,16}").prop_map(|(offset, text)| Reply::Title(Title { offset, text })),
            (count(), count()).prop_map(|(from, to)| Reply::Gap(Gap { from, to })),
            (id(), "\\PC{0,8}").prop_map(|(id, request)| Reply::Ok {
                id,
                body: OkBody { request }
            }),
        ]
    }

    fn cut(bytes: &[u8], at: &[prop::sample::Index]) -> Vec<Vec<u8>> {
        let mut points: Vec<usize> = at.iter().map(|i| i.index(bytes.len() + 1)).collect();
        points.sort_unstable();
        let mut chunks = Vec::new();
        let mut start = 0;
        for point in points {
            chunks.push(bytes[start..point].to_vec());
            start = point;
        }
        chunks.push(bytes[start..].to_vec());
        chunks
    }

    proptest! {
        #[test]
        fn decodes_the_requests_encoded_however_the_stream_is_cut(
            frames in prop::collection::vec(request(), 1..6),
            at in prop::collection::vec(any::<prop::sample::Index>(), 0..6),
        ) {
            let stream: Vec<u8> = frames.iter().flat_map(|f| f.encode().unwrap()).collect();
            let chunks = cut(&stream, &at);
            let chunks: Vec<&[u8]> = chunks.iter().map(Vec::as_slice).collect();
            prop_assert_eq!(decode_all(request_decoder(), &chunks).unwrap(), frames);
        }

        #[test]
        fn decodes_the_replies_encoded_however_the_stream_is_cut(
            frames in prop::collection::vec(reply(), 1..6),
            at in prop::collection::vec(any::<prop::sample::Index>(), 0..6),
        ) {
            let stream: Vec<u8> = frames.iter().flat_map(|f| f.encode().unwrap()).collect();
            let chunks = cut(&stream, &at);
            let chunks: Vec<&[u8]> = chunks.iter().map(Vec::as_slice).collect();
            prop_assert_eq!(decode_all(reply_decoder(), &chunks).unwrap(), frames);
        }

        #[test]
        fn takes_exactly_a_frames_own_bytes_and_leaves_the_next_frames_alone(
            first in request(),
            next in request(),
            at in any::<prop::sample::Index>(),
        ) {
            let next_bytes = next.encode().unwrap();
            let (head, tail) = next_bytes.split_at(at.index(next_bytes.len()));
            let mut decoder = request_decoder();
            decoder.push(&[first.encode().unwrap().as_slice(), head].concat());
            prop_assert_eq!(decoder.next_frame().unwrap(), Some(first));
            prop_assert_eq!(decoder.next_frame().unwrap(), None);
            decoder.push(tail);
            prop_assert_eq!(decoder.next_frame().unwrap(), Some(next));
            prop_assert_eq!(decoder.next_frame().unwrap(), None);
        }

        #[test]
        fn holds_every_strict_prefix_of_a_frame_until_the_rest_arrives(
            frame in request(),
            at in any::<prop::sample::Index>(),
        ) {
            let bytes = frame.encode().unwrap();
            let split = at.index(bytes.len());
            let mut decoder = request_decoder();
            decoder.push(&bytes[..split]);
            prop_assert_eq!(decoder.next_frame().unwrap(), None);
            decoder.push(&bytes[split..]);
            prop_assert_eq!(decoder.next_frame().unwrap(), Some(frame));
        }
    }
}
