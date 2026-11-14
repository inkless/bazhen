//! How a JSON body is read so that it means what the zod schema says, where serde alone would
//! say something else: a derived struct accepts a JSON array as its fields in order, a plain
//! `Option` field takes `null` for missing and missing for `null`, and a struct refuses a key
//! given twice where JavaScript keeps the last. Every body is read into a `Value` first, which
//! keeps the last of a repeated key and refuses a lone surrogate anywhere, then checked to be an
//! object, and each field of a struct type goes through `object`.

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// A body's JSON, as an object, read into `T`.
pub(crate) fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, serde_json::Error> {
    if !value.is_object() {
        return Err(serde_json::Error::custom(format!(
            "expected an object, not {}",
            kind(&value)
        )));
    }
    T::deserialize(value)
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// A field of a struct type: an object, never an array.
pub(crate) fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<T, D::Error> {
    from_value(Value::deserialize(d)?).map_err(D::Error::custom)
}

/// An optional field, as zod's `.optional()`: it may be left out, and is never `null`. Taken with
/// `#[serde(default)]`, which is what lets it be left out.
pub(crate) fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// An optional field of a struct type.
pub(crate) fn optional_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    object(d).map(Some)
}

/// A nullable field, as zod's `.nullable()`: it may be `null`, and is never left out. With
/// `deserialize_with` and no default, serde refuses the field missing.
pub(crate) fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

/// A nullable field of a struct type.
pub(crate) fn nullable_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    match Value::deserialize(d)? {
        Value::Null => Ok(None),
        value => from_value(value).map(Some).map_err(D::Error::custom),
    }
}
