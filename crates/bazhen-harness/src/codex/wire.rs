//! Reading Codex's app-server messages field by field, as the TypeScript adapter's zod schemas did:
//! a field that is required, optional (absent, never null) or nullish (absent or null), where any
//! other value fails the whole message.

use crate::js::Js;

/// A field whose value its schema refuses, which fails the whole message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Invalid;

/// `value` as an object, which `z.object` takes: not an array, not null.
pub(super) fn object(value: &Js) -> Option<&Js> {
    matches!(value, Js::Object(_)).then_some(value)
}

/// `name` of an object, which must be one.
pub(super) fn field<'a>(value: &'a Js, name: &str) -> Option<&'a Js> {
    object(value)?.field(name)
}

/// A field `z.string()` takes.
pub(super) fn string<'a>(value: &'a Js, name: &str) -> Option<&'a str> {
    field(value, name)?.as_str()
}

/// A field `z.string().optional()` takes: none when absent.
pub(super) fn optional_string<'a>(value: &'a Js, name: &str) -> Result<Option<&'a str>, Invalid> {
    match value.field(name) {
        None => Ok(None),
        Some(Js::String(s)) => Ok(Some(s)),
        Some(_) => Err(Invalid),
    }
}

/// A field `z.string().nullish()` takes: none when absent or null.
pub(super) fn nullish_string<'a>(value: &'a Js, name: &str) -> Result<Option<&'a str>, Invalid> {
    match value.field(name) {
        None | Some(Js::Null) => Ok(None),
        Some(Js::String(s)) => Ok(Some(s)),
        Some(_) => Err(Invalid),
    }
}

/// A field `z.boolean().optional()` takes.
pub(super) fn optional_bool(value: &Js, name: &str) -> Result<Option<bool>, Invalid> {
    match value.field(name) {
        None => Ok(None),
        Some(Js::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(Invalid),
    }
}

/// A field `z.boolean().nullish()` takes.
pub(super) fn nullish_bool(value: &Js, name: &str) -> Result<Option<bool>, Invalid> {
    match value.field(name) {
        None | Some(Js::Null) => Ok(None),
        Some(Js::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(Invalid),
    }
}

/// Whether a string is one JavaScript takes as true: any but the empty one.
pub(super) fn truthy(text: Option<&str>) -> Option<&str> {
    text.filter(|s| !s.is_empty())
}
