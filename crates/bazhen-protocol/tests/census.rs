//! The Rust schema against the protocol's own: each message the Rust schema emits and
//! `packages/protocol/schema` holds is walked field by field, and every keyword that limits a
//! value, whether a field may be left out and whether it may be null, must agree. A refinement
//! zod makes past a keyword isn't in that JSON Schema; `fixtures.rs` holds those.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

/// The keywords that limit a value, compared at every field.
const LIMITS: [&str; 10] = [
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

    fn is_null(&self, schema: &Value) -> bool {
        let (schema, _) = self.resolved(schema, None);
        schema.get("type").and_then(Value::as_str) == Some("null")
            || schema.get("const") == Some(&Value::Null)
    }

    /// What a field's schema says once null is taken out of it, past `$ref`s and unions of one
    /// branch: a union of constants reads as an enum, and an integer's exclusive bound as the
    /// inclusive one it comes to. A union of more than one other branch is left as it is.
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
        (Value::Object(core), nullable, name)
    }
}

/// `values` without null, in a fixed order.
fn enumerated(values: Vec<Value>) -> Value {
    let mut values: Vec<Value> = values.into_iter().filter(|v| !v.is_null()).collect();
    values.sort_by_key(Value::to_string);
    values.dedup();
    Value::Array(values)
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
        if let (Some(p), Some(r)) = (union(&protocol), union(&rust)) {
            if p.len() == r.len() {
                for (p, r) in p.iter().zip(&r) {
                    self.compare(p, r, &owner);
                }
            }
            return;
        }
        for key in LIMITS {
            if protocol.get(key) != rust.get(key) {
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
        for (key, p) in &p_fields {
            let Some(r) = r_fields.get(key) else {
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
    assert!(
        found.is_empty(),
        "{} differences:\n{}",
        found.len(),
        found.into_iter().collect::<Vec<_>>().join("\n")
    );
}
