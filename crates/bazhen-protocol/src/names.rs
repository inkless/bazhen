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

/// Text that isn't an agent's name; it says the rule, in the protocol's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAName;

impl fmt::Display for NotAName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(AGENT_NAME_RULE)
    }
}

impl std::error::Error for NotAName {}

/// Text that is neither an agent's id nor a name, said as zod says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotARef;

impl fmt::Display for NotARef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Invalid input")
    }
}

impl std::error::Error for NotARef {}

impl AgentName {
    /// # Errors
    ///
    /// `NotAName`, saying the rule, when `text` isn't a name.
    pub fn parse(text: &str) -> Result<Self, NotAName> {
        is_agent_name(text)
            .then(|| Self(text.to_owned()))
            .ok_or(NotAName)
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
    /// # Errors
    ///
    /// `NotARef` when `text` is neither an agent's id nor a name.
    pub fn parse(text: &str) -> Result<Self, NotARef> {
        (is_id(kind::Agent::PREFIX, text) || is_agent_name(text))
            .then(|| Self(text.to_owned()))
            .ok_or(NotARef)
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

impl Refused {
    pub(crate) fn new(what: &'static str, value: String) -> Self {
        Self { what, value }
    }
}

/// An agent's name as a JSON Schema pattern: [`AgentName::parse`]'s rule.
#[cfg(feature = "schema")]
fn agent_name_pattern() -> String {
    format!(
        "(?!(?:{})_{}$)[A-Za-z0-9][A-Za-z0-9_-]{{0,{}}}",
        ID_PREFIXES.join("|"),
        crate::ids::ID_BODY_PATTERN,
        AGENT_NAME_MAX - 1,
    )
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for AgentName {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AgentName".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "pattern": format!("^{}$", agent_name_pattern()),
            "x-bazhen-message": AGENT_NAME_RULE,
        })
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for AgentRef {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "AgentRef".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "anyOf": [
                generator.subschema_for::<crate::ids::AgentId>(),
                generator.subschema_for::<AgentName>(),
            ]
        })
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for Role {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Role".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string", "pattern": "^[a-z][a-z0-9-]{0,31}$" })
    }
}

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
        Self::parse(&value).map_err(|_| Refused {
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

/// The longest base a default name keeps, leaving room within a name's 40 characters for `-` and
/// a seven-digit number.
const BASE_MAX: usize = 32;

/// A project made into the start of a default name, as `nameBase` makes it: each run of
/// characters a name can't hold becomes `-`, and the ends lose their `-` and `_`. The daemon keys
/// its never-reused name counters by this, so it must match the TypeScript one's exactly.
pub fn name_base(project: &str) -> String {
    let mut replaced = String::with_capacity(project.len());
    let mut in_run = false;
    for c in project.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            replaced.push(c);
            in_run = false;
        } else if !in_run {
            replaced.push('-');
            in_run = true;
        }
    }
    let ends = |c: char| c == '-' || c == '_';
    let base: String = replaced.trim_matches(ends).chars().take(BASE_MAX).collect();
    let base = base.trim_matches(ends);
    if base.is_empty() {
        "agent".to_owned()
    } else {
        base.to_owned()
    }
}

#[cfg(test)]
mod name_base_tests {
    use super::name_base;

    #[test]
    fn makes_a_project_the_start_of_a_default_name_as_typescript_does() {
        for (project, base) in [
            ("bazhen", "bazhen"),
            ("my project!", "my-project"),
            ("__x__", "x"),
            ("", "agent"),
            ("--", "agent"),
            ("a  b", "a-b"),
            ("日本", "agent"),
            ("a日本b", "a-b"),
            (&"x".repeat(40), &"x".repeat(32)),
            (&format!("{}-y", "x".repeat(31)), &"x".repeat(31)),
        ] {
            assert_eq!(name_base(project), base, "{project}");
        }
    }
}
