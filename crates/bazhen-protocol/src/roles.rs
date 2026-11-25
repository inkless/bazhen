//! Roles, as their files define them.

use serde::{Deserialize, Serialize};

use crate::names::Role;

/// The roles Bazhen ships a definition of, in the order a client lists them. A user's file may
/// replace any, but none goes away.
pub const BUILTIN_ROLES: [&str; 4] = ["coordinator", "lead", "worker", "reviewer"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum RoleSource {
    Builtin,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RoleDefinition {
    pub key: Role,
    pub title: String,
    pub description: String,
    pub grants: Vec<Role>,
    pub single_per_task: bool,
    /// Null for no limit.
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<u64>", range(min = 1))
    )]
    pub max_active_tasks: Option<u64>,
    pub prompt: String,
    pub source: RoleSource,
}

/// A role file that was skipped, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RoleProblem {
    pub file: String,
    pub problem: String,
}

/// `GET /v1/roles`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RolesResponse {
    pub roles: Vec<RoleDefinition>,
    pub problems: Vec<RoleProblem>,
}
