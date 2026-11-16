//! A JSON object whose keys a message doesn't fix, kept in the order it arrived: `bazhen doctor`
//! prints a record's entries as the daemon listed them.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record<V>(Vec<(String, V)>);

impl<V> Record<V> {
    pub fn new(entries: Vec<(String, V)>) -> Self {
        Self(entries)
    }

    pub fn entries(&self) -> &[(String, V)] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<V> Default for Record<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V: Serialize> Serialize for Record<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for Record<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(Entries(PhantomData))
    }
}

struct Entries<V>(PhantomData<V>);

impl<'de, V: Deserialize<'de>> Visitor<'de> for Entries<V> {
    type Value = Record<V>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Record<V>, A::Error> {
        let mut entries: Vec<(String, V)> = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, V>()? {
            // A repeated key keeps its first place and its last value, as JSON.parse does.
            match entries.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = value,
                None => entries.push((key, value)),
            }
        }
        Ok(Record(entries))
    }
}
