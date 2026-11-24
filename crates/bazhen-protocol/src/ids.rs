//! Bazhen's ids on the wire: a kind's prefix, `_`, then a `UUIDv7` in lowercase hex without its
//! dashes. Each kind is its own type, so an agent's id is never taken for a task's.

use std::fmt;
use std::marker::PhantomData;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A kind of id, named by the prefix its ids start with.
pub trait Kind {
    const PREFIX: &'static str;
}

/// An id of kind `K`, as the daemon minted it.
pub struct Id<K> {
    text: String,
    kind: PhantomData<K>,
}

impl<K: Kind> Id<K> {
    /// The id `text` names, if it is one of this kind.
    pub fn parse(text: &str) -> Option<Self> {
        is_id(K::PREFIX, text).then(|| Self {
            text: text.to_owned(),
            kind: PhantomData,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// A new id, as `newId` in packages/core/src/ids.ts mints one: the `UUIDv7` of `random` with
    /// the millisecond `now_ms` in its first 48 bits, its version and variant set.
    pub fn mint(now_ms: u64, mut random: [u8; 16]) -> Self {
        let [_, _, ms @ ..] = now_ms.to_be_bytes();
        let (time, rest) = random.split_at_mut(6);
        time.copy_from_slice(&ms);
        if let [version, _, variant, ..] = rest {
            *version = (*version & 0x0f) | 0x70;
            *variant = (*variant & 0x3f) | 0x80;
        }
        let hex: String = random
            .iter()
            .flat_map(|b| [b >> 4, b & 0x0f])
            .filter_map(|nibble| char::from_digit(u32::from(nibble), 16))
            .collect();
        Self {
            text: format!("{}_{hex}", K::PREFIX),
            kind: PhantomData,
        }
    }
}

/// Whether `text` is an id of the kind `prefix` names.
pub fn is_id(prefix: &str, text: &str) -> bool {
    text.strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix('_'))
        .is_some_and(is_id_body)
}

/// What follows an id's prefix and `_`: a `UUIDv7` in lowercase hex, without its dashes.
fn is_id_body(body: &str) -> bool {
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let bytes = body.as_bytes();
    bytes.len() == 32
        && bytes.iter().all(|&b| hex(b))
        && bytes.get(12) == Some(&b'7')
        && bytes.get(16).is_some_and(|b| b"89ab".contains(b))
}

impl<K> Clone for Id<K> {
    fn clone(&self) -> Self {
        Self {
            text: self.text.clone(),
            kind: PhantomData,
        }
    }
}

impl<K> PartialEq for Id<K> {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
    }
}

impl<K> Eq for Id<K> {}

impl<K> std::hash::Hash for Id<K> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.text.hash(state);
    }
}

impl<K> fmt::Debug for Id<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl<K> fmt::Display for Id<K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl<K> Serialize for Id<K> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.text)
    }
}

impl<'de, K: Kind> Deserialize<'de> for Id<K> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Self::parse(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("not a {} id: {text}", K::PREFIX)))
    }
}

/// What follows an id's prefix and `_`, as a JSON Schema pattern: [`is_id_body`]'s rule.
#[cfg(feature = "schema")]
pub(crate) const ID_BODY_PATTERN: &str = "[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}";

#[cfg(feature = "schema")]
impl<K: Kind> schemars::JsonSchema for Id<K> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("{}Id", K::PREFIX).into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "pattern": format!("^{}_{ID_BODY_PATTERN}$", K::PREFIX),
        })
    }
}

/// The kinds of id the API's messages carry, each named by its prefix.
pub mod kind {
    use super::Kind;

    /// Ids that start `agent_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Agent {}

    impl Kind for Agent {
        const PREFIX: &'static str = "agent";
    }

    /// Ids that start `host_`: an installation's, minted once in its database.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Host {}

    impl Kind for Host {
        const PREFIX: &'static str = "host";
    }

    /// Ids that start `env_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Environment {}

    impl Kind for Environment {
        const PREFIX: &'static str = "env";
    }

    /// Ids that start `term_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Terminal {}

    impl Kind for Terminal {
        const PREFIX: &'static str = "term";
    }

    /// Ids that start `task_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Task {}

    impl Kind for Task {
        const PREFIX: &'static str = "task";
    }

    /// Ids that start `asgn_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Assignment {}

    impl Kind for Assignment {
        const PREFIX: &'static str = "asgn";
    }

    /// Ids that start `attn_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Attention {}

    impl Kind for Attention {
        const PREFIX: &'static str = "attn";
    }

    /// Ids that start `msg_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Message {}

    impl Kind for Message {
        const PREFIX: &'static str = "msg";
    }

    /// Ids that start `ntc_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Notice {}

    impl Kind for Notice {
        const PREFIX: &'static str = "ntc";
    }

    /// Ids that start `dev_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Device {}

    impl Kind for Device {
        const PREFIX: &'static str = "dev";
    }

    /// Ids that start `obs_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Observed {}

    impl Kind for Observed {
        const PREFIX: &'static str = "obs";
    }

    /// Ids that start `att_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Attachment {}

    impl Kind for Attachment {
        const PREFIX: &'static str = "att";
    }
}

pub type HostId = Id<kind::Host>;
pub type AgentId = Id<kind::Agent>;
pub type EnvironmentId = Id<kind::Environment>;
pub type TerminalId = Id<kind::Terminal>;
pub type TaskId = Id<kind::Task>;
pub type AssignmentId = Id<kind::Assignment>;
pub type AttentionId = Id<kind::Attention>;
pub type MessageId = Id<kind::Message>;
pub type NoticeId = Id<kind::Notice>;
pub type DeviceId = Id<kind::Device>;
pub type ObservedId = Id<kind::Observed>;
pub type AttachmentId = Id<kind::Attachment>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mints_the_id_typescripts_new_id_mints_from_the_same_time_and_bytes() {
        let falling: [u8; 16] = std::array::from_fn(|i| 0xff - u8::try_from(i).unwrap() * 7);
        assert_eq!(
            [
                HostId::mint(0x0190_a0b0_c0d0, falling),
                HostId::mint(1_763_000_000_123, [0; 16])
            ]
            .map(|id| id.as_str().to_owned()),
            [
                "host_0190a0b0c0d075ce87c0b9b2aba49d96",
                "host_019a7afd1e7b70008000000000000000"
            ]
        );
    }

    #[test]
    fn a_minted_id_parses_as_its_kind() {
        let id = HostId::mint(u64::MAX, [0xff; 16]);
        assert_eq!(HostId::parse(id.as_str()), Some(id));
    }
}
