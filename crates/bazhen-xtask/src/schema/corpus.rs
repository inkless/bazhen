//! The planted corpus: each fixture example of a message, and that example broken or stretched
//! at each of its fields, by every keyword either schema gives the field, the protocol's own
//! (`packages/protocol/schema`) or the one the Rust crates emit. Each case says whether the
//! protocol takes it, as its keyword says; the edge's verdict on it, where the daemon's edge reads
//! the message, must agree, but for the cases `KNOWN_MISMATCHES` lists.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

/// A field's place in a message, as a JSON pointer.
type Path = Vec<String>;

/// Fields to set, or with none to take out.
type Fields = Vec<(&'static str, Option<Value>)>;

/// A case an object-level check is broken by: its name, its fields, and whether the check takes
/// them.
type ObjectCase = (&'static str, Fields, bool);

/// What a case does to its example at its path.
#[derive(Debug, Clone, PartialEq)]
enum Edit {
    /// Leaves the example as it is.
    Keep,
    /// Takes the field out.
    Drop,
    /// Puts a value there.
    Put(Value),
    /// Puts JSON text there as it is written, which a parsed value can't hold: a lone surrogate,
    /// or a number written `80.0`.
    Raw(String),
    /// Sets or takes out an object's fields.
    Fields(Fields),
    /// Adds a key, written as JSON text, holding a value.
    Key(String, Value),
}

/// One planted case.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Case {
    pub(crate) schema: String,
    pub(crate) path: String,
    pub(crate) kind: String,
    pub(crate) body: String,
    pub(crate) accept: bool,
}

impl Case {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "schema": self.schema,
            "path": self.path,
            "kind": self.kind,
            "body": self.body,
            "expect": if self.accept { "accept" } else { "refuse" },
        })
    }
}

/// A case planted in one example, before it is applied.
struct Plant {
    path: Path,
    kind: String,
    edit: Edit,
    accept: bool,
}

/// The cases the edge's verdict disagrees with today, each named by its message, path and kind,
/// which together name one case of each example, with what owns the fix and why they differ. The
/// list only shrinks: an entry that no longer disagrees fails, as does a disagreement not listed.
/// Each disagreement the edge may keep, as (message, path, kind, owner, reason).
pub(crate) type Known<'a> = &'a [(&'a str, &'a str, &'a str, &'a str, &'a str)];

pub(crate) const KNOWN_MISMATCHES: Known<'static> = &[
    (
        "CloseAgentRequest",
        "/confirmedBusy/0/program",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "CloseAgentRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "CloseShellRequest",
        "/confirmedProgram",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "CloseShellRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "CreateTaskRequest",
        "/brief",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "CreateTaskRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "DismissNoticeRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "OpenShellRequest",
        "/cwd",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "OpenShellRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    ("PairRequest", "/code", "loneSurrogate", OWNER_STRINGS, LONE),
    ("PairRequest", "/name", "loneSurrogate", OWNER_STRINGS, LONE),
    (
        "RenameShellRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "RenameShellRequest",
        "/name",
        "shellName/loneSurrogate",
        OWNER_STRINGS,
        LONE_SHOWABLE,
    ),
    (
        "RelaunchAgentRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "RespawnAgentRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "RestartShellRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "ShellDecline",
        "/token",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "ShellPrompt",
        "/token",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "ShellReport",
        "/command",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "ShellReport",
        "/token",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "SignalAgentRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
    (
        "UnlinkShellRequest",
        "/idempotencyKey",
        "loneSurrogate",
        OWNER_STRINGS,
        LONE,
    ),
];

/// Who owns a lone surrogate in a request's text.
const OWNER_STRINGS: &str = "the protocol's request strings";

/// Why the edge refuses a lone surrogate the protocol takes.
const LONE: &str = "zod takes a lone surrogate in a plain string, which serde_json refuses \
                    and no Rust string or UTF-8 store can hold";

/// Why the edge refuses a lone surrogate in a shell's name, which the protocol takes.
const LONE_SHOWABLE: &str = "zod's shellName check refuses controls and bidi overrides, not a \
                             lone surrogate, which serde_json refuses and no Rust string or \
                             UTF-8 store can hold";

/// The test the protocol's schema names `check` makes, as cases: each case's name, the JSON text
/// put at the field, and whether the check takes it. `None` for a check this has no cases for.
fn check_cases(check: &str) -> Option<Vec<(&'static str, String, bool)>> {
    let text = |cases: &[(&'static str, &str, bool)]| {
        cases
            .iter()
            .map(|(name, json, accept)| (*name, (*json).to_owned(), *accept))
            .collect::<Vec<_>>()
    };
    Some(match check {
        "newTaskTitle" => text(&[
            ("plain", r#""fix the build""#, true),
            ("control", r#""a\u0007b""#, false),
            ("bidi", r#""a\u202eb""#, false),
            ("zeroWidth", r#""a\u200bb""#, false),
            ("tag", r#""a\udb40\udc01b""#, false),
            ("loneSurrogate", r#""a\ud800b""#, false),
        ]),
        "shellName" => text(&[
            ("plain", r#""build""#, true),
            ("control", r#""a\u0007b""#, false),
            ("bidi", r#""a\u202eb""#, false),
            ("zeroWidth", r#""a\u200bb""#, true),
            ("loneSurrogate", r#""a\ud800b""#, true),
        ]),
        "noteText" => text(&[
            ("plain", r#""line\nnext\ttab""#, true),
            ("control", r#""a\u0007b""#, false),
            ("zeroWidth", r#""a\u200bb""#, false),
            ("loneSurrogate", r#""a\ud800b""#, false),
        ]),
        "wellFormed" => text(&[
            ("plain", r#""row""#, true),
            ("pair", r#""a\ud83d\ude00b""#, true),
            ("loneSurrogate", r#""a\ud800b""#, false),
        ]),
        "screenText" => text(&[
            ("rows", r#""one\ntwo\n""#, true),
            ("tab", r#""a\tb""#, false),
            ("return", r#""a\rb""#, false),
            ("control", r#""a\u0007b""#, false),
            ("delete", r#""a\u007fb""#, false),
            ("nextLine", r#""a\u0085b""#, false),
            ("bidi", r#""a\u202eb""#, true),
        ]),
        "taskNoteBytes" => vec![
            (
                "atMaxBytes",
                Value::from("é".repeat(2000)).to_string(),
                true,
            ),
            (
                "pastMaxBytes",
                Value::from("é".repeat(2001)).to_string(),
                false,
            ),
        ],
        "utf8AtMost32Bytes" => vec![
            ("atMaxBytes", Value::from("é".repeat(16)).to_string(), true),
            (
                "pastMaxBytes",
                Value::from("é".repeat(16) + "a").to_string(),
                false,
            ),
        ],
        _ => return None,
    })
}

/// Each object-level check, with the cases it is broken by.
fn object_checks() -> Vec<(&'static str, Vec<ObjectCase>)> {
    const AGENT: &str = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    vec![
        ("agentOrLaunch", {
            let launch = || Some(json!({ "harness": "codex" }));
            vec![
                (
                    "both",
                    vec![("agentId", Some(json!(AGENT))), ("launch", launch())],
                    false,
                ),
                (
                    "agentOnly",
                    vec![("agentId", Some(json!(AGENT))), ("launch", None)],
                    true,
                ),
                (
                    "launchOnly",
                    vec![("agentId", None), ("launch", launch())],
                    true,
                ),
                ("neither", vec![("agentId", None), ("launch", None)], false),
            ]
        }),
        (
            "linkedShellTakesNoCwd",
            vec![
                (
                    "linkedWithCwd",
                    vec![
                        ("linkedAgentId", Some(json!(AGENT))),
                        ("cwd", Some(json!("/w"))),
                    ],
                    false,
                ),
                (
                    "unlinkedWithCwd",
                    vec![("linkedAgentId", None), ("cwd", Some(json!("/w")))],
                    true,
                ),
                (
                    "linkedWithoutCwd",
                    vec![("linkedAgentId", Some(json!(AGENT))), ("cwd", None)],
                    true,
                ),
                (
                    "neither",
                    vec![("linkedAgentId", None), ("cwd", None)],
                    true,
                ),
            ],
        ),
    ]
}

/// The cases `check` is broken by, if it is an object-level check.
fn object_cases(check: &str) -> Option<Vec<ObjectCase>> {
    object_checks()
        .into_iter()
        .find(|(name, _)| *name == check)
        .map(|(_, cases)| cases)
}

/// The JSON text of the largest safe integer plus two, which a double reads as plus one.
const PAST_SAFE: &str = "9007199254740993";

/// The largest safe integer.
const MAX_SAFE: i64 = (1 << 53) - 1;

/// The longest string or list this plants: a bound past it is left unplanted.
const LONGEST: u64 = 100_000;

/// The named checks that take a string of emoji, so a length planted in astral text meets them.
/// A field with any other check may count bytes, or refuse the text.
const ASTRAL_SAFE_CHECKS: &[&str] = &["newTaskTitle", "shellName", "wellFormed", "noControl"];

/// Where the schemas of a field are, on each side.
#[derive(Clone, Copy)]
struct Node<'a> {
    rust: Option<&'a Value>,
    protocol: Option<&'a Value>,
}

/// Walks an example beside both schemas, planting cases.
struct Walk<'a> {
    defs: &'a Map<String, Value>,
    plants: Vec<Plant>,
    problems: BTreeSet<String>,
    schema: &'a str,
}

/// The keywords that describe a value without holding it to anything: the walk plants no case for
/// them, and a schema of them alone takes any value.
const ANNOTATIONS: &[&str] = &[
    "x-bazhen-message",
    "description",
    "title",
    "examples",
    "$comment",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
];

/// Whether `schema` takes any value, null too: `true`, or one of annotations alone.
fn takes_any(schema: &Value) -> bool {
    match schema {
        Value::Bool(any) => *any,
        Value::Object(keywords) => keywords.keys().all(|k| ANNOTATIONS.contains(&k.as_str())),
        _ => false,
    }
}

fn pointer(path: &[String]) -> String {
    path.iter().fold(String::new(), |mut pointer, segment| {
        pointer.push('/');
        pointer.push_str(&segment.replace('~', "~0").replace('/', "~1"));
        pointer
    })
}

fn is_null(schema: &Value) -> bool {
    schema.get("type").and_then(Value::as_str) == Some("null")
        || schema.get("const") == Some(&Value::Null)
}

fn type_of(schema: &Value) -> Option<&str> {
    match schema.get("type") {
        Some(Value::String(only)) => Some(only),
        Some(Value::Array(types)) => types
            .iter()
            .filter_map(Value::as_str)
            .find(|t| *t != "null"),
        _ => None,
    }
}

fn branches(schema: &Value) -> Option<&Vec<Value>> {
    schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
}

/// The step a case's path takes into the branch of a union of `branches` that `value` is:
/// `(key=value)`, by the property each branch pins to a constant of its own, as the fixtures name
/// a branch. Branches can share their fields' paths, so without it two branches' cases would share
/// a key. `planted` passes over it.
fn branch_step(branches: &[&Value], value: &Value) -> Option<String> {
    let pinned = |branch: &Value, key: &str| -> Option<Value> {
        branch.get("properties")?.get(key)?.get("const").cloned()
    };
    let first = branches.first()?.get("properties")?.as_object()?;
    let key = first.keys().find(|key| {
        let constants: Option<Vec<Value>> = branches.iter().map(|b| pinned(b, key)).collect();
        constants.is_some_and(|c| {
            c.iter()
                .enumerate()
                .all(|(i, v)| !c.iter().take(i).any(|w| w == v))
        })
    })?;
    let constant = value.get(key)?;
    let shown = constant
        .as_str()
        .map_or_else(|| constant.to_string(), str::to_owned);
    Some(format!("({key}={shown})"))
}

fn is_branch_step(segment: &str) -> bool {
    segment.starts_with('(') && segment.ends_with(')')
}

/// Whether `value` could be what `schema` describes, by its type, its constants and its
/// required fields: enough to tell which branch of a union an example is.
fn fits(schema: &Value, value: &Value) -> bool {
    if let Some(constant) = schema.get("const") {
        return constant == value;
    }
    if let Some(Value::Array(values)) = schema.get("enum") {
        return values.contains(value);
    }
    let typed = match (type_of(schema), value) {
        (None, _)
        | (Some("object"), Value::Object(_))
        | (Some("array"), Value::Array(_))
        | (Some("string"), Value::String(_))
        | (Some("boolean"), Value::Bool(_))
        | (Some("number"), Value::Number(_)) => true,
        (Some("integer"), Value::Number(n)) => n.is_i64() || n.is_u64(),
        _ => false,
    };
    let Some(object) = value.as_object() else {
        return typed;
    };
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .all(|key| object.contains_key(key));
    let constants = schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .all(|(key, field)| match (field.get("const"), object.get(key)) {
            (Some(constant), Some(value)) => constant == value,
            _ => true,
        });
    typed && required && constants
}

impl<'a> Walk<'a> {
    fn resolved(&self, schema: &'a Value) -> &'a Value {
        let mut schema = schema;
        while let Some(target) = schema
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| r.strip_prefix("#/$defs/"))
        {
            match self.defs.get(target) {
                Some(named) => schema = named,
                None => break,
            }
        }
        schema
    }

    /// The node with each side past its `$ref`s.
    fn resolve(&self, node: Node<'a>) -> Node<'a> {
        Node {
            rust: node.rust.map(|s| self.resolved(s)),
            protocol: node.protocol,
        }
    }

    /// Whether either side takes null at this node.
    fn nullable(&self, node: Node<'a>) -> bool {
        let node = self.resolve(node);
        [node.rust, node.protocol]
            .into_iter()
            .flatten()
            .all(|schema| {
                is_null(schema)
                    || takes_any(schema)
                    || branches(schema).is_some_and(|b| b.iter().any(|b| is_null(self.resolved(b))))
                    || schema
                        .get("type")
                        .and_then(Value::as_array)
                        .is_some_and(|t| t.iter().any(|t| t == "null"))
                    || schema
                        .get("enum")
                        .and_then(Value::as_array)
                        .is_some_and(|e| e.contains(&Value::Null))
            })
    }

    /// The keyword's value on the protocol's side, which is zod's, or else on the Rust side.
    fn keyword(node: Node<'a>, key: &str) -> Option<&'a Value> {
        node.protocol
            .and_then(|s| s.get(key))
            .or_else(|| node.rust.and_then(|s| s.get(key)))
    }

    fn problem(&mut self, path: &Path, what: &str) {
        self.problems
            .insert(format!("{}{}: {what}", self.schema, pointer(path)));
    }

    /// Plants one case. Two at one path with one kind would be one key in `KNOWN_MISMATCHES`,
    /// where an entry must name one case, so that is a problem.
    fn plant(&mut self, path: &Path, kind: &str, edit: Edit, accept: bool) {
        if self
            .plants
            .iter()
            .any(|plant| plant.path == *path && plant.kind == kind)
        {
            self.problems.insert(format!(
                "{}{}: two cases are planted as `{kind}`",
                self.schema,
                pointer(path)
            ));
        }
        self.plants.push(Plant {
            path: path.clone(),
            kind: kind.to_owned(),
            edit,
            accept,
        });
    }

    /// Plants the cases of the field at `path`, holding `value`, which `node` describes.
    fn walk(&mut self, node: Node<'a>, value: &Value, path: &Path) {
        let node = self.resolve(node);
        for schema in [node.rust, node.protocol].into_iter().flatten() {
            for key in schema.as_object().into_iter().flat_map(Map::keys) {
                if !handled(key, schema) {
                    self.problem(path, &format!("the corpus plants no case for `{key}`"));
                }
            }
        }
        let pick = |schema: Option<&'a Value>, walk: &Self| -> Option<Option<&'a Value>> {
            let schema = schema?;
            let branches = branches(schema)?;
            let index = branches
                .iter()
                .filter(|b| !is_null(walk.resolved(b)))
                .position(|b| fits(walk.resolved(b), value));
            Some(index.and_then(|i| {
                branches
                    .iter()
                    .filter(|b| !is_null(walk.resolved(b)))
                    .nth(i)
            }))
        };
        let index_rust = pick(node.rust, self);
        let index_protocol = pick(node.protocol, self);
        if index_rust.is_some() || index_protocol.is_some() {
            if value.is_null() {
                return;
            }
            let rust = index_rust.unwrap_or(node.rust);
            let protocol = index_protocol.unwrap_or(node.protocol);
            if rust.is_none() && protocol.is_none() {
                return;
            }
            let mut path = path.clone();
            path.extend(
                [node.rust, node.protocol]
                    .into_iter()
                    .flatten()
                    .find_map(|union| {
                        let all: Vec<&Value> = branches(union)?
                            .iter()
                            .map(|b| self.resolved(b))
                            .filter(|b| !is_null(b))
                            .collect();
                        branch_step(&all, value)
                    }),
            );
            return self.walk(Node { rust, protocol }, value, &path);
        }
        if value.is_null() {
            return;
        }
        let checks = Self::checks(node);
        if Self::keyword(node, "enum").is_some() || Self::keyword(node, "const").is_some() {
            return self.constants(node, path);
        }
        let ty = node
            .rust
            .and_then(type_of)
            .or_else(|| node.protocol.and_then(type_of));
        match ty {
            Some("object") => self.object(node, value, path, &checks),
            Some("array") => self.array(node, value, path),
            Some("string") => self.string(node, value, path, &checks),
            Some("integer") => self.integer(node, value, path),
            Some("boolean") => self.plant(path, "wrongType", Edit::Put(json!("true")), false),
            Some("number") => self.number(node, path),
            _ => {}
        }
    }

    fn checks(node: Node<'a>) -> Vec<String> {
        match Self::keyword(node, "x-bazhen-check") {
            Some(Value::String(one)) => vec![one.clone()],
            Some(Value::Array(many)) => many
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    }

    fn constants(&mut self, node: Node<'a>, path: &Path) {
        let values = match (Self::keyword(node, "enum"), Self::keyword(node, "const")) {
            (Some(Value::Array(values)), _) => values.clone(),
            (_, Some(constant)) => vec![constant.clone()],
            _ => return,
        };
        for value in values.iter().filter(|v| !v.is_null()) {
            self.plant(
                path,
                &format!("eachValue/{value}"),
                Edit::Put(value.clone()),
                true,
            );
        }
        let other = match values.iter().find(|v| !v.is_null()) {
            Some(Value::Bool(b)) => json!(!b),
            Some(Value::Number(_)) => json!(-1),
            _ => json!("zz-unplanted"),
        };
        if !values.contains(&other) {
            self.plant(path, "otherValue", Edit::Put(other), false);
        }
    }

    fn object(&mut self, node: Node<'a>, value: &Value, path: &Path, checks: &[String]) {
        let Some(object) = value.as_object() else {
            return;
        };
        self.plant(path, "arrayForObject", Edit::Put(json!([])), false);
        let properties = |schema: Option<&'a Value>| {
            schema
                .and_then(|s| s.get("properties"))
                .and_then(Value::as_object)
        };
        let (rust, protocol) = (properties(node.rust), properties(node.protocol));
        if rust.is_none() && protocol.is_none() {
            return self.record(node, object, path);
        }
        let required: BTreeSet<&str> = [node.rust, node.protocol]
            .into_iter()
            .flatten()
            .filter_map(|s| s.get("required").and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        // A check over the whole object may need a field it lets each leave out alone, which the
        // corpus can't judge: the check's own cases leave its fields out.
        let checked: BTreeSet<&str> = checks
            .iter()
            .filter_map(|check| object_cases(check))
            .flatten()
            .flat_map(|(_, fields, _)| fields.into_iter().map(|(key, _)| key))
            .collect();
        let keys: BTreeSet<&String> = rust
            .into_iter()
            .chain(protocol)
            .flat_map(Map::keys)
            .collect();
        for key in keys {
            let field = Node {
                rust: rust.and_then(|p| p.get(key)),
                protocol: protocol.and_then(|p| p.get(key)),
            };
            let mut at = path.clone();
            at.push(key.clone());
            let Some(held) = object.get(key) else {
                continue;
            };
            let optional = !required.contains(key.as_str());
            if !optional || !checked.contains(key.as_str()) {
                self.plant(&at, "leftOut", Edit::Drop, optional);
            }
            if !held.is_null() {
                self.plant(&at, "null", Edit::Put(Value::Null), self.nullable(field));
            }
            self.walk(field, held, &at);
        }
        let mut unknown = path.clone();
        unknown.push("zzUnplanted".to_owned());
        let closed = Self::keyword(node, "additionalProperties") == Some(&Value::Bool(false));
        self.plant(&unknown, "unknownField", Edit::Put(json!(1)), !closed);
        for check in checks {
            match object_cases(check) {
                Some(cases) => {
                    for (name, fields, accept) in cases {
                        let kind = format!("{check}/{name}");
                        self.plant(path, &kind, Edit::Fields(fields), accept);
                    }
                }
                None => {
                    self.problems.insert(format!(
                        "{}{}: the corpus has no cases for the check `{check}`",
                        self.schema,
                        pointer(path)
                    ));
                }
            }
        }
    }

    fn record(&mut self, node: Node<'a>, object: &Map<String, Value>, path: &Path) {
        if let Some((_, held)) = object.iter().next() {
            self.keys(node, held, path);
        }
        let values = Node {
            rust: node.rust.and_then(|s| s.get("additionalProperties")),
            protocol: node.protocol.and_then(|s| s.get("additionalProperties")),
        };
        if let Some((key, held)) = object.iter().next()
            && (values.rust.is_some_and(Value::is_object)
                || values.protocol.is_some_and(Value::is_object))
        {
            let mut at = path.clone();
            at.push(key.clone());
            self.walk(values, held, &at);
        }
    }

    /// Plants the keys a record refuses, and the longest it takes, each holding `held`.
    fn keys(&mut self, node: Node<'a>, held: &Value, path: &Path) {
        let key = |text: &str| Edit::Key(Value::from(text).to_string(), held.clone());
        if Self::keyword(node, "x-bazhen-transform") == Some(&json!("refusingOwnProto")) {
            self.plant(path, "ownProto", key("__proto__"), false);
        }
        let names = Node {
            rust: node.rust.and_then(|s| s.get("propertyNames")),
            protocol: node.protocol.and_then(|s| s.get("propertyNames")),
        };
        for schema in [names.rust, names.protocol].into_iter().flatten() {
            for keyword in schema.as_object().into_iter().flat_map(Map::keys) {
                if !matches!(
                    keyword.as_str(),
                    "type" | "minLength" | "pattern" | "x-bazhen-check"
                ) {
                    self.problem(path, &format!("the corpus plants no key for `{keyword}`"));
                }
            }
        }
        match Self::keyword(names, "minLength").and_then(Value::as_u64) {
            None | Some(0) => {}
            Some(1) => self.plant(path, "emptyKey", key(""), false),
            Some(min) => self.problem(path, &format!("the corpus plants no key under {min}")),
        }
        if let Some(pattern) = Self::keyword(names, "pattern").and_then(Value::as_str) {
            match reserved(pattern) {
                Some(reserved) => {
                    for name in reserved {
                        self.plant(path, &format!("reservedKey/{name}"), key(name), false);
                    }
                }
                None => self.problem(path, &format!("the corpus plants no key for `{pattern}`")),
            }
        }
        for check in Self::checks(names) {
            match check.as_str() {
                "wellFormed" => {
                    let lone = Edit::Key(r#""\ud800""#.to_owned(), held.clone());
                    self.plant(path, "loneSurrogateKey", lone, false);
                }
                "utf8AtMost64Bytes" => {
                    self.plant(path, "keyAtMaxBytes", key(&"é".repeat(32)), true);
                    let past = "é".repeat(32) + "a";
                    self.plant(path, "keyPastMaxBytes", key(&past), false);
                }
                _ => self.problem(
                    path,
                    &format!("the corpus has no keys for the check `{check}`"),
                ),
            }
        }
    }

    fn array(&mut self, node: Node<'a>, value: &Value, path: &Path) {
        let Some(items) = value.as_array() else {
            return;
        };
        self.plant(path, "objectForArray", Edit::Put(json!({})), false);
        let Some(first) = items.first() else {
            return;
        };
        let count = |n: u64| Value::Array(vec![first.clone(); usize::try_from(n).unwrap_or(0)]);
        if let Some(max) = Self::keyword(node, "maxItems").and_then(Value::as_u64)
            && max <= LONGEST
        {
            self.plant(path, "atMaxItems", Edit::Put(count(max)), true);
            self.plant(path, "pastMaxItems", Edit::Put(count(max + 1)), false);
        }
        if let Some(min) = Self::keyword(node, "minItems").and_then(Value::as_u64)
            && min > 0
        {
            self.plant(path, "underMinItems", Edit::Put(count(min - 1)), false);
        }
        let item = Node {
            rust: node.rust.and_then(|s| s.get("items")),
            protocol: node.protocol.and_then(|s| s.get("items")),
        };
        let mut at = path.clone();
        at.push("0".to_owned());
        self.walk(item, first, &at);
    }

    /// A length held in astral text, which zod counts in code points, an astral character being
    /// one and two UTF-16 units.
    fn astral_lengths(&mut self, path: &Path, min: u64, max: Option<u64>, checks: &[String]) {
        if !checks
            .iter()
            .all(|check| ASTRAL_SAFE_CHECKS.contains(&check.as_str()))
        {
            return;
        }
        let astral = |n: u64| "\u{1f600}".repeat(usize::try_from(n).unwrap_or(0));
        if min >= 2 {
            let under = astral(min - 1);
            self.plant(path, "astralUnderMinLength", Edit::Put(json!(under)), false);
        }
        if let Some(max) = max.filter(|max| (1..=LONGEST).contains(max)) {
            self.plant(
                path,
                "astralAtMaxLength",
                Edit::Put(json!(astral(max))),
                true,
            );
            let past = astral(max + 1);
            self.plant(path, "astralPastMaxLength", Edit::Put(json!(past)), false);
        }
    }

    fn string(&mut self, node: Node<'a>, value: &Value, path: &Path, checks: &[String]) {
        self.plant(path, "wrongType", Edit::Put(json!(1)), false);
        let pattern = Self::keyword(node, "pattern").and_then(Value::as_str);
        let patterned = pattern.is_some();
        match (pattern, value.as_str()) {
            (None, _) => {}
            (Some(pattern), Some(held)) if refuses_bang(pattern) => {
                let leading = json!(format!("!{held}"));
                self.plant(path, "patternLeading", Edit::Put(leading), false);
                let trailing = json!(format!("{held}!"));
                self.plant(path, "patternTrailing", Edit::Put(trailing), false);
            }
            (Some(pattern), Some(held)) if starts_with_literal(pattern) => {
                let leading = json!(format!("!{held}"));
                self.plant(path, "patternLeading", Edit::Put(leading), false);
            }
            (Some(pattern), _) => {
                self.problem(path, &format!("the corpus plants no case for `{pattern}`"));
            }
        }
        let min = Self::keyword(node, "minLength")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let max = Self::keyword(node, "maxLength").and_then(Value::as_u64);
        let trims = Self::keyword(node, "x-bazhen-transform") == Some(&json!("trim"));
        let units = |n: u64| "a".repeat(usize::try_from(n).unwrap_or(0));
        if !patterned {
            if min > 0 {
                self.plant(
                    path,
                    "underMinLength",
                    Edit::Put(json!(units(min - 1))),
                    false,
                );
            }
            if let Some(max) = max.filter(|max| *max <= LONGEST) {
                self.plant(path, "atMaxLength", Edit::Put(json!(units(max))), true);
                self.plant(
                    path,
                    "pastMaxLength",
                    Edit::Put(json!(units(max + 1))),
                    false,
                );
            }
            self.astral_lengths(path, min, max, checks);
            if trims && min > 0 {
                self.plant(path, "blank", Edit::Put(json!("   ")), false);
                let padded = |pad: &str| json!(format!("{pad}{}{pad}", units(min)));
                self.plant(path, "padded", Edit::Put(padded("  ")), true);
                // zod trims as JavaScript does: U+FEFF but not U+0085, which every check refuses.
                self.plant(
                    path,
                    "paddedByteOrderMark",
                    Edit::Put(padded("\u{feff}")),
                    true,
                );
                let next_line = checks.is_empty();
                self.plant(
                    path,
                    "paddedNextLine",
                    Edit::Put(padded("\u{85}")),
                    next_line,
                );
            }
            if checks.is_empty() && min <= 1 && max.is_none_or(|max| max >= 1) {
                self.plant(
                    path,
                    "loneSurrogate",
                    Edit::Raw(r#""\ud800""#.to_owned()),
                    true,
                );
            }
        }
        for check in checks {
            match check_cases(check) {
                Some(cases) => {
                    for (name, json, accept) in cases {
                        let kind = format!("{check}/{name}");
                        self.plant(path, &kind, Edit::Raw(json), accept);
                    }
                }
                None => {
                    self.problems.insert(format!(
                        "{}{}: the corpus has no cases for the check `{check}`",
                        self.schema,
                        pointer(path)
                    ));
                }
            }
        }
    }

    fn integer(&mut self, node: Node<'a>, value: &Value, path: &Path) {
        self.plant(path, "wrongType", Edit::Put(json!("1")), false);
        let Some(held) = value.as_i64() else {
            return;
        };
        self.plant(path, "fraction", Edit::Raw(format!("{held}.5")), false);
        self.plant(path, "integralFloat", Edit::Raw(format!("{held}.0")), true);
        self.plant(path, "exponent", Edit::Raw(format!("{held}e0")), true);
        let min = Self::keyword(node, "minimum").and_then(Value::as_i64);
        let max = Self::keyword(node, "maximum").and_then(Value::as_i64);
        if let Some(floor) = Self::keyword(node, "exclusiveMinimum").and_then(Value::as_i64) {
            self.plant(path, "atExclusiveMinimum", Edit::Put(json!(floor)), false);
        }
        if let Some(min) = min {
            self.plant(path, "atMinimum", Edit::Put(json!(min)), true);
            self.plant(
                path,
                "underMinimum",
                Edit::Raw((i128::from(min) - 1).to_string()),
                false,
            );
        }
        if let Some(max) = max {
            self.plant(path, "atMaximum", Edit::Put(json!(max)), true);
            self.plant(
                path,
                "pastMaximum",
                Edit::Raw((i128::from(max) + 1).to_string()),
                false,
            );
            if max == MAX_SAFE {
                self.plant(path, "pastSafe", Edit::Raw(PAST_SAFE.to_owned()), false);
            }
        }
    }

    fn number(&mut self, node: Node<'a>, path: &Path) {
        self.plant(path, "wrongType", Edit::Put(json!("1")), false);
        if let Some(floor) = Self::keyword(node, "exclusiveMinimum").and_then(Value::as_f64) {
            self.plant(path, "atExclusiveMinimum", Edit::Put(json!(floor)), false);
        }
        if let Some(min) = Self::keyword(node, "minimum").and_then(Value::as_f64) {
            self.plant(path, "atMinimum", Edit::Put(json!(min)), true);
            self.plant(path, "underMinimum", Edit::Put(json!(min - 1.0)), false);
        }
        if let Some(max) = Self::keyword(node, "maximum").and_then(Value::as_f64) {
            self.plant(path, "atMaximum", Edit::Put(json!(max)), true);
            self.plant(path, "pastMaximum", Edit::Put(json!(max + 1.0)), false);
        }
    }
}

/// Whether the corpus plants the cases `key` makes in `schema`, or `key` makes none.
fn handled(key: &str, schema: &Value) -> bool {
    match key {
        _ if ANNOTATIONS.contains(&key) => true,
        "$ref" | "$schema" | "$id" | "$defs" | "type" | "properties" | "required" | "items"
        | "enum" | "const" | "oneOf" | "anyOf" | "minLength" | "maxLength" | "pattern"
        | "minimum" | "maximum" | "exclusiveMinimum" | "minItems" | "maxItems"
        | "x-bazhen-check" | "propertyNames" => true,
        "additionalProperties" => schema
            .get(key)
            .is_some_and(|v| v.is_object() || v.is_boolean()),
        "x-bazhen-transform" => matches!(
            schema.get(key).and_then(Value::as_str),
            Some("trim" | "refusingOwnProto")
        ),
        // A number's format names its width, which its bounds state; a date-time's, the pattern
        // beside it.
        "format" => match type_of(schema) {
            Some("integer" | "number") => true,
            Some("string") => schema.get("pattern").is_some(),
            _ => false,
        },
        _ => false,
    }
}

/// Whether `pattern` refuses a `!` at either end of what it takes: it is anchored at both, and
/// holds no `.`, negated class or `!` that could match one but in a lookahead's opening.
fn refuses_bang(pattern: &str) -> bool {
    let body = pattern.replace("(?!", "").replace("\\.", "");
    pattern.starts_with('^')
        && pattern.ends_with('$')
        && !body.contains(['!', '.'])
        && !body.contains("[^")
}

/// Whether `pattern` is zod's `startsWith`, `^` and a literal text and `.*`, which a `!` before
/// what it takes breaks, and nothing after it does.
fn starts_with_literal(pattern: &str) -> bool {
    let Some(literal) = pattern
        .strip_prefix('^')
        .and_then(|rest| rest.strip_suffix(".*"))
    else {
        return false;
    };
    let mut text = String::new();
    let mut chars = literal.chars();
    while let Some(c) = chars.next() {
        let c = match c {
            '\\' => match chars.next() {
                Some(escaped) if !escaped.is_ascii_alphanumeric() => escaped,
                _ => return false,
            },
            c if r"\.^$*+?()[]{}|".contains(c) => return false,
            c => c,
        };
        text.push(c);
    }
    !text.is_empty() && !text.starts_with('!')
}

/// The names a key pattern written `^(?!(?:a|b)$)` reserves, or `None` for any other pattern.
fn reserved(pattern: &str) -> Option<Vec<&str>> {
    let names = pattern.strip_prefix("^(?!(?:")?.strip_suffix(")$)")?;
    let word = |name: &str| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    names
        .split('|')
        .all(word)
        .then(|| names.split('|').collect())
}

/// `example` with `plant` made in it, as JSON text.
fn planted(example: &Value, plant: &Plant) -> Option<String> {
    const MARK: &str = "\u{0}planted\u{0}";
    let mut body = example.clone();
    let steps: Vec<&String> = plant.path.iter().filter(|s| !is_branch_step(s)).collect();
    let (last, parents) = match steps.split_last() {
        Some((last, parents)) => (Some(*last), parents),
        None => (None, &[][..]),
    };
    let mut at = &mut body;
    for segment in parents {
        at = match at {
            Value::Object(object) => object.get_mut(segment.as_str())?,
            Value::Array(items) => items.get_mut(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    let put = |at: &mut Value, value: Value| match (at, last) {
        (at, None) => *at = value,
        (Value::Object(object), Some(key)) => {
            object.insert(key.clone(), value);
        }
        (Value::Array(items), Some(index)) => {
            if let Some(slot) = index.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                *slot = value;
            }
        }
        _ => {}
    };
    let mut raw = None;
    match &plant.edit {
        Edit::Keep => {}
        Edit::Drop => {
            if let (Value::Object(object), Some(key)) = (at, last) {
                object.remove(key);
            }
        }
        Edit::Put(value) => put(at, value.clone()),
        Edit::Raw(text) => {
            put(at, Value::from(MARK));
            raw = Some(text);
        }
        Edit::Fields(_) | Edit::Key(..) => {
            let target = match (at, last) {
                (at, None) => at,
                (Value::Object(object), Some(key)) => object.get_mut(key)?,
                _ => return None,
            };
            let object = target.as_object_mut()?;
            if let Edit::Key(key, value) = &plant.edit {
                object.insert(MARK.to_owned(), value.clone());
                raw = Some(key);
            }
            for (key, value) in match &plant.edit {
                Edit::Fields(fields) => fields.as_slice(),
                _ => &[],
            } {
                match value {
                    Some(value) => object.insert((*key).to_owned(), value.clone()),
                    None => object.remove(*key),
                };
            }
        }
    }
    let text = body.to_string();
    Some(match raw {
        Some(raw) => text.replacen(&Value::from(MARK).to_string(), raw, 1),
        None => text,
    })
}

/// The examples a fixture file holds that plant cases: the ones with a field no version defines
/// are cases of their own, and plant none.
fn examples(fixture: &Value) -> Vec<(bool, &Value)> {
    fixture
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|example| {
            let name = example
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let wire = example.get("wire")?;
            Some((!name.contains("no version defines"), wire))
        })
        .collect()
}

/// Every case planted in each message `defs` holds that has a fixture: `protocol` gives the
/// protocol's own schema of a message, and `fixture` its fixture file. Each check named where no
/// cases are listed for it is a problem.
pub(crate) fn plant(
    defs: &Map<String, Value>,
    protocol: &dyn Fn(&str) -> Option<Value>,
    fixture: &dyn Fn(&str) -> Option<Value>,
) -> Result<Vec<Case>, Vec<String>> {
    let mut cases = Vec::new();
    let mut problems = BTreeSet::new();
    for (name, schema) in defs {
        let Some(fixture) = fixture(name) else {
            continue;
        };
        let theirs = protocol(name);
        let mut seen = BTreeSet::new();
        for (plants, example) in examples(&fixture) {
            let mut walk = Walk {
                defs,
                plants: Vec::new(),
                problems: BTreeSet::new(),
                schema: name,
            };
            walk.plant(&Vec::new(), "example", Edit::Keep, true);
            if plants {
                let node = Node {
                    rust: Some(schema),
                    protocol: theirs.as_ref(),
                };
                walk.walk(node, example, &Vec::new());
            }
            problems.append(&mut walk.problems);
            for plant in &walk.plants {
                let Some(body) = planted(example, plant) else {
                    continue;
                };
                if seen.insert(body.clone()) {
                    cases.push(Case {
                        schema: name.clone(),
                        path: pointer(&plant.path),
                        kind: plant.kind.clone(),
                        body,
                        accept: plant.accept,
                    });
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(cases)
    } else {
        Err(problems.into_iter().collect())
    }
}

/// Each case the edge's verdict disagrees with outside `KNOWN_MISMATCHES`, and each entry there
/// that no longer disagrees. `verdicts` holds the edge's verdict on each case, in order, or null
/// where the edge doesn't read the message.
pub(crate) fn mismatched(cases: &[Case], verdicts: &[Value], known: Known<'_>) -> Vec<String> {
    let mut found = Vec::new();
    let mut listed = BTreeSet::new();
    for (case, verdict) in cases.iter().zip(verdicts) {
        let taken = match (verdict.get("taken"), verdict.get("refused")) {
            (Some(_), _) => true,
            (None, Some(_)) => false,
            (None, None) => continue,
        };
        if taken == case.accept {
            continue;
        }
        let key = (case.schema.as_str(), case.path.as_str(), case.kind.as_str());
        if known
            .iter()
            .any(|(schema, path, kind, _, _)| (*schema, *path, *kind) == key)
        {
            listed.insert(key);
            continue;
        }
        let (said, edge) = if case.accept {
            ("takes", format!("refuses it: {}", verdict["refused"]))
        } else {
            ("refuses", "takes it".to_owned())
        };
        found.push(format!(
            "{}{} ({}): the protocol {said} {}, and the edge {edge}",
            case.schema, case.path, case.kind, case.body
        ));
    }
    for (schema, path, kind, _, _) in known {
        if !listed.contains(&(*schema, *path, *kind)) {
            found.push(format!(
                "KNOWN_MISMATCHES lists {schema}{path} ({kind}), which the edge now agrees with"
            ));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(path: &str, kind: &str, accept: bool) -> Case {
        Case {
            schema: "M".to_owned(),
            path: path.to_owned(),
            kind: kind.to_owned(),
            body: "{}".to_owned(),
            accept,
        }
    }

    fn plant_at(path: &[&str], edit: Edit) -> Plant {
        Plant {
            path: path.iter().map(|s| (*s).to_owned()).collect(),
            kind: "k".to_owned(),
            edit,
            accept: true,
        }
    }

    #[test]
    fn plants_each_edit_at_its_path() {
        let example = json!({ "a": { "b": 1, "c": [2, 3] } });
        let at = |path: &[&str], edit| planted(&example, &plant_at(path, edit));
        assert_eq!(
            at(&["a", "b"], Edit::Drop).as_deref(),
            Some(r#"{"a":{"c":[2,3]}}"#)
        );
        assert_eq!(
            at(&["a", "c", "1"], Edit::Put(json!(null))).as_deref(),
            Some(r#"{"a":{"b":1,"c":[2,null]}}"#)
        );
        assert_eq!(
            at(&["a", "b"], Edit::Raw("1.0".to_owned())).as_deref(),
            Some(r#"{"a":{"b":1.0,"c":[2,3]}}"#)
        );
        assert_eq!(
            at(
                &["a"],
                Edit::Fields(vec![("b", None), ("d", Some(json!(true)))])
            )
            .as_deref(),
            Some(r#"{"a":{"c":[2,3],"d":true}}"#)
        );
        assert_eq!(at(&["x", "b"], Edit::Drop), None);
    }

    /// The cases planted in one example of `M`, whose Rust schema is `rust` and whose protocol
    /// schema is `protocol`, or the problems.
    fn planted_in(
        rust: &Value,
        protocol: Option<&Value>,
        example: &Value,
    ) -> Result<Vec<Case>, Vec<String>> {
        let mut defs = Map::new();
        defs.insert("M".to_owned(), rust.clone());
        let fixture = json!([{ "name": "one", "wire": example }]);
        plant(&defs, &|_| protocol.cloned(), &|_| Some(fixture.clone()))
    }

    fn has(cases: &[Case], path: &str, kind: &str, accept: bool) -> bool {
        cases
            .iter()
            .any(|c| c.path == path && c.kind == kind && c.accept == accept)
    }

    #[test]
    fn names_the_branch_of_a_union_its_cases_are_planted_in() {
        let branch = |tag: &str| {
            json!({
                "type": "object",
                "properties": {
                    "entity": { "type": "string", "const": "e" },
                    "type": { "type": "string", "const": tag },
                    "n": { "type": "string", "minLength": 1 },
                },
                "required": ["entity", "type", "n"],
            })
        };
        let union = json!({ "anyOf": [branch("a.b"), branch("c")] });
        let example = json!({ "entity": "e", "type": "a.b", "n": "x" });
        let cases = planted_in(&union, None, &example).unwrap();
        assert!(
            has(&cases, "/(type=a.b)/n", "underMinLength", false),
            "{cases:?}"
        );
        assert!(!cases.iter().any(|c| c.path == "/n"), "{cases:?}");
        assert!(
            cases
                .iter()
                .any(|c| c.body == r#"{"entity":"e","n":"","type":"a.b"}"#),
            "{cases:?}"
        );
    }

    #[test]
    fn plants_only_a_leading_break_for_a_pattern_a_literal_starts() {
        let field = |pattern: &str| {
            json!({
                "type": "object",
                "properties": { "path": { "type": "string", "pattern": pattern } },
                "required": ["path"],
            })
        };
        let example = json!({ "path": "/a" });
        let cases = planted_in(&field("^\\/.*"), None, &example).unwrap();
        assert!(has(&cases, "/path", "patternLeading", false), "{cases:?}");
        assert!(
            cases.iter().any(|c| c.body == r#"{"path":"!/a"}"#),
            "{cases:?}"
        );
        assert!(
            !cases.iter().any(|c| c.kind == "patternTrailing"),
            "{cases:?}"
        );
        for unbreakable in ["^.*", "^\\d.*", "^a+.*", "^!a.*", "^a.*$"] {
            let problems = planted_in(&field(unbreakable), None, &example).unwrap_err();
            assert_eq!(
                problems,
                [format!(
                    "M/path: the corpus plants no case for `{unbreakable}`"
                )]
            );
        }
    }

    #[test]
    fn plants_a_pattern_broken_at_each_end_and_refuses_one_it_cant_break() {
        let field = |pattern: &str| {
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "pattern": pattern } },
                "required": ["id"],
            })
        };
        let example = json!({ "id": "task_1" });
        let cases = planted_in(&field("^task_[0-9]$"), None, &example).unwrap();
        for kind in ["patternLeading", "patternTrailing"] {
            assert!(has(&cases, "/id", kind, false), "{kind} in {cases:?}");
        }
        assert!(
            cases.iter().any(|c| c.body == r#"{"id":"task_1!"}"#),
            "{cases:?}"
        );
        for unbreakable in ["^task_.*$", "task_[0-9]", "^task_[^x]$", "^task_!?$"] {
            let problems = planted_in(&field(unbreakable), None, &example).unwrap_err();
            assert_eq!(
                problems,
                [format!(
                    "M/id: the corpus plants no case for `{unbreakable}`"
                )]
            );
        }
    }

    #[test]
    fn plants_astral_lengths_in_code_points_where_no_check_counts_otherwise() {
        let field = |check: Option<&str>| {
            let mut name = json!({ "type": "string", "minLength": 2, "maxLength": 3 });
            if let Some(check) = check {
                name["x-bazhen-check"] = json!(check);
            }
            json!({ "type": "object", "properties": { "s": name }, "required": ["s"] })
        };
        let example = json!({ "s": "ab" });
        let planted = |cases: &[Case], kind: &str| {
            cases.iter().find(|c| c.kind == kind).map(|c| {
                let body: Value = serde_json::from_str(&c.body).unwrap();
                (body["s"].as_str().unwrap().chars().count(), c.accept)
            })
        };
        for check in [None, Some("shellName")] {
            let cases = planted_in(&field(check), None, &example).unwrap();
            assert_eq!(planted(&cases, "astralUnderMinLength"), Some((1, false)));
            assert_eq!(planted(&cases, "astralAtMaxLength"), Some((3, true)));
            assert_eq!(planted(&cases, "astralPastMaxLength"), Some((4, false)));
            assert!(
                cases
                    .iter()
                    .filter(|c| c.kind.starts_with("astral"))
                    .all(|c| c.body.contains('\u{1f600}') && !c.body.contains('a')),
                "{cases:?}"
            );
        }
        let bytes = planted_in(&field(Some("taskNoteBytes")), None, &example).unwrap();
        assert!(
            !bytes.iter().any(|c| c.kind.starts_with("astral")),
            "{bytes:?}"
        );
    }

    #[test]
    fn plants_null_as_taken_where_the_schema_takes_any_value() {
        let field = |schema: Value| json!({ "type": "object", "properties": { "v": schema }, "required": ["v"] });
        let example = json!({ "v": 1 });
        let null_taken = |rust: Value, protocol: Option<Value>| {
            let protocol = protocol.map(field);
            let cases = planted_in(&field(rust), protocol.as_ref(), &example).unwrap();
            cases.iter().find(|c| c.kind == "null").map(|c| c.accept)
        };
        assert_eq!(null_taken(json!(true), Some(json!({}))), Some(true));
        assert_eq!(
            null_taken(json!({ "description": "any" }), None),
            Some(true)
        );
        let annotated =
            json!({ "default": 1, "deprecated": true, "readOnly": true, "writeOnly": false });
        assert_eq!(null_taken(annotated, None), Some(true));
        assert_eq!(
            null_taken(json!(true), Some(json!({ "type": "number" }))),
            Some(false)
        );
        assert_eq!(null_taken(json!({ "type": "number" }), None), Some(false));
    }

    #[test]
    fn plants_no_left_out_for_a_field_a_whole_object_check_reads() {
        let message = |check: Option<&str>| {
            let mut schema = json!({
                "type": "object",
                "properties": {
                    "idempotencyKey": { "type": "string" },
                    "cwd": { "type": "string" },
                    "linkedAgentId": { "type": "string" },
                    "theme": { "type": "string" },
                },
                "required": ["idempotencyKey"],
            });
            if let Some(check) = check {
                schema["x-bazhen-check"] = json!(check);
            }
            schema
        };
        let example = json!({ "idempotencyKey": "k", "cwd": "/w", "theme": "t" });
        let left_out = |cases: &[Case]| {
            cases
                .iter()
                .filter(|c| c.kind == "leftOut")
                .map(|c| (c.path.clone(), c.accept))
                .collect::<Vec<_>>()
        };
        let unchecked = planted_in(&message(None), None, &example).unwrap();
        assert_eq!(
            left_out(&unchecked),
            [
                ("/cwd".to_owned(), true),
                ("/idempotencyKey".to_owned(), false),
                ("/theme".to_owned(), true),
            ]
        );
        let checked = planted_in(&message(Some("linkedShellTakesNoCwd")), None, &example).unwrap();
        assert_eq!(
            left_out(&checked),
            [
                ("/idempotencyKey".to_owned(), false),
                ("/theme".to_owned(), true),
            ]
        );
        let neither = checked
            .iter()
            .find(|c| c.kind == "linkedShellTakesNoCwd/neither")
            .unwrap();
        assert_eq!(
            (neither.body.as_str(), neither.accept),
            (r#"{"idempotencyKey":"k","theme":"t"}"#, true)
        );
    }

    #[test]
    fn breaks_each_whole_object_check_by_every_set_of_its_fields_left_out() {
        for (check, cases) in object_checks() {
            let fields: BTreeSet<&str> = cases
                .iter()
                .flat_map(|(_, fields, _)| fields.iter().map(|(key, _)| *key))
                .collect();
            let held: BTreeSet<Vec<&str>> = cases
                .iter()
                .map(|(_, set, _)| {
                    let mut held: Vec<&str> = set
                        .iter()
                        .filter(|(_, value)| value.is_some())
                        .map(|(key, _)| *key)
                        .collect();
                    held.sort_unstable();
                    held
                })
                .collect();
            assert_eq!(
                (cases.len(), held.len()),
                (1 << fields.len(), 1 << fields.len()),
                "{check}: {held:?}"
            );
        }
    }

    #[test]
    fn takes_each_bound_from_the_protocols_side_where_both_give_it() {
        let field = |max: u64| {
            json!({
                "type": "object",
                "properties": { "n": { "type": "integer", "minimum": 0, "maximum": max } },
                "required": ["n"],
            })
        };
        let cases = planted_in(&field(9), Some(&field(5)), &json!({ "n": 1 })).unwrap();
        assert!(has(&cases, "/n", "atMaximum", true), "{cases:?}");
        assert!(
            cases
                .iter()
                .any(|c| c.kind == "atMaximum" && c.body == r#"{"n":5}"#),
            "{cases:?}"
        );
        assert!(
            cases
                .iter()
                .any(|c| c.kind == "pastMaximum" && c.body == r#"{"n":6}"#),
            "{cases:?}"
        );
    }

    #[test]
    fn plants_an_exclusive_minimum_and_a_numbers_bounds() {
        let message = json!({
            "type": "object",
            "properties": {
                "n": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9 },
                "x": { "type": "number", "format": "double", "minimum": 0.0, "maximum": 1.0 },
            },
            "required": ["n", "x"],
        });
        let cases = planted_in(&message, None, &json!({ "n": 1, "x": 0.5 })).unwrap();
        let body = |kind: &str, path: &str| {
            cases
                .iter()
                .find(|c| c.path == path && c.kind == kind)
                .map(|c| (c.accept, c.body.as_str()))
        };
        assert_eq!(
            body("atExclusiveMinimum", "/n"),
            Some((false, r#"{"n":0,"x":0.5}"#))
        );
        assert_eq!(
            body("underMinimum", "/x"),
            Some((false, r#"{"n":1,"x":-1.0}"#))
        );
        assert_eq!(body("atMaximum", "/x"), Some((true, r#"{"n":1,"x":1.0}"#)));
        assert_eq!(
            body("pastMaximum", "/x"),
            Some((false, r#"{"n":1,"x":2.0}"#))
        );
    }

    #[test]
    fn plants_the_keys_a_record_refuses_and_the_longest_it_takes() {
        let record = json!({
            "type": "object",
            "additionalProperties": { "type": "string" },
            "propertyNames": {
                "type": "string",
                "minLength": 1,
                "pattern": "^(?!(?:__proto__|constructor)$)",
                "x-bazhen-check": ["wellFormed", "utf8AtMost64Bytes"],
            },
            "x-bazhen-transform": "refusingOwnProto",
        });
        let cases = planted_in(&record, None, &json!({ "k": "v" })).unwrap();
        for (kind, accept, body) in [
            ("emptyKey", false, r#"{"":"v","k":"v"}"#.to_owned()),
            (
                "reservedKey/constructor",
                false,
                r#"{"constructor":"v","k":"v"}"#.to_owned(),
            ),
            (
                "loneSurrogateKey",
                false,
                r#"{"\ud800":"v","k":"v"}"#.to_owned(),
            ),
            (
                "keyAtMaxBytes",
                true,
                format!(r#"{{"{}":"v","k":"v"}}"#, "é".repeat(32)),
            ),
            (
                "keyPastMaxBytes",
                false,
                format!(r#"{{"{}a":"v","k":"v"}}"#, "é".repeat(32)),
            ),
        ] {
            let found = cases
                .iter()
                .find(|c| c.kind == kind)
                .map(|c| (c.accept, c.body.clone()));
            assert_eq!(found, Some((accept, body)), "{kind} in {cases:?}");
        }
        let own = r#"{"__proto__":"v","k":"v"}"#;
        assert!(
            cases.iter().any(|c| c.body == own && !c.accept),
            "{cases:?}"
        );
    }

    #[test]
    fn fails_on_a_keyword_it_plants_no_case_for() {
        let field = |extra: Value| {
            let mut n = json!({ "type": "integer", "minimum": 0, "maximum": 9 });
            n.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            json!({ "type": "object", "properties": { "n": n }, "required": ["n"] })
        };
        let problems = planted_in(&field(json!({ "multipleOf": 2 })), None, &json!({ "n": 2 }));
        assert_eq!(
            problems.unwrap_err(),
            ["M/n: the corpus plants no case for `multipleOf`"]
        );
        let protocol = field(json!({ "exclusiveMaximum": 9 }));
        let problems = planted_in(&field(json!({})), Some(&protocol), &json!({ "n": 2 }));
        assert_eq!(
            problems.unwrap_err(),
            ["M/n: the corpus plants no case for `exclusiveMaximum`"]
        );
        let text = json!({
            "type": "object",
            "properties": { "at": { "type": "string", "format": "date-time" } },
            "required": ["at"],
        });
        assert_eq!(
            planted_in(&text, None, &json!({ "at": "x" })).unwrap_err(),
            ["M/at: the corpus plants no case for `format`"]
        );
    }

    #[test]
    fn fails_on_two_cases_planted_as_one_kind_at_one_path() {
        let mut walk = Walk {
            defs: &Map::new(),
            plants: Vec::new(),
            problems: BTreeSet::new(),
            schema: "M",
        };
        let at = vec!["a".to_owned()];
        walk.plant(&at, "k", Edit::Put(json!(1)), true);
        walk.plant(&at, "k", Edit::Put(json!(2)), true);
        walk.plant(&Vec::new(), "k", Edit::Put(json!(3)), true);
        assert_eq!(
            walk.problems.into_iter().collect::<Vec<_>>(),
            ["M/a: two cases are planted as `k`"]
        );
    }

    #[test]
    fn plants_each_keyword_of_either_schema_once_from_each_example() {
        let message = json!({
            "type": "object",
            "properties": { "title": { "type": "string", "maxLength": 3 } },
            "required": ["title"],
            "additionalProperties": false,
        });
        let mut defs = Map::new();
        defs.insert("M".to_owned(), message.clone());
        defs.insert("Unfixtured".to_owned(), message);
        let fixture = json!([
            { "name": "short", "wire": { "title": "ab" } },
            { "name": "short again", "wire": { "title": "ab" } },
            { "name": "a field no version defines", "wire": { "title": "ab", "x": 1 } },
        ]);
        let cases = plant(&defs, &|_| None, &|name| {
            (name == "M").then(|| fixture.clone())
        })
        .unwrap();
        let found: Vec<(&str, &str, bool)> = cases
            .iter()
            .map(|c| (c.path.as_str(), c.kind.as_str(), c.accept))
            .collect();
        assert!(cases.iter().all(|c| c.schema == "M"), "{found:?}");
        for expected in [
            ("", "example", true),
            ("/title", "leftOut", false),
            ("/title", "atMaxLength", true),
            ("/title", "pastMaxLength", false),
            ("/title", "wrongType", false),
            ("/zzUnplanted", "unknownField", false),
        ] {
            assert!(found.contains(&expected), "{expected:?} in {found:?}");
        }
        let bodies: BTreeSet<&str> = cases.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(bodies.len(), cases.len(), "each body once");
        assert!(bodies.contains(r#"{"title":"ab","x":1}"#), "{bodies:?}");
    }

    #[test]
    fn fails_on_each_disagreement_outside_the_known_list_and_each_stale_entry() {
        let cases = [
            case("/a", "agrees", true),
            case("/a", "known", true),
            case("/a", "takes", false),
            case("/a", "refuses", true),
            case("/a", "unread", true),
        ];
        let verdicts = [
            json!({ "taken": {} }),
            json!({ "refused": "no" }),
            json!({ "taken": {} }),
            json!({ "refused": "too long" }),
            Value::Null,
        ];
        let known: Known<'_> = &[
            ("M", "/a", "known", "owner", "why"),
            ("M", "/a", "gone", "owner", "why"),
        ];
        assert_eq!(
            mismatched(&cases, &verdicts, known),
            vec![
                "M/a (takes): the protocol refuses {}, and the edge takes it".to_owned(),
                r#"M/a (refuses): the protocol takes {}, and the edge refuses it: "too long""#
                    .to_owned(),
                "KNOWN_MISMATCHES lists M/a (gone), which the edge now agrees with".to_owned(),
            ]
        );
    }
}
