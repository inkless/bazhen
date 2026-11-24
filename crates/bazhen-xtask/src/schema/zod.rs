//! zod 4 source written from the protocol's JSON Schema. Only the keywords the protocol uses are
//! read, each as zod spells it; any other keyword, or one where zod has no spelling for it, is
//! refused with where it was, so nothing the schema says is dropped on the way.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde_json::{Map, Value};

/// The keywords a schema here may hold. Any other is refused.
const KEYWORDS: [&str; 24] = [
    "$ref",
    "additionalProperties",
    "anyOf",
    "const",
    "default",
    "description",
    "enum",
    "format",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
    "oneOf",
    "pattern",
    "properties",
    "propertyNames",
    "required",
    "title",
    "type",
    CHECK,
    TRANSFORM,
];

/// A rule no keyword states, named: the schema holds `checks.<name>` to it.
pub(crate) const CHECK: &str = "x-bazhen-check";

/// A change zod makes to a value before its checks, named: on a string, one of `TRANSFORMS`; on a
/// record, a preprocess `checks.ts` exports, which sees the keys zod's record would skip.
pub(crate) const TRANSFORM: &str = "x-bazhen-transform";

/// The transforms a schema may name, and how zod spells each.
const TRANSFORMS: [(&str, &str); 1] = [("trim", ".trim()")];

/// The formats a schema may give a number: each says only the range `minimum` and `maximum`
/// state, which zod is given.
const NUMBER_FORMATS: [&str; 9] = [
    "double", "float", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32",
];

/// `uint64`, whose `minimum` schemars states, and whose top zod's safe integers can't reach.
const UINT64: &str = "uint64";

/// What the source names beyond zod: the checks it calls, for the caller to hold to `checks.ts`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) text: String,
    pub(crate) checks: BTreeSet<String>,
}

/// zod source for every schema in `document`'s `$defs`, each exported with its inferred type, in
/// an order that defines each before its first use. `checks` is the module the source imports the
/// named checks from. Every problem found, each with the path to it, when there is any.
pub(crate) fn generate(document: &Value, checks: &str) -> Result<Source, Vec<String>> {
    let Some(defs) = document.get("$defs").and_then(Value::as_object) else {
        return Err(vec!["the document has no `$defs` object".to_owned()]);
    };
    let mut writer = Writer::default();
    let mut bodies = BTreeMap::new();
    for (name, schema) in defs {
        let at = format!("$defs/{name}");
        if !is_identifier(name) {
            writer.refuse(&at, "is no TypeScript name");
            continue;
        }
        let mut uses = BTreeSet::new();
        let body = writer.schema(schema, &at, &mut uses);
        for used in &uses {
            if !defs.contains_key(used) {
                writer.refuse(&at, &format!("names `{used}`, which `$defs` doesn't hold"));
            }
        }
        bodies.insert(name.clone(), (body, uses));
    }
    let order = match ordered(&bodies) {
        Ok(order) => order,
        Err(cycle) => {
            writer.refuse(
                &format!("$defs/{cycle}"),
                "names itself through its fields, which zod could only follow lazily",
            );
            Vec::new()
        }
    };
    if !writer.problems.is_empty() {
        return Err(writer.problems);
    }
    let mut text = String::from(
        "// Written by `cargo xtask schema` from the Rust protocol crates. Don't edit it: change \
         the Rust types.\n\nimport { z } from \"zod\";\n",
    );
    if !writer.checks.is_empty() {
        let _ = writeln!(text, "import * as checks from {};", quoted(checks));
    }
    for name in order {
        if let Some((body, _)) = bodies.get(name) {
            let _ = write!(
                text,
                "\nexport const {name} = {body};\nexport type {name} = z.infer<typeof {name}>;\n"
            );
        }
    }
    Ok(Source {
        text,
        checks: writer.checks,
    })
}

/// The definitions, each after every one it names; or one on a cycle, which has no such order.
fn ordered(bodies: &BTreeMap<String, (String, BTreeSet<String>)>) -> Result<Vec<&str>, String> {
    let mut done: Vec<&str> = Vec::new();
    let mut placed = BTreeSet::new();
    while done.len() < bodies.len() {
        let ready: Vec<&str> = bodies
            .iter()
            .filter(|(name, _)| !placed.contains(name.as_str()))
            .filter(|(_, (_, uses))| {
                uses.iter()
                    .all(|u| placed.contains(u.as_str()) || !bodies.contains_key(u))
            })
            .map(|(name, _)| name.as_str())
            .collect();
        if ready.is_empty() {
            let stuck = bodies.keys().find(|n| !placed.contains(n.as_str()));
            return Err(stuck.cloned().unwrap_or_default());
        }
        for name in ready {
            placed.insert(name);
            done.push(name);
        }
    }
    Ok(done)
}

#[derive(Default)]
struct Writer {
    problems: Vec<String>,
    checks: BTreeSet<String>,
}

impl Writer {
    fn refuse(&mut self, at: &str, why: &str) {
        self.problems.push(format!("{at}: {why}"));
    }

    /// The zod expression for `schema`, at `at`, adding each definition it names to `uses`.
    fn schema(&mut self, schema: &Value, at: &str, uses: &mut BTreeSet<String>) -> String {
        match schema {
            Value::Bool(true) => "z.unknown()".to_owned(),
            Value::Object(object) => self.object_schema(object, at, uses),
            _ => {
                self.refuse(
                    at,
                    "is a schema zod can't spell: only `true` or an object is read",
                );
                String::new()
            }
        }
    }

    fn object_schema(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        uses: &mut BTreeSet<String>,
    ) -> String {
        for key in schema.keys() {
            if !KEYWORDS.contains(&key.as_str()) {
                self.refuse(
                    &format!("{at}/{key}"),
                    "is a keyword the generator doesn't read",
                );
            }
        }
        let mut base = self.base(schema, at, uses);
        if let Some(check) = schema.get(CHECK) {
            match check.as_str().filter(|c| is_identifier(c)) {
                Some(name) => {
                    self.checks.insert(name.to_owned());
                    let _ = write!(base, ".refine(checks.{name})");
                }
                None => self.refuse(&format!("{at}/{CHECK}"), "names no check"),
            }
        }
        base
    }

    /// The expression for `schema` before its named check.
    fn base(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        uses: &mut BTreeSet<String>,
    ) -> String {
        if let Some(target) = schema.get("$ref") {
            self.only(schema, at, &["$ref", "description", "title", "default"]);
            let name = target
                .as_str()
                .and_then(|t| t.strip_prefix("#/$defs/"))
                .filter(|n| is_identifier(n));
            let Some(name) = name else {
                self.refuse(&format!("{at}/$ref"), "names no definition under `$defs`");
                return String::new();
            };
            uses.insert(name.to_owned());
            return name.to_owned();
        }
        if let Some(value) = schema.get("const") {
            self.only(schema, at, &["const", "type", "description", "title"]);
            return format!("z.literal({})", literal(value));
        }
        if let Some(values) = schema.get("enum") {
            self.only(schema, at, &["enum", "type", "description", "title"]);
            let names: Option<Vec<&str>> = values
                .as_array()
                .filter(|v| !v.is_empty())
                .and_then(|v| v.iter().map(Value::as_str).collect());
            let Some(names) = names else {
                self.refuse(&format!("{at}/enum"), "isn't a list of strings");
                return String::new();
            };
            let names: Vec<String> = names.into_iter().map(quoted).collect();
            return format!("z.enum([{}])", names.join(", "));
        }
        for key in ["anyOf", "oneOf"] {
            if let Some(branches) = schema.get(key) {
                self.only(schema, at, &[key, "description", "title", "default"]);
                return self.union(branches, &format!("{at}/{key}"), uses);
            }
        }
        self.typed(schema, at, uses)
    }

    /// Refuses each keyword of `schema` not in `allowed`: one zod has no place for beside the
    /// keyword that decided the expression.
    fn only(&mut self, schema: &Map<String, Value>, at: &str, allowed: &[&str]) {
        for key in schema.keys() {
            if KEYWORDS.contains(&key.as_str()) && !allowed.contains(&key.as_str()) && key != CHECK
            {
                self.refuse(
                    &format!("{at}/{key}"),
                    "has no place in zod beside the others here",
                );
            }
        }
    }

    fn union(&mut self, branches: &Value, at: &str, uses: &mut BTreeSet<String>) -> String {
        let Some(branches) = branches.as_array().filter(|b| !b.is_empty()) else {
            self.refuse(at, "isn't a list of schemas");
            return String::new();
        };
        let null = |b: &Value| {
            b.as_object()
                .is_some_and(|o| o.len() == 1 && o.get("type") == Some(&Value::from("null")))
        };
        if let [only, last] = branches.as_slice()
            && null(last)
            && !null(only)
        {
            return format!("{}.nullable()", self.schema(only, &format!("{at}/0"), uses));
        }
        let written: Vec<String> = branches
            .iter()
            .enumerate()
            .map(|(i, b)| self.schema(b, &format!("{at}/{i}"), uses))
            .collect();
        match discriminator(branches) {
            Some(key) => format!(
                "z.discriminatedUnion({}, [{}])",
                quoted(&key),
                written.join(", ")
            ),
            None => format!("z.union([{}])", written.join(", ")),
        }
    }

    /// A schema decided by its `type`.
    fn typed(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        uses: &mut BTreeSet<String>,
    ) -> String {
        let (name, nullable) = match schema.get("type") {
            Some(Value::String(name)) => (name.as_str(), false),
            Some(Value::Array(names)) => match names.as_slice() {
                [Value::String(name), Value::String(null)] if null == "null" && name != "null" => {
                    (name.as_str(), true)
                }
                _ => {
                    self.refuse(
                        &format!("{at}/type"),
                        "is a list other than [type, \"null\"]",
                    );
                    return String::new();
                }
            },
            _ => {
                self.refuse(
                    at,
                    "has no `type`, `$ref`, `const`, `enum`, `anyOf` or `oneOf`",
                );
                return String::new();
            }
        };
        let common = ["type", "description", "title", "default"];
        let mut written = match name {
            "string" => self.string(schema, at, &common),
            "integer" | "number" => self.number(schema, at, &common, name == "integer"),
            "boolean" => {
                self.only(schema, at, &common);
                "z.boolean()".to_owned()
            }
            "null" => {
                self.only(schema, at, &common);
                "z.null()".to_owned()
            }
            "array" => self.array(schema, at, &common, uses),
            "object" => self.object(schema, at, &common, uses),
            _ => {
                self.refuse(&format!("{at}/type"), "names no JSON type");
                String::new()
            }
        };
        if nullable {
            written.push_str(".nullable()");
        }
        written
    }

    fn string(&mut self, schema: &Map<String, Value>, at: &str, common: &[&str]) -> String {
        let allowed = [common, &["minLength", "maxLength", "pattern", TRANSFORM]].concat();
        self.only(schema, at, &allowed);
        let mut written = "z.string()".to_owned();
        if let Some(transform) = schema.get(TRANSFORM) {
            let spelled = TRANSFORMS
                .iter()
                .find(|(name, _)| transform.as_str() == Some(name));
            match spelled {
                Some((_, zod)) => written.push_str(zod),
                None => self.refuse(&format!("{at}/{TRANSFORM}"), "names no transform"),
            }
        }
        for (key, method) in [("minLength", "min"), ("maxLength", "max")] {
            if let Some(n) = schema.get(key) {
                match n.as_u64() {
                    Some(n) => {
                        let _ = write!(written, ".{method}({n})");
                    }
                    None => self.refuse(&format!("{at}/{key}"), "isn't a count"),
                }
            }
        }
        if let Some(pattern) = schema.get("pattern") {
            match pattern.as_str() {
                Some(pattern) => {
                    let _ = write!(written, ".regex(new RegExp({}))", quoted(pattern));
                }
                None => self.refuse(&format!("{at}/pattern"), "isn't a string"),
            }
        }
        written
    }

    fn number(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        common: &[&str],
        integer: bool,
    ) -> String {
        let allowed = [common, &["minimum", "maximum", "format"]].concat();
        self.only(schema, at, &allowed);
        let mut written = if integer {
            "z.number().int()"
        } else {
            "z.number()"
        }
        .to_owned();
        if let Some(format) = schema.get("format") {
            let known = format
                .as_str()
                .is_some_and(|f| NUMBER_FORMATS.contains(&f) || f == UINT64);
            if !known {
                self.refuse(
                    &format!("{at}/format"),
                    "is a format the generator doesn't read",
                );
            }
        }
        for (key, method) in [("minimum", "min"), ("maximum", "max")] {
            if let Some(n) = schema.get(key) {
                match n {
                    Value::Number(n) => {
                        let _ = write!(written, ".{method}({n})");
                    }
                    _ => self.refuse(&format!("{at}/{key}"), "isn't a number"),
                }
            }
        }
        written
    }

    fn array(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        common: &[&str],
        uses: &mut BTreeSet<String>,
    ) -> String {
        let allowed = [common, &["items", "minItems", "maxItems"]].concat();
        self.only(schema, at, &allowed);
        let Some(items) = schema.get("items") else {
            self.refuse(at, "is an array with no `items`");
            return String::new();
        };
        let mut written = format!(
            "z.array({})",
            self.schema(items, &format!("{at}/items"), uses)
        );
        for (key, method) in [("minItems", "min"), ("maxItems", "max")] {
            if let Some(n) = schema.get(key) {
                match n.as_u64() {
                    Some(n) => {
                        let _ = write!(written, ".{method}({n})");
                    }
                    None => self.refuse(&format!("{at}/{key}"), "isn't a count"),
                }
            }
        }
        written
    }

    fn object(
        &mut self,
        schema: &Map<String, Value>,
        at: &str,
        common: &[&str],
        uses: &mut BTreeSet<String>,
    ) -> String {
        let allowed = [
            common,
            &[
                "properties",
                "required",
                "additionalProperties",
                "propertyNames",
                TRANSFORM,
            ],
        ]
        .concat();
        self.only(schema, at, &allowed);
        let properties = schema.get("properties");
        let extra = schema.get("additionalProperties");
        match (properties, extra) {
            (None, Some(values)) if values.is_object() => {
                self.only(
                    schema,
                    at,
                    &[
                        common,
                        &["additionalProperties", "propertyNames", TRANSFORM],
                    ]
                    .concat(),
                );
                let keys = match schema.get("propertyNames") {
                    Some(keys) => self.schema(keys, &format!("{at}/propertyNames"), uses),
                    None => "z.string()".to_owned(),
                };
                let values = self.schema(values, &format!("{at}/additionalProperties"), uses);
                let record = format!("z.record({keys}, {values})");
                let Some(transform) = schema.get(TRANSFORM) else {
                    return record;
                };
                let Some(name) = transform.as_str().filter(|t| is_identifier(t)) else {
                    self.refuse(&format!("{at}/{TRANSFORM}"), "names no transform");
                    return String::new();
                };
                self.checks.insert(name.to_owned());
                format!("z.preprocess(checks.{name}, {record})")
            }
            (_, Some(_)) => {
                self.refuse(
                    &format!("{at}/additionalProperties"),
                    "is read only as a record's values, on an object with no `properties`",
                );
                String::new()
            }
            (properties, None) => {
                for key in ["propertyNames", TRANSFORM] {
                    if schema.contains_key(key) {
                        self.refuse(&format!("{at}/{key}"), "is read only on a record");
                    }
                }
                self.fields(schema, properties, at, uses)
            }
        }
    }

    fn fields(
        &mut self,
        schema: &Map<String, Value>,
        properties: Option<&Value>,
        at: &str,
        uses: &mut BTreeSet<String>,
    ) -> String {
        let empty = Map::new();
        let Some(properties) = properties.map_or(Some(&empty), Value::as_object) else {
            self.refuse(&format!("{at}/properties"), "isn't an object");
            return String::new();
        };
        let required: Option<BTreeSet<&str>> = match schema.get("required") {
            None => Some(BTreeSet::new()),
            Some(names) => names
                .as_array()
                .and_then(|n| n.iter().map(Value::as_str).collect()),
        };
        let Some(required) = required else {
            self.refuse(&format!("{at}/required"), "isn't a list of names");
            return String::new();
        };
        for name in &required {
            if !properties.contains_key(*name) {
                self.refuse(
                    &format!("{at}/required"),
                    &format!("names `{name}`, no field here"),
                );
            }
        }
        let fields: Vec<String> = properties
            .iter()
            .map(|(name, field)| {
                let field_at = format!("{at}/properties/{name}");
                let mut written = self.schema(field, &field_at, uses);
                let default = field.get("default");
                match (required.contains(name.as_str()), default) {
                    (true, None) => {}
                    (true, Some(_)) => self.refuse(
                        &format!("{field_at}/default"),
                        "is a default on a field the schema requires",
                    ),
                    (false, Some(value)) => {
                        let _ = write!(written, ".default({})", literal(value));
                    }
                    (false, None) => written.push_str(".optional()"),
                }
                format!("{}: {written}", key(name))
            })
            .collect();
        if fields.is_empty() {
            return "z.object({})".to_owned();
        }
        format!("z.object({{ {} }})", fields.join(", "))
    }
}

/// The property every branch pins to a distinct constant, which zod can switch on.
fn discriminator(branches: &[Value]) -> Option<String> {
    let first = branches.first()?.get("properties")?.as_object()?;
    first
        .keys()
        .find(|key| {
            let mut seen = BTreeSet::new();
            branches.iter().all(|b| {
                b.get("type") == Some(&Value::from("object"))
                    && b.get("required")
                        .and_then(Value::as_array)
                        .is_some_and(|r| r.contains(&Value::from(key.as_str())))
                    && b.get("properties")
                        .and_then(|p| p.get(key.as_str()))
                        .and_then(|p| p.get("const"))
                        .is_some_and(|c| seen.insert(c.to_string()))
            })
        })
        .cloned()
}

/// Whether `name` may be written bare as a TypeScript name.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A property's key: bare when it can be, quoted otherwise.
fn key(name: &str) -> String {
    if is_identifier(name) {
        name.to_owned()
    } else {
        quoted(name)
    }
}

/// `text` as a TypeScript string literal: JSON's quoting, which TypeScript reads the same.
fn quoted(text: &str) -> String {
    Value::from(text).to_string()
}

/// `value` as a TypeScript expression: JSON, which TypeScript reads the same.
fn literal(value: &Value) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn one(schema: &Value) -> Result<String, Vec<String>> {
        let source = generate(&json!({ "$defs": { "T": schema } }), "./checks.js")?;
        let line = source
            .text
            .lines()
            .find_map(|l| l.strip_prefix("export const T = "))
            .map(|l| l.trim_end_matches(';').to_owned());
        Ok(line.unwrap_or_default())
    }

    fn refused(schema: &Value) -> Vec<String> {
        one(schema).err().unwrap_or_default()
    }

    #[test]
    fn writes_each_keyword_as_zod_spells_it() {
        let cases = [
            (json!(true), "z.unknown()"),
            (json!({ "type": "boolean" }), "z.boolean()"),
            (json!({ "type": "null" }), "z.null()"),
            (
                json!({ "type": "string", "minLength": 1, "maxLength": 40, "pattern": "^a\\d$" }),
                "z.string().min(1).max(40).regex(new RegExp(\"^a\\\\d$\"))",
            ),
            (
                json!({ "type": "string", "x-bazhen-transform": "trim", "minLength": 1 }),
                "z.string().trim().min(1)",
            ),
            (
                json!({ "type": "integer", "format": "uint16", "minimum": 0, "maximum": 65535 }),
                "z.number().int().min(0).max(65535)",
            ),
            (
                json!({ "type": "integer", "format": "uint64", "minimum": 0 }),
                "z.number().int().min(0)",
            ),
            (
                json!({ "type": "number", "format": "double" }),
                "z.number()",
            ),
            (
                json!({ "type": ["string", "null"] }),
                "z.string().nullable()",
            ),
            (
                json!({ "const": "hello", "type": "string" }),
                "z.literal(\"hello\")",
            ),
            (
                json!({ "enum": ["a", "b"], "type": "string" }),
                "z.enum([\"a\", \"b\"])",
            ),
            (
                json!({ "type": "array", "items": { "type": "string" }, "minItems": 1 }),
                "z.array(z.string()).min(1)",
            ),
            (
                json!({ "type": "object", "additionalProperties": { "type": "integer" } }),
                "z.record(z.string(), z.number().int())",
            ),
            (
                json!({
                    "type": "object",
                    "propertyNames": { "type": "string", "pattern": "^k" },
                    "additionalProperties": { "type": "string" },
                }),
                "z.record(z.string().regex(new RegExp(\"^k\")), z.string())",
            ),
            (
                json!({
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                    "x-bazhen-transform": "refusingOwnProto",
                }),
                "z.preprocess(checks.refusingOwnProto, z.record(z.string(), z.string()))",
            ),
            (
                json!({
                    "type": "object",
                    "properties": {
                        "a": { "type": "string" },
                        "b": { "type": "boolean", "default": false },
                        "c-d": { "type": "string" },
                    },
                    "required": ["a"],
                }),
                "z.object({ a: z.string(), b: z.boolean().default(false), \"c-d\": z.string().optional() })",
            ),
            (json!({ "type": "object" }), "z.object({})"),
            (
                json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] }),
                "z.string().nullable()",
            ),
            (
                json!({ "anyOf": [{ "type": "string" }, { "type": "boolean" }] }),
                "z.union([z.string(), z.boolean()])",
            ),
            (
                json!({ "type": "string", "x-bazhen-check": "no_lone_surrogate" }),
                "z.string().refine(checks.no_lone_surrogate)",
            ),
        ];
        for (schema, zod) in cases {
            assert_eq!(one(&schema), Ok(zod.to_owned()), "{schema}");
        }
    }

    #[test]
    fn switches_on_the_field_every_branch_pins_to_its_own_constant() {
        let branch = |tag: &str| {
            json!({
                "type": "object",
                "properties": { "type": { "const": tag, "type": "string" }, "n": { "type": "integer" } },
                "required": ["type"],
            })
        };
        let pinned = json!({ "oneOf": [branch("a"), branch("b")] });
        assert_eq!(
            one(&pinned),
            Ok(
                "z.discriminatedUnion(\"type\", [z.object({ n: z.number().int().optional(), type: \
                z.literal(\"a\") }), z.object({ n: z.number().int().optional(), type: \
                z.literal(\"b\") })])"
                    .to_owned()
            )
        );
        let repeated = json!({ "oneOf": [branch("a"), branch("a")] });
        assert!(one(&repeated).is_ok_and(|z| z.starts_with("z.union(")));
    }

    #[test]
    fn defines_each_schema_before_the_first_that_names_it() {
        let document = json!({ "$defs": {
            "A": { "type": "object", "properties": { "b": { "$ref": "#/$defs/B" } }, "required": ["b"] },
            "B": { "type": "array", "items": { "$ref": "#/$defs/C" } },
            "C": { "type": "string" },
        } });
        let text = generate(&document, "./checks.js").unwrap_or_default().text;
        let at = |name: &str| text.find(&format!("export const {name} = "));
        assert!(at("C") < at("B") && at("B") < at("A"), "{text}");
        assert!(text.contains("export type A = z.infer<typeof A>;"));
        assert!(!text.contains("import * as checks"));
    }

    #[test]
    fn imports_the_checks_it_names_and_lists_them() {
        let document = json!({ "$defs": {
            "A": { "type": "string", "x-bazhen-check": "one" },
            "B": { "type": "string", "x-bazhen-check": "two" },
            "C": {
                "type": "object",
                "additionalProperties": { "type": "string" },
                "x-bazhen-transform": "three",
            },
        } });
        let source = generate(&document, "../checks.js").unwrap_or_default();
        assert!(
            source
                .text
                .contains("import * as checks from \"../checks.js\";")
        );
        assert_eq!(
            source.checks,
            BTreeSet::from(["one".to_owned(), "two".to_owned(), "three".to_owned()])
        );
    }

    #[test]
    fn refuses_every_keyword_it_does_not_read_with_where_it_was() {
        for keyword in [
            "not",
            "allOf",
            "if",
            "then",
            "else",
            "dependentRequired",
            "patternProperties",
            "unevaluatedProperties",
            "prefixItems",
            "contains",
            "uniqueItems",
            "multipleOf",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "$defs",
            "$id",
            "examples",
            "x-bazhen-other",
        ] {
            let schema = json!({ "type": "string", keyword: 1 });
            assert_eq!(
                refused(&schema),
                vec![format!(
                    "$defs/T/{keyword}: is a keyword the generator doesn't read"
                )],
                "{keyword}"
            );
        }
    }

    #[test]
    fn refuses_what_zod_has_no_spelling_for() {
        let cases = [
            (
                json!(false),
                "$defs/T: is a schema zod can't spell: only `true` or an object is read",
            ),
            (
                json!({ "type": "string", "format": "date-time" }),
                "$defs/T/format: has no place in zod beside the others here",
            ),
            (
                json!({ "type": "integer", "format": "uint128" }),
                "$defs/T/format: is a format the generator doesn't read",
            ),
            (
                json!({ "type": "string", "minimum": 1 }),
                "$defs/T/minimum: has no place in zod beside the others here",
            ),
            (
                json!({ "type": "integer", "x-bazhen-transform": "trim" }),
                "$defs/T/x-bazhen-transform: has no place in zod beside the others here",
            ),
            (
                json!({ "type": "string", "x-bazhen-transform": "upper" }),
                "$defs/T/x-bazhen-transform: names no transform",
            ),
            (
                json!({ "type": "object", "additionalProperties": { "type": "string" }, "x-bazhen-transform": "a b" }),
                "$defs/T/x-bazhen-transform: names no transform",
            ),
            (
                json!({ "type": "object", "properties": {}, "x-bazhen-transform": "refusingOwnProto" }),
                "$defs/T/x-bazhen-transform: is read only on a record",
            ),
            (
                json!({ "type": "string", "x-bazhen-check": "a b" }),
                "$defs/T/x-bazhen-check: names no check",
            ),
            (
                json!({ "type": ["string", "integer"] }),
                "$defs/T/type: is a list other than [type, \"null\"]",
            ),
            (
                json!({ "type": "tuple" }),
                "$defs/T/type: names no JSON type",
            ),
            (
                json!({ "description": "no type" }),
                "$defs/T: has no `type`, `$ref`, `const`, `enum`, `anyOf` or `oneOf`",
            ),
            (
                json!({ "enum": ["a", 1] }),
                "$defs/T/enum: isn't a list of strings",
            ),
            (
                json!({ "type": "array" }),
                "$defs/T: is an array with no `items`",
            ),
            (
                json!({ "$ref": "#/components/T" }),
                "$defs/T/$ref: names no definition under `$defs`",
            ),
            (
                json!({ "$ref": "#/$defs/Missing" }),
                "$defs/T: names `Missing`, which `$defs` doesn't hold",
            ),
            (
                json!({ "$ref": "#/$defs/T" }),
                "$defs/T: names itself through its fields, which zod could only follow lazily",
            ),
            (
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                "$defs/T/additionalProperties: is read only as a record's values, on an object with no `properties`",
            ),
            (
                json!({ "type": "object", "properties": { "a": { "type": "string", "default": "" } }, "required": ["a"] }),
                "$defs/T/properties/a/default: is a default on a field the schema requires",
            ),
            (
                json!({ "type": "object", "properties": {}, "required": ["a"] }),
                "$defs/T/required: names `a`, no field here",
            ),
        ];
        for (schema, why) in cases {
            assert_eq!(refused(&schema), vec![why.to_owned()], "{schema}");
        }
    }

    #[test]
    fn refuses_a_name_typescript_cannot_take() {
        let document = json!({ "$defs": { "Agent-Name": { "type": "string" } } });
        assert_eq!(
            generate(&document, "./checks.js"),
            Err(vec!["$defs/Agent-Name: is no TypeScript name".to_owned()])
        );
    }
}
