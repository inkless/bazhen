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

/// The cases the edge's verdict disagrees with today, each with its message, path and kind,
/// what owns the fix, and why they differ. The list only shrinks: an entry that no longer
/// disagrees fails, as does a disagreement not listed.
/// Each disagreement the edge may keep, as (message, path, kind, owner, reason).
pub(crate) type Known<'a> = &'a [(&'a str, &'a str, &'a str, &'a str, &'a str)];

pub(crate) const KNOWN_MISMATCHES: Known<'static> = &[
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
        "shellName",
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
];

/// Who owns a lone surrogate in a request's text.
const OWNER_STRINGS: &str = "the protocol's request strings";

/// Why the edge refuses a lone surrogate the protocol takes.
const LONE: &str = "zod takes a lone surrogate in a plain string, which serde_json refuses \
                    and no Rust string or UTF-8 store can hold";

/// The test the protocol's schema names `check` makes, as cases: JSON text put at the field, and
/// whether the check takes it. `None` for a check this has no cases for.
fn check_cases(check: &str) -> Option<Vec<(String, bool)>> {
    let text = |cases: &[(&str, bool)]| {
        cases
            .iter()
            .map(|(json, accept)| ((*json).to_owned(), *accept))
            .collect::<Vec<_>>()
    };
    Some(match check {
        "newTaskTitle" => text(&[
            (r#""fix the build""#, true),
            (r#""a\u0007b""#, false),
            (r#""a\u202eb""#, false),
            (r#""a\u200bb""#, false),
            (r#""a\udb40\udc01b""#, false),
            (r#""a\ud800b""#, false),
        ]),
        "shellName" => text(&[
            (r#""build""#, true),
            (r#""a\u0007b""#, false),
            (r#""a\u202eb""#, false),
            (r#""a\u200bb""#, true),
            (r#""a\ud800b""#, true),
        ]),
        "noteText" => text(&[
            (r#""line\nnext\ttab""#, true),
            (r#""a\u0007b""#, false),
            (r#""a\u200bb""#, false),
            (r#""a\ud800b""#, false),
        ]),
        "taskNoteBytes" => vec![
            (Value::from("é".repeat(2000)).to_string(), true),
            (Value::from("é".repeat(2001)).to_string(), false),
        ],
        _ => return None,
    })
}

/// The fields an object-level check is broken by, and whether it takes them.
fn object_cases(check: &str) -> Option<Vec<(Fields, bool)>> {
    const AGENT: &str = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
    Some(match check {
        "agentOrLaunch" => vec![(vec![("agentId", None), ("launch", None)], false)],
        "linkedShellTakesNoCwd" => vec![
            (
                vec![
                    ("linkedAgentId", Some(json!(AGENT))),
                    ("cwd", Some(json!("/w"))),
                ],
                false,
            ),
            (
                vec![("linkedAgentId", None), ("cwd", Some(json!("/w")))],
                true,
            ),
        ],
        _ => return None,
    })
}

/// The JSON text of the largest safe integer plus two, which a double reads as plus one.
const PAST_SAFE: &str = "9007199254740993";

/// The largest safe integer.
const MAX_SAFE: i64 = (1 << 53) - 1;

/// The longest string or list this plants: a bound past it is left unplanted.
const LONGEST: u64 = 100_000;

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

    fn keyword(node: Node<'a>, key: &str) -> Option<&'a Value> {
        node.rust
            .and_then(|s| s.get(key))
            .or_else(|| node.protocol.and_then(|s| s.get(key)))
    }

    fn plant(&mut self, path: &Path, kind: &str, edit: Edit, accept: bool) {
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
            return self.walk(Node { rust, protocol }, value, path);
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
            Some("string") => self.string(node, path, &checks),
            Some("integer") => self.integer(node, value, path),
            Some("boolean") => self.plant(path, "wrongType", Edit::Put(json!("true")), false),
            Some("number") => self.plant(path, "wrongType", Edit::Put(json!("1")), false),
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
            self.plant(path, "eachValue", Edit::Put(value.clone()), true);
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
            self.plant(&at, "leftOut", Edit::Drop, !required.contains(key.as_str()));
            if !held.is_null() {
                self.plant(&at, "null", Edit::Put(Value::Null), self.nullable(field));
            }
            self.walk(field, held, &at);
        }
        let mut unknown = path.clone();
        unknown.push("zzUnplanted".to_owned());
        self.plant(&unknown, "unknownField", Edit::Put(json!(1)), true);
        for check in checks {
            match object_cases(check) {
                Some(cases) => {
                    for (fields, accept) in cases {
                        self.plant(path, check, Edit::Fields(fields), accept);
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

    fn string(&mut self, node: Node<'a>, path: &Path, checks: &[String]) {
        self.plant(path, "wrongType", Edit::Put(json!(1)), false);
        let patterned = Self::keyword(node, "pattern").is_some();
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
                if checks.is_empty() && max >= 2 {
                    let astral = |n: u64| "\u{1f600}".repeat(usize::try_from(n).unwrap_or(0));
                    let at_max = astral(max / 2) + &units(max % 2);
                    self.plant(path, "astralAtMaxLength", Edit::Put(json!(at_max)), true);
                    let past = astral(max / 2 + 1);
                    self.plant(path, "astralPastMaxLength", Edit::Put(json!(past)), false);
                }
            }
            if trims && min > 0 {
                self.plant(path, "blank", Edit::Put(json!("   ")), false);
                let padded = format!("  {}  ", units(min.max(1)));
                self.plant(path, "padded", Edit::Put(json!(padded)), true);
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
                    for (json, accept) in cases {
                        self.plant(path, check, Edit::Raw(json), accept);
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
}

/// `example` with `plant` made in it, as JSON text.
fn planted(example: &Value, plant: &Plant) -> Option<String> {
    const MARK: &str = "\u{0}planted\u{0}";
    let mut body = example.clone();
    let (last, parents) = match plant.path.split_last() {
        Some((last, parents)) => (Some(last), parents),
        None => (None, &[][..]),
    };
    let mut at = &mut body;
    for segment in parents {
        at = match at {
            Value::Object(object) => object.get_mut(segment)?,
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
        Edit::Fields(fields) => {
            let target = match (at, last) {
                (at, None) => at,
                (Value::Object(object), Some(key)) => object.get_mut(key)?,
                _ => return None,
            };
            let object = target.as_object_mut()?;
            for (key, value) in fields {
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
    if verdicts.len() != cases.len() {
        found.push(format!(
            "{} verdicts for {} cases",
            verdicts.len(),
            cases.len()
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
            ("/zzUnplanted", "unknownField", true),
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
        assert_eq!(
            mismatched(&cases[..1], &[], &[]),
            vec!["0 verdicts for 1 cases".to_owned()]
        );
    }
}
