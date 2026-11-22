//! A field that may be absent, null or a value, each meaning something different: zod's
//! `.nullable().optional()`, as a field added to the protocol after null already meant "none".

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Nullable<T> {
    /// Not sent: a daemon from before the field.
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Nullable<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    /// The value, if there is one; absent and null alike have none.
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Value(v) => Some(v),
            Self::Absent | Self::Null => None,
        }
    }

    /// A field's deserializer, called only when the field is there: absent comes from its default.
    ///
    /// # Errors
    ///
    /// When the field is neither null nor a `T`.
    pub fn present<'de, D>(d: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Ok(Option::<T>::deserialize(d)?.map_or(Self::Null, Self::Value))
    }
}

/// A field's deserializer for zod's `.optional()`, called only when the field is there: absent
/// comes from its default, and null, which `.optional()` refuses, is refused here too.
///
/// # Errors
///
/// When the field is not a `T`, null included.
pub fn optional<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Value(v) => v.serialize(s),
            Self::Absent | Self::Null => s.serialize_none(),
        }
    }
}
