//! The protocol as it is published in `packages/protocol/schema/`: one JSON Schema a message, with
//! every type it names written in place; the event types' payloads in `events.json`; and what no
//! schema says in `semantics.json`. Their hash is the protocol id, which a client compares with
//! the daemon's to know it may read its messages.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// The draft every published schema names.
const DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

/// Keywords whose value is one schema.
const ONE_SCHEMA: &[&str] = &[
    "items",
    "additionalProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
];

/// Keywords whose value is a list of schemas.
const SCHEMA_LIST: &[&str] = &["anyOf", "oneOf", "allOf", "prefixItems"];

/// Keywords whose value maps a name to a schema.
const SCHEMA_MAP: &[&str] = &["properties", "patternProperties", "dependentSchemas"];

/// Keywords no peer reads, so that rewording one leaves the id as it was.
const PROSE: &[&str] = &["title", "description", "$comment"];

/// The files of `packages/protocol/schema/` that `document`, as `emit_schema` prints it, makes,
/// by name: each of its `$defs`, `events.json` from its `x-bazhen-events`, and `semantics.json`
/// from its `x-bazhen-semantics`.
pub(crate) fn published(document: &Value) -> Result<BTreeMap<String, String>, Vec<String>> {
    let Some(defs) = document.get("$defs").and_then(Value::as_object) else {
        return Err(vec!["the schema has no `$defs`".to_owned()]);
    };
    let mut problems = Vec::new();
    let mut files = BTreeMap::new();
    for (name, def) in defs {
        match written_in_place(def, defs, &mut vec![name.as_str()]) {
            Ok(Value::Object(schema)) => {
                let mut file = Map::new();
                file.insert("$id".to_owned(), Value::from(name.as_str()));
                file.insert("$schema".to_owned(), Value::from(DRAFT));
                file.extend(schema);
                files.insert(format!("{name}.json"), text(&Value::Object(file)));
            }
            Ok(_) => problems.push(format!("$defs/{name}: isn't an object")),
            Err(problem) => problems.push(format!("$defs/{name}{problem}")),
        }
    }
    match document.get("x-bazhen-events").map(|e| events(e, defs)) {
        Some(Ok(events)) => drop(files.insert("events.json".to_owned(), text(&events))),
        Some(Err(problem)) => problems.push(format!("x-bazhen-events{problem}")),
        None => problems.push("the schema has no `x-bazhen-events`".to_owned()),
    }
    match document.get("x-bazhen-semantics") {
        Some(semantics) => drop(files.insert("semantics.json".to_owned(), text(semantics))),
        None => problems.push("the schema has no `x-bazhen-semantics`".to_owned()),
    }
    if problems.is_empty() {
        Ok(files)
    } else {
        Err(problems)
    }
}

/// The protocol id of `files`: the SHA-256, in hex, of each `name\0content\0` in name order.
pub(crate) fn protocol_id(files: &BTreeMap<String, String>) -> String {
    let mut hash = Sha256::new();
    for (name, content) in files {
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(content.as_bytes());
        hash.update([0]);
    }
    let digit = |n: u8| char::from_digit(u32::from(n), 16).unwrap_or('0');
    hash.finalize()
        .iter()
        .flat_map(|&b| [digit(b >> 4), digit(b & 0x0f)])
        .collect()
}

/// The Rust source that names `id` as the protocol the Rust crates speak.
pub(crate) fn rust_id(id: &str) -> String {
    format!(
        "//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its\n\
         //! `--check`: don't edit it by hand.\n\
         \n\
         /// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\\0content\\0` in\n\
         /// name order. A daemon that answers with another is another build, to restart.\n\
         pub const PROTOCOL_ID: &str = \"{id}\";\n"
    )
}

/// The TypeScript module that names `id` as the protocol a TypeScript build speaks.
pub(crate) fn typescript_id(id: &str) -> String {
    format!(
        "// The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its\n\
         // `--check`: don't edit it by hand.\n\
         \n\
         /**\n \
         * The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\\0content\\0` in\n \
         * name order.\n \
         */\n\
         export const PROTOCOL_ID = \"{id}\";\n"
    )
}

/// A file's text: its JSON, two spaces an indent, and a newline after.
fn text(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// Each event type's entry with its payload written in place.
fn events(events: &Value, defs: &Map<String, Value>) -> Result<Value, String> {
    let Some(events) = events.as_object() else {
        return Err(": isn't an object".to_owned());
    };
    let mut written = Map::new();
    for (name, entry) in events {
        let mut entry = entry.clone();
        let Some(payload) = entry.get_mut("payload") else {
            return Err(format!("/{name}: has no payload"));
        };
        *payload = written_in_place(payload, defs, &mut Vec::new())
            .map_err(|problem| format!("/{name}/payload{problem}"))?;
        written.insert(name.clone(), entry);
    }
    Ok(Value::Object(written))
}

/// `schema` with each `$ref` replaced by the def it names, and with no prose. `within` holds the
/// defs being written, so that one that names itself is a problem rather than a loop. A problem
/// is the path under `schema` it is at, with what is wrong.
fn written_in_place<'a>(
    schema: &Value,
    defs: &'a Map<String, Value>,
    within: &mut Vec<&'a str>,
) -> Result<Value, String> {
    let Some(object) = schema.as_object() else {
        return Ok(schema.clone());
    };
    let mut written = Map::new();
    for (keyword, value) in object {
        let at = |problem: String| format!("/{keyword}{problem}");
        let value = if PROSE.contains(&keyword.as_str()) || keyword == "$ref" {
            continue;
        } else if ONE_SCHEMA.contains(&keyword.as_str()) {
            written_in_place(value, defs, within).map_err(at)?
        } else if SCHEMA_LIST.contains(&keyword.as_str()) {
            let Some(list) = value.as_array() else {
                return Err(at(": isn't a list".to_owned()));
            };
            let mut each = Vec::new();
            for (i, item) in list.iter().enumerate() {
                each.push(
                    written_in_place(item, defs, within).map_err(|p| at(format!("/{i}{p}")))?,
                );
            }
            Value::Array(each)
        } else if SCHEMA_MAP.contains(&keyword.as_str()) {
            let Some(map) = value.as_object() else {
                return Err(at(": isn't an object".to_owned()));
            };
            let mut each = Map::new();
            for (name, item) in map {
                let item =
                    written_in_place(item, defs, within).map_err(|p| at(format!("/{name}{p}")))?;
                each.insert(name.clone(), item);
            }
            Value::Object(each)
        } else {
            value.clone()
        };
        written.insert(keyword.clone(), value);
    }
    let Some(reference) = object.get("$ref") else {
        return Ok(Value::Object(written));
    };
    let Some(name) = reference.as_str().and_then(|r| r.strip_prefix("#/$defs/")) else {
        return Err(format!("/$ref: {reference} isn't a def of this schema"));
    };
    if within.contains(&name) {
        return Err(format!(
            "/$ref: {name} names itself, so can't be written in place"
        ));
    }
    let Some((name, def)) = defs.get_key_value(name) else {
        return Err(format!("/$ref: no def is named {name}"));
    };
    within.push(name);
    let target = written_in_place(def, defs, within).map_err(|p| format!("/$ref({name}){p}"));
    within.pop();
    let target = target?;
    if written.is_empty() {
        return Ok(target);
    }
    let Value::Object(mut target) = target else {
        return Err(format!(
            "/$ref: {name} isn't an object, so takes no keywords beside it"
        ));
    };
    for (keyword, value) in written {
        if target.get(&keyword).is_some_and(|theirs| *theirs != value) {
            return Err(format!("/{keyword}: differs from {name}'s own"));
        }
        target.insert(keyword, value);
    }
    Ok(Value::Object(target))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn document(defs: &Value) -> Value {
        json!({
            "$defs": defs,
            "x-bazhen-events": {},
            "x-bazhen-semantics": { "revision": 1 },
        })
    }

    fn file(files: &BTreeMap<String, String>, name: &str) -> Value {
        serde_json::from_str(&files[name]).unwrap()
    }

    #[test]
    fn writes_each_def_with_the_defs_it_names_in_place_and_no_prose() {
        let defs = json!({
            "Name": { "type": "string", "description": "A name.", "maxLength": 9 },
            "Ref": {
                "title": "Ref",
                "type": "object",
                "properties": {
                    "description": { "$ref": "#/$defs/Name", "default": "x" },
                    "many": { "type": "array", "items": { "$ref": "#/$defs/Name" } },
                    "either": { "anyOf": [{ "$ref": "#/$defs/Name" }, { "type": "null" }] },
                },
                "required": ["description"],
            },
        });
        let files = published(&document(&defs)).unwrap();
        let name = json!({ "type": "string", "maxLength": 9 });
        assert_eq!(
            file(&files, "Ref.json"),
            json!({
                "$id": "Ref",
                "$schema": DRAFT,
                "type": "object",
                "properties": {
                    "description": { "type": "string", "maxLength": 9, "default": "x" },
                    "many": { "type": "array", "items": name },
                    "either": { "anyOf": [name, { "type": "null" }] },
                },
                "required": ["description"],
            })
        );
        assert_eq!(
            files.keys().collect::<Vec<_>>(),
            ["Name.json", "Ref.json", "events.json", "semantics.json"]
        );
        assert_eq!(files["semantics.json"], "{\n  \"revision\": 1\n}\n");
    }

    #[test]
    fn writes_each_event_payload_in_place_and_keeps_the_rest_of_its_entry() {
        let mut doc = document(&json!({ "Id": { "type": "string", "description": "An id." } }));
        doc["x-bazhen-events"] = json!({
            "a.made": { "entity": "a", "streamed": true, "payload": {
                "type": "object", "properties": { "id": { "$ref": "#/$defs/Id" } },
            } },
        });
        let files = published(&doc).unwrap();
        assert_eq!(
            file(&files, "events.json"),
            json!({ "a.made": { "entity": "a", "streamed": true, "payload": {
                "type": "object", "properties": { "id": { "type": "string" } },
            } } })
        );
    }

    #[test]
    fn refuses_a_def_that_names_itself_or_one_that_is_missing_or_a_ref_that_contradicts_it() {
        let cases = [
            (
                json!({ "A": { "items": { "$ref": "#/$defs/A" } } }),
                "$defs/A/items/$ref: A names itself",
            ),
            (
                json!({ "A": { "$ref": "#/$defs/B" } }),
                "$defs/A/$ref: no def is named B",
            ),
            (
                json!({ "A": { "$ref": "other.json" } }),
                "$defs/A/$ref: \"other.json\" isn't a def",
            ),
            (
                json!({ "A": { "type": "string" }, "B": { "$ref": "#/$defs/A", "type": "integer" } }),
                "$defs/B/type: differs from A's own",
            ),
        ];
        for (defs, problem) in cases {
            let problems = published(&document(&defs)).unwrap_err();
            assert!(
                problems.iter().any(|p| p.starts_with(problem)),
                "{problems:?}"
            );
        }
        let problems = published(&json!({ "$defs": {} })).unwrap_err();
        assert_eq!(
            problems,
            [
                "the schema has no `x-bazhen-events`",
                "the schema has no `x-bazhen-semantics`"
            ]
        );
    }

    #[test]
    fn hashes_each_name_and_content_in_name_order() {
        let files = BTreeMap::from([
            ("B.json".to_owned(), "[]".to_owned()),
            ("A.json".to_owned(), "{}".to_owned()),
        ]);
        // printf 'A.json\0{}\0B.json\0[]\0' | sha256sum, as filesHash's own test pins it.
        assert_eq!(
            protocol_id(&files),
            "d369cd33e49c31c1d6c74cf3f2a4646c21f39d4aae5029bccf4c1bb3133166f1"
        );
        let shifted = BTreeMap::from([("A.jsonB.json".to_owned(), String::new())]);
        let named = BTreeMap::from([("A.json".to_owned(), "B.json".to_owned())]);
        assert_ne!(protocol_id(&shifted), protocol_id(&named));
    }

    #[test]
    fn writes_the_id_as_rust_and_as_typescript() {
        let id = "ab".repeat(32);
        assert!(rust_id(&id).ends_with(&format!("pub const PROTOCOL_ID: &str = \"{id}\";\n")));
        assert!(typescript_id(&id).ends_with(&format!("export const PROTOCOL_ID = \"{id}\";\n")));
    }
}
