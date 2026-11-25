//! The roles in force, from the built-ins and the user's role files, as packages/core's roles.ts
//! resolves them.

use std::collections::{HashMap, HashSet, VecDeque};

use bazhen_protocol::names::Role;
use bazhen_protocol::roles::{RoleDefinition, RoleProblem};

/// What holding a role on a task lets an agent do, and how much of it one agent may hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleRules<'a> {
    pub grants: &'a [Role],
    pub single_per_task: bool,
    /// None for no limit.
    pub max_active_tasks: Option<u64>,
}

/// An assignment can outlive its role's file. A role no definition has any longer gives no
/// authority and no limit, so its holders keep their work and hand nothing on.
const UNDEFINED_RULES: RoleRules<'static> = RoleRules {
    grants: &[],
    single_per_task: false,
    max_active_tasks: None,
};

/// The roles defined now, by key, in the order they were defined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleBook {
    roles: Vec<RoleDefinition>,
}

impl RoleBook {
    pub fn new(roles: Vec<RoleDefinition>) -> Self {
        Self { roles }
    }

    pub fn roles(&self) -> &[RoleDefinition] {
        &self.roles
    }

    pub fn get(&self, key: &Role) -> Option<&RoleDefinition> {
        self.roles.iter().find(|r| r.key == *key)
    }

    pub fn rules(&self, key: &Role) -> RoleRules<'_> {
        self.rules_of(key.as_str())
    }

    /// The rules of the role keyed `key`, for a caller that names a role rather than holds one.
    pub fn rules_of(&self, key: &str) -> RoleRules<'_> {
        let defined = self.roles.iter().find(|r| r.key.as_str() == key);
        defined.map_or(UNDEFINED_RULES, |r| RoleRules {
            grants: &r.grants,
            single_per_task: r.single_per_task,
            max_active_tasks: r.max_active_tasks,
        })
    }
}

/// A user's role file, read and parsed, named from the config directory (`roles/lead.md`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRole {
    pub file: String,
    pub role: RoleDefinition,
}

/// The roles in force: the built-ins, each replaced whole by a user file of its key, and the user
/// files of new keys. A user role is skipped when it grants a key nothing defines, or when it can
/// be granted back through the roles it grants, which would let an agent promote another to its
/// own standing. Skipping one can change what another reaches, so the check repeats until nothing
/// changes. A skipped file's built-in, if any, stands.
pub fn resolve_roles(
    builtins: &[RoleDefinition],
    user: &[UserRole],
) -> (RoleBook, Vec<RoleProblem>) {
    let mut problems = Vec::new();
    let mut kept: Vec<&UserRole> = user.iter().collect();
    loop {
        let book = merged(builtins, &kept);
        let refused: Vec<RoleProblem> = kept
            .iter()
            .filter_map(|u| {
                grant_problem(&u.role, &book).map(|problem| RoleProblem {
                    file: u.file.clone(),
                    problem,
                })
            })
            .collect();
        if refused.is_empty() {
            return (book, problems);
        }
        let files: HashSet<&str> = refused.iter().map(|r| r.file.as_str()).collect();
        kept.retain(|u| !files.contains(u.file.as_str()));
        problems.extend(refused);
    }
}

fn merged(builtins: &[RoleDefinition], user: &[&UserRole]) -> RoleBook {
    // The last file of a key replaces its built-in, as a map built from them in order would.
    let replaced: HashMap<&Role, &RoleDefinition> =
        user.iter().map(|u| (&u.role.key, &u.role)).collect();
    let builtin = |key: &Role| builtins.iter().any(|b| b.key == *key);
    let roles = builtins
        .iter()
        .map(|b| replaced.get(&b.key).copied().unwrap_or(b).clone())
        .chain(
            user.iter()
                .map(|u| u.role.clone())
                .filter(|r| !builtin(&r.key)),
        )
        .collect();
    RoleBook::new(roles)
}

fn grant_problem(role: &RoleDefinition, book: &RoleBook) -> Option<String> {
    let unknown: Vec<&str> = role
        .grants
        .iter()
        .filter(|g| book.get(g).is_none())
        .map(Role::as_str)
        .collect();
    if !unknown.is_empty() {
        return Some(format!(
            "grants {}, which no role defines",
            unknown.join(", ")
        ));
    }
    let cycle = path_back(&role.key, book)?;
    let key = role.key.as_str();
    Some(if cycle.len() == 2 {
        format!("a {key} can't grant its own role")
    } else {
        let path: Vec<&str> = cycle.iter().map(|r| r.as_str()).collect();
        format!(
            "a {key} could be granted again by a role it grants ({})",
            path.join(" → ")
        )
    })
}

/// The shortest path of grants from `key` back to itself, both ends included, or None for none.
fn path_back<'a>(key: &'a Role, book: &'a RoleBook) -> Option<Vec<&'a Role>> {
    let mut parent: HashMap<&Role, &Role> = HashMap::new();
    let mut frontier: VecDeque<&Role> = VecDeque::from([key]);
    while !frontier.is_empty() {
        let mut next = VecDeque::new();
        for at in frontier {
            for granted in book.rules(at).grants {
                if granted == key {
                    let mut path = trail(&parent, at, key);
                    path.push(key);
                    return Some(path);
                }
                if !parent.contains_key(granted) {
                    parent.insert(granted, at);
                    next.push_back(granted);
                }
            }
        }
        frontier = next;
    }
    None
}

/// The path from `key` to `at`, following each role back to the one that granted it first.
fn trail<'a>(parent: &HashMap<&'a Role, &'a Role>, at: &'a Role, key: &'a Role) -> Vec<&'a Role> {
    let mut path = vec![at];
    let mut step = at;
    while step != key {
        let Some(&up) = parent.get(step) else { break };
        path.insert(0, up);
        step = up;
    }
    path
}
