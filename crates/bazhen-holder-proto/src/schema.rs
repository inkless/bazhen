//! The holder protocol's bodies as JSON Schema, which `cargo xtask schema` writes the TypeScript
//! protocol from. A type read `try_from` another is described here by hand with the limits its
//! conversion holds it to, which a derive, describing the type it converts from, would leave out.

use std::borrow::Cow;
use std::marker::PhantomData;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};

use crate::body::{
    Alternate, Argv, Bounded, Env, ErrorBody, ExitCode, Exited, Foreground, Gap, HelloReply,
    HelloRequest, MAX_SAFE_INTEGER, OkBody, PasteRequest, ProtocolVersion, RESERVED_ENV_NAMES,
    RESERVED_TAG_NAMES, Resized, Respawned, Screen, ScreenRequest, SetTagsRequest, SetThemeRequest,
    Signal, SignalRequest, SpawnSpec, Stats, SubscribeRequest, TagName, TagValue, Tags, TerminalId,
    Theme, Title, Utf8, VersionText, Versions,
};

/// Adds every body a holder request, reply or event carries to `generator`'s definitions, with
/// each type it names.
pub fn add_bodies(generator: &mut SchemaGenerator) {
    generator.subschema_for::<HelloRequest>();
    generator.subschema_for::<SubscribeRequest>();
    generator.subschema_for::<SignalRequest>();
    generator.subschema_for::<SetTagsRequest>();
    generator.subschema_for::<SetThemeRequest>();
    generator.subschema_for::<PasteRequest>();
    generator.subschema_for::<ScreenRequest>();
    generator.subschema_for::<SpawnSpec>();
    generator.subschema_for::<HelloReply>();
    generator.subschema_for::<OkBody>();
    generator.subschema_for::<ErrorBody>();
    generator.subschema_for::<Stats>();
    generator.subschema_for::<Foreground>();
    generator.subschema_for::<Screen>();
    generator.subschema_for::<Gap>();
    generator.subschema_for::<Resized>();
    generator.subschema_for::<Title>();
    generator.subschema_for::<Alternate>();
    generator.subschema_for::<Exited>();
    generator.subschema_for::<Respawned>();
}

/// The extension that names a rule no keyword states, which `checks.ts` holds a string to.
const CHECK: &str = "x-bazhen-check";

/// The extension that names, on a record, the `checks.ts` preprocess that refuses an own
/// `__proto__` key: zod's record skips one, so `propertyNames` alone never sees it.
const TRANSFORM: &str = "x-bazhen-transform";
const REFUSING_OWN_PROTO: &str = "refusingOwnProto";

/// A pattern that refuses each of `names` as the whole string.
fn refusing(names: &[&str]) -> String {
    format!("^(?!(?:{})$)", names.join("|"))
}

impl<const MIN: u64, const MAX: u64, K> JsonSchema for Bounded<MIN, MAX, K> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Bounded_{MIN}_to_{MAX}").into()
    }

    fn schema_id() -> Cow<'static, str> {
        format!("bazhen_holder_proto::body::Bounded<{MIN}, {MAX}>").into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer", "minimum": MIN, "maximum": MAX })
    }
}

impl JsonSchema for ExitCode {
    fn schema_name() -> Cow<'static, str> {
        "HolderExitCode".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let top = MAX_SAFE_INTEGER.cast_signed();
        json_schema!({ "type": "integer", "minimum": -top, "maximum": top })
    }
}

/// zod counts a string's length in UTF-16 units, which agree with UTF-8 bytes only up to one, so
/// a longer byte budget is a named check.
impl<const MAX: usize, const MIN: usize> JsonSchema for Utf8<MAX, MIN> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Utf8_{MIN}_to_{MAX}").into()
    }

    fn schema_id() -> Cow<'static, str> {
        format!("bazhen_holder_proto::body::Utf8<{MAX}, {MIN}>").into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        const { assert!(MIN <= 1, "a minimum past one byte has no zod spelling here") };
        let mut schema = json_schema!({ "type": "string" });
        if MIN > 0 {
            schema.insert("minLength".to_owned(), MIN.into());
        }
        if MAX != usize::MAX {
            schema.insert(CHECK.to_owned(), format!("utf8AtMost{MAX}Bytes").into());
        }
        schema
    }
}

impl JsonSchema for Versions {
    fn schema_name() -> Cow<'static, str> {
        "HolderVersions".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "array",
            "items": generator.subschema_for::<VersionText>(),
            "minItems": 1,
            "maxItems": 16,
        })
    }
}

impl JsonSchema for ProtocolVersion {
    fn schema_name() -> Cow<'static, str> {
        "HolderProtocolVersion".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" })
    }
}

impl JsonSchema for TerminalId {
    fn schema_name() -> Cow<'static, str> {
        "HolderTerminalId".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" })
    }
}

impl JsonSchema for Argv {
    fn schema_name() -> Cow<'static, str> {
        "HolderArgv".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "array", "items": { "type": "string" }, "minItems": 1 })
    }
}

impl JsonSchema for Signal {
    fn schema_name() -> Cow<'static, str> {
        "HolderSignal".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "enum": Self::ALL.map(Self::as_str) })
    }
}

impl JsonSchema for Theme {
    fn schema_name() -> Cow<'static, str> {
        "HolderTheme".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "enum": Self::ALL.map(Self::as_str) })
    }
}

impl JsonSchema for Tags {
    fn schema_name() -> Cow<'static, str> {
        "HolderTags".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut names = generator.subschema_for::<TagName>();
        names.insert("pattern".to_owned(), refusing(&RESERVED_TAG_NAMES).into());
        json_schema!({
            "type": "object",
            "propertyNames": names,
            "additionalProperties": generator.subschema_for::<TagValue>(),
            TRANSFORM: REFUSING_OWN_PROTO,
        })
    }
}

impl JsonSchema for Env {
    fn schema_name() -> Cow<'static, str> {
        "HolderEnv".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "object",
            "propertyNames": { "type": "string", "pattern": refusing(&RESERVED_ENV_NAMES) },
            "additionalProperties": { "type": "string" },
            TRANSFORM: REFUSING_OWN_PROTO,
        })
    }
}

/// The schema of a field that must be there and may be null, as `Option::deserialize` reads an
/// `Option`: schemars leaves out of `required` only a field whose type is an `Option`, which this
/// isn't, so it stays in.
#[derive(Debug)]
pub struct Required<T>(PhantomData<T>);

impl<T: JsonSchema> JsonSchema for Required<T> {
    fn inline_schema() -> bool {
        Option::<T>::inline_schema()
    }

    fn schema_name() -> Cow<'static, str> {
        Option::<T>::schema_name()
    }

    fn schema_id() -> Cow<'static, str> {
        Option::<T>::schema_id()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        Option::<T>::json_schema(generator)
    }
}

#[cfg(test)]
mod tests {
    use schemars::generate::SchemaSettings;
    use serde_json::{Map, Value, json};

    use super::*;
    use crate::body::{Cols, Count, Offset, Rows};

    fn definitions() -> Map<String, Value> {
        let mut generator = SchemaSettings::draft2020_12().into_generator();
        add_bodies(&mut generator);
        generator.take_definitions(true)
    }

    fn described(definitions: &Map<String, Value>, name: &str) -> Value {
        let mut schema = definitions.get(name).cloned().unwrap_or_default();
        if let Some(schema) = schema.as_object_mut() {
            schema.remove("description");
        }
        schema
    }

    #[test]
    fn describes_each_type_read_through_another_with_the_limits_its_conversion_holds() {
        let definitions = definitions();
        let names = json!({
            "type": "string",
            "minLength": 1,
            "pattern": "^(?!(?:__proto__|constructor|prototype)$)",
            "x-bazhen-check": "utf8AtMost64Bytes",
        });
        let cases = [
            (
                "HolderSize",
                json!({
                    "type": "object",
                    "properties": {
                        "cols": { "type": "integer", "minimum": 0, "maximum": 1000 },
                        "rows": { "type": "integer", "minimum": 0, "maximum": 1000 },
                    },
                    "required": ["cols", "rows"],
                }),
            ),
            (
                "HolderExitCode",
                json!({ "type": "integer", "minimum": -9_007_199_254_740_991_i64, "maximum": 9_007_199_254_740_991_i64 }),
            ),
            (
                "HolderVersions",
                json!({
                    "type": "array",
                    "items": { "type": "string", "x-bazhen-check": "utf8AtMost32Bytes" },
                    "minItems": 1,
                    "maxItems": 16,
                }),
            ),
            (
                "HolderProtocolVersion",
                json!({ "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" }),
            ),
            (
                "HolderTerminalId",
                json!({ "type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$" }),
            ),
            (
                "HolderArgv",
                json!({ "type": "array", "items": { "type": "string" }, "minItems": 1 }),
            ),
            (
                "HolderSignal",
                json!({ "type": "string", "enum": ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] }),
            ),
            (
                "HolderTheme",
                json!({ "type": "string", "enum": ["light", "dark"] }),
            ),
            (
                "HolderTags",
                json!({
                    "type": "object",
                    "propertyNames": names,
                    "additionalProperties": { "type": "string", "x-bazhen-check": "utf8AtMost1024Bytes" },
                    "x-bazhen-transform": "refusingOwnProto",
                }),
            ),
            (
                "HolderEnv",
                json!({
                    "type": "object",
                    "propertyNames": { "type": "string", "pattern": "^(?!(?:__proto__)$)" },
                    "additionalProperties": { "type": "string" },
                    "x-bazhen-transform": "refusingOwnProto",
                }),
            ),
        ];
        for (name, schema) in cases {
            assert_eq!(described(&definitions, name), schema, "{name}");
        }
        let generic: Vec<&String> = definitions
            .keys()
            .filter(|n| n.starts_with("Bounded") || n.starts_with("Utf8"))
            .collect();
        assert_eq!(generic, Vec::<&String>::new());
    }

    #[test]
    fn tells_apart_bounded_integers_and_strings_by_their_limits_alone() {
        assert_ne!(Cols::schema_id(), Count::schema_id());
        assert_eq!(Cols::schema_id(), Rows::schema_id());
        assert_eq!(Count::schema_id(), Offset::schema_id());
        assert_ne!(TagName::schema_id(), TagValue::schema_id());
        assert_ne!(TagValue::schema_id(), VersionText::schema_id());
        assert_ne!(Cols::schema_name(), Count::schema_name());
        assert_ne!(TagName::schema_name(), TagValue::schema_name());
    }
}
