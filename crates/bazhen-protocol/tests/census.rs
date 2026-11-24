//! The Rust schema against the protocol's own: each message the Rust schema emits and
//! `packages/protocol/schema` holds is walked field by field, and its fields, every keyword that
//! limits a value, its type, whether a field may be left out and whether it may be null must
//! agree, either way. A refinement zod makes past a keyword isn't in that JSON Schema;
//! `fixtures.rs` holds those.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use bazhen_protocol::events::event_kind;
use serde_json::{Map, Value};

/// The keywords that type or limit a value, compared at every field. An enum is compared in
/// order, which zod's `.options` keeps.
const LIMITS: [&str; 11] = [
    "type",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "enum",
];

/// The keywords the Rust schema states and the protocol's JSON Schema can't, each where it is and
/// why: the protocol states the same rule in a way its JSON Schema leaves out.
const KEPT: [(&str, &str, &str); 2] = [
    (
        "HolderEnv.propertyNames",
        "pattern",
        "the protocol refuses a reserved name in a preprocess",
    ),
    (
        "HolderTags.propertyNames",
        "pattern",
        "the protocol refuses a reserved name in a preprocess",
    ),
];

/// The differences the Rust schema keeps today, each with what owns its fix. The list only
/// shrinks: an entry the census no longer finds fails.
const KNOWN: &[(&str, &str)] = &[];

/// Each entry of `KNOWN`, and of `KNOWN_PAYLOADS` under each name the census finds it by.
fn known() -> Vec<(String, &'static str)> {
    let mut known: Vec<(String, &str)> = KNOWN
        .iter()
        .map(|(at, owner)| ((*at).to_owned(), *owner))
        .collect();
    for (kind, difference, owner) in KNOWN_PAYLOADS {
        let field = difference.split([':', '.']).next().unwrap_or(difference);
        if event_kind(kind).is_some_and(|kind| kind.streamed.contains(&field)) {
            known.push((format!("Event(type={kind}).payload.{difference}"), owner));
        }
        known.push((
            format!("RecordedEvent(type={kind}).payload.{difference}"),
            owner,
        ));
    }
    known
}

/// The differences in an event type's payload the Rust schema keeps today, each as its type, the
/// field and how it differs, and what owns its fix: found in the payload as the store records it,
/// and in the event as well where the type streams the field. It only shrinks, as `KNOWN` does.
const KNOWN_PAYLOADS: &[(&str, &str, &str)] = &[];

/// A document's definitions, to follow its `$ref`s by.
struct Side<'a> {
    definitions: &'a Map<String, Value>,
}

impl Side<'_> {
    /// `schema` past every `$ref`, with the name of the last definition it reached.
    fn resolved<'s>(
        &'s self,
        mut schema: &'s Value,
        mut name: Option<&'s str>,
    ) -> (&'s Value, Option<&'s str>) {
        while let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
            let Some(target) = reference.rsplit('/').next() else {
                break;
            };
            match self.definitions.get(target) {
                Some(named) => {
                    schema = named;
                    name = Some(target);
                }
                None => break,
            }
        }
        (schema, name)
    }

    /// The name each of a union's `branches` goes by, after the union's: `(key=value)`, by the
    /// property each pins to a constant of its own, as the fixtures name a branch. Without it, the
    /// fields of every branch would go by one name.
    fn branch_names(&self, branches: &[Value]) -> Option<Vec<String>> {
        let resolved: Vec<&Value> = branches.iter().map(|b| self.resolved(b, None).0).collect();
        let pinned = |branch: &Value, key: &str| -> Option<Value> {
            branch.get("properties")?.get(key)?.get("const").cloned()
        };
        let key = resolved
            .first()?
            .get("properties")?
            .as_object()?
            .keys()
            .find(|key| {
                let constants: Option<Vec<Value>> =
                    resolved.iter().map(|b| pinned(b, key)).collect();
                constants.is_some_and(|c| {
                    c.iter()
                        .enumerate()
                        .all(|(at, v)| !c.iter().take(at).any(|w| w == v))
                })
            })?;
        resolved
            .iter()
            .map(|branch| {
                let constant = pinned(branch, key)?;
                let shown = constant
                    .as_str()
                    .map_or_else(|| constant.to_string(), str::to_owned);
                Some(format!("({key}={shown})"))
            })
            .collect()
    }

    fn is_null(&self, schema: &Value) -> bool {
        let (schema, _) = self.resolved(schema, None);
        schema.get("type").and_then(Value::as_str) == Some("null")
            || schema.get("const") == Some(&Value::Null)
    }

    /// What a field's schema says once null is taken out of it, past `$ref`s and unions of one
    /// branch: a union of constants reads as an enum, and an integer's exclusive bound as the
    /// inclusive one it comes to. A union of more than one other branch is left as it is. What
    /// says nothing is dropped: a `minLength` of 0, keys typed only as strings, which every key
    /// is, and the `type` beside an enum, whose values give it.
    fn core<'s>(
        &'s self,
        schema: &'s Value,
        name: Option<&'s str>,
    ) -> (Value, bool, Option<&'s str>) {
        let (schema, name) = self.resolved(schema, name);
        let Some(object) = schema.as_object() else {
            return (schema.clone(), false, name);
        };
        for key in ["anyOf", "oneOf"] {
            if let Some(Value::Array(branches)) = object.get(key) {
                let nullable = branches.iter().any(|b| self.is_null(b));
                let others: Vec<&Value> = branches.iter().filter(|b| !self.is_null(b)).collect();
                let constants: Option<Vec<Value>> = others
                    .iter()
                    .map(|b| {
                        let (b, _) = self.resolved(b, None);
                        match (b.get("const"), b.get("enum")) {
                            (Some(c), _) if b.get("properties").is_none() => Some(vec![c.clone()]),
                            (None, Some(Value::Array(values))) => Some(values.clone()),
                            _ => None,
                        }
                    })
                    .collect::<Option<Vec<_>>>()
                    .map(|lists| lists.into_iter().flatten().collect());
                if let Some(values) = constants {
                    return (
                        serde_json::json!({ "enum": enumerated(values) }),
                        nullable,
                        name,
                    );
                }
                if let [only] = others.as_slice() {
                    let (core, inner, name) = self.core(only, name);
                    return (core, nullable || inner, name);
                }
                return (schema.clone(), nullable, name);
            }
        }
        let mut core = object.clone();
        let mut nullable = false;
        if let Some(Value::Array(types)) = core.get("type").cloned() {
            nullable = types.iter().any(|t| t == "null");
            let types: Vec<Value> = types.into_iter().filter(|t| t != "null").collect();
            core.insert(
                "type".to_owned(),
                match types.as_slice() {
                    [only] => only.clone(),
                    _ => Value::Array(types),
                },
            );
        }
        if let Some(constant) = core.remove("const") {
            nullable |= constant.is_null();
            core.insert("enum".to_owned(), Value::Array(vec![constant]));
        }
        if let Some(Value::Array(values)) = core.remove("enum") {
            nullable |= values.iter().any(Value::is_null);
            core.insert("enum".to_owned(), enumerated(values));
        }
        if core.get("type").and_then(Value::as_str) == Some("integer") {
            for (exclusive, inclusive, step) in [
                ("exclusiveMinimum", "minimum", 1),
                ("exclusiveMaximum", "maximum", -1),
            ] {
                if let Some(bound) = core.remove(exclusive).and_then(|b| b.as_i64()) {
                    core.insert(inclusive.to_owned(), Value::from(bound + step));
                }
            }
        }
        if core.get("minLength").and_then(Value::as_u64) == Some(0) {
            core.remove("minLength");
        }
        if core.get("propertyNames") == Some(&serde_json::json!({ "type": "string" })) {
            core.remove("propertyNames");
        }
        if core.contains_key("enum") {
            core.remove("type");
        }
        (Value::Object(core), nullable, name)
    }
}

/// `values` without null, each once, in the order they first come.
fn enumerated(values: Vec<Value>) -> Value {
    let mut kept: Vec<Value> = Vec::new();
    for value in values {
        if !value.is_null() && !kept.contains(&value) {
            kept.push(value);
        }
    }
    Value::Array(kept)
}

fn required(schema: &Value) -> BTreeSet<&str> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// Walks the protocol's schema and the Rust one side by side, noting each difference once, by
/// the Rust definition that holds the field.
struct Census<'a> {
    protocol: Side<'a>,
    rust: Side<'a>,
    found: BTreeSet<String>,
}

impl Census<'_> {
    fn compare(&mut self, protocol: &Value, rust: &Value, owner: &str) {
        let (protocol, _, _) = self.protocol.core(protocol, None);
        let (rust, _, name) = self.rust.core(rust, Some(owner));
        let owner = name.unwrap_or(owner).to_owned();
        let union = |s: &Value| {
            s.get("anyOf")
                .or_else(|| s.get("oneOf"))
                .and_then(Value::as_array)
                .cloned()
        };
        match (union(&protocol), union(&rust)) {
            (Some(p), Some(r)) if p.len() == r.len() => {
                let names = self.rust.branch_names(&r);
                for (at, (p, r)) in p.iter().zip(&r).enumerate() {
                    let name = names.as_ref().and_then(|n| n.get(at));
                    let owner = name.map_or_else(|| owner.clone(), |name| format!("{owner}{name}"));
                    self.compare(p, r, &owner);
                }
                return;
            }
            (Some(p), Some(r)) => {
                self.found.insert(format!(
                    "{owner}: a union of {} branches in the protocol, {} here",
                    p.len(),
                    r.len()
                ));
                return;
            }
            (Some(_), None) | (None, Some(_)) => {
                self.found.insert(format!(
                    "{owner}: a union on one side only: {} in the protocol, {} here",
                    shown(Some(&protocol)),
                    shown(Some(&rust))
                ));
                return;
            }
            (None, None) => {}
        }
        for key in LIMITS {
            let kept = KEPT
                .iter()
                .any(|(at, kept, _)| *at == owner && *kept == key && protocol.get(key).is_none());
            if protocol.get(key) != rust.get(key) && !kept {
                self.found.insert(format!(
                    "{owner}: {key} is {} in the protocol, {} here",
                    shown(protocol.get(key)),
                    shown(rust.get(key)),
                ));
            }
        }
        let empty = Map::new();
        let properties = |s: &Value| {
            s.get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(|| empty.clone())
        };
        let (p_fields, r_fields) = (properties(&protocol), properties(&rust));
        let (p_required, r_required) = (required(&protocol), required(&rust));
        for key in r_fields.keys().filter(|k| !p_fields.contains_key(*k)) {
            self.found.insert(format!(
                "{owner}.{key}: a field here the protocol doesn't have"
            ));
        }
        for (key, p) in &p_fields {
            let Some(r) = r_fields.get(key) else {
                self.found
                    .insert(format!("{owner}.{key}: a field of the protocol's not here"));
                continue;
            };
            let (_, p_null, _) = self.protocol.core(p, None);
            let (_, r_null, _) = self.rust.core(r, None);
            let p_says = (p_required.contains(key.as_str()), p_null);
            let r_says = (r_required.contains(key.as_str()), r_null);
            if p_says != r_says {
                self.found.insert(format!(
                    "{owner}.{key}: (required, nullable) is {p_says:?} in the protocol, {r_says:?} here"
                ));
            }
            self.compare(p, r, &format!("{owner}.{key}"));
        }
        for key in ["items", "additionalProperties"] {
            if let (Some(p), Some(r)) = (protocol.get(key), rust.get(key))
                && p.is_object()
                && r.is_object()
            {
                self.compare(p, r, &format!("{owner}.{key}"));
            }
        }
        if protocol
            .get("additionalProperties")
            .is_some_and(Value::is_object)
        {
            let any_key = serde_json::json!({ "type": "string" });
            self.compare(
                protocol.get("propertyNames").unwrap_or(&any_key),
                rust.get("propertyNames").unwrap_or(&any_key),
                &format!("{owner}.propertyNames"),
            );
        }
    }
}

fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "absent".to_owned(), Value::to_string)
}

#[test]
fn each_field_the_schema_emits_has_the_limits_the_protocol_gives_it() {
    let mut generator = bazhen_protocol::schema::generator();
    bazhen_protocol::schema::add_messages(&mut generator);
    bazhen_holder_proto::schema::add_bodies(&mut generator);
    let rust = generator.take_definitions(true);
    let directory =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/schema");
    let mut found = BTreeSet::new();
    let mut compared = 0;
    for name in rust.keys() {
        let Ok(text) = fs::read_to_string(directory.join(format!("{name}.json"))) else {
            continue;
        };
        let protocol: Value = serde_json::from_str(&text).unwrap();
        let empty = Map::new();
        let definitions = protocol
            .get("$defs")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let mut census = Census {
            protocol: Side { definitions },
            rust: Side { definitions: &rust },
            found: BTreeSet::new(),
        };
        census.compare(
            &protocol,
            &serde_json::json!({ "$ref": format!("#/$defs/{name}") }),
            name,
        );
        found.append(&mut census.found);
        compared += 1;
    }
    assert!(compared > 100, "only {compared} messages compared");
    for (known, owner) in known() {
        if !found.remove(&known) {
            found.insert(format!(
                "KNOWN lists `{known}`, owned by {owner}, which the census no longer finds"
            ));
        }
    }
    assert!(
        found.is_empty(),
        "{} differences:\n{}",
        found.len(),
        found.into_iter().collect::<Vec<_>>().join("\n")
    );
}
