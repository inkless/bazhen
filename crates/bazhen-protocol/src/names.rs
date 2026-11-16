//! The names the API checks: an agent's name, a reference to an agent by its name or id, and a
//! role's key. Each decodes only from text the protocol accepts, so a reply naming anything else is
//! refused as zod refuses it.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ids::{Kind, is_id, kind};

/// The most characters an agent's name has.
pub const AGENT_NAME_MAX: usize = 40;

/// The prefix of every kind of Bazhen id: no name is a whole id of any.
const ID_PREFIXES: [&str; 13] = [
    "host", "env", "agent", "task", "asgn", "attn", "ntc", "msg", "term", "dev", "att", "lease",
    "obs",
];

/// Why a name isn't one, as the protocol words it.
pub const AGENT_NAME_RULE: &str =
    "a name is 1 to 40 letters, digits, - or _, starts with a letter or digit, and isn't an id";

/// An agent's name: 1 to 40 letters, digits, `-` or `_`, starting with a letter or digit, and never
/// exactly an id of any kind, so a command line never reads it as an option and a reference is
/// always one or the other.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentName(String);

impl AgentName {
    /// # Errors
    ///
    /// The protocol's rule, when `text` isn't a name.
    pub fn parse(text: &str) -> Result<Self, &'static str> {
        is_agent_name(text)
            .then(|| Self(text.to_owned()))
            .ok_or(AGENT_NAME_RULE)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_agent_name(text: &str) -> bool {
    let mut bytes = text.bytes();
    let starts = bytes.next().is_some_and(|b| b.is_ascii_alphanumeric());
    starts
        && text.len() <= AGENT_NAME_MAX
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !ID_PREFIXES.iter().any(|prefix| is_id(prefix, text))
}

/// An agent as a request names it: by its id, or by the name of one not ended.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentRef(String);

impl AgentRef {
    pub fn parse(text: &str) -> Option<Self> {
        (is_id(kind::Agent::PREFIX, text) || is_agent_name(text)).then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A role's key: 1 to 32 lowercase letters, digits or `-`, starting with a letter. Which keys are
/// defined is the daemon's to check.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Role(String);

/// The role a request gives when it names none.
pub const DEFAULT_ROLE: &str = "worker";

impl Role {
    pub fn parse(text: &str) -> Option<Self> {
        let mut bytes = text.bytes();
        let starts = bytes.next().is_some_and(|b| b.is_ascii_lowercase());
        let rest = bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        (starts && rest && text.len() <= 32).then(|| Self(text.to_owned()))
    }

    pub fn worker() -> Self {
        Self(DEFAULT_ROLE.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for Role {
    fn default() -> Self {
        Self::worker()
    }
}

/// A value the protocol refuses, named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    what: &'static str,
    value: String,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not {}: {}", self.what, self.value)
    }
}

impl std::error::Error for Refused {}

impl TryFrom<String> for AgentName {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).map_err(|_| Refused {
            what: "an agent's name",
            value,
        })
    }
}

impl TryFrom<String> for AgentRef {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).ok_or(Refused {
            what: "an agent's name or id",
            value,
        })
    }
}

impl TryFrom<String> for Role {
    type Error = Refused;
    fn try_from(value: String) -> Result<Self, Refused> {
        Self::parse(&value).ok_or(Refused {
            what: "a role",
            value,
        })
    }
}

impl From<AgentName> for String {
    fn from(name: AgentName) -> Self {
        name.0
    }
}

impl From<AgentRef> for String {
    fn from(name: AgentRef) -> Self {
        name.0
    }
}

impl From<Role> for String {
    fn from(role: Role) -> Self {
        role.0
    }
}

impl fmt::Display for AgentName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Display for AgentRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
