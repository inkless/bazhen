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

/// The kinds of id the API's messages carry, each named by its prefix.
pub mod kind {
    use super::Kind;

    /// Ids that start `agent_`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Agent {}

    impl Kind for Agent {
        const PREFIX: &'static str = "agent";
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
