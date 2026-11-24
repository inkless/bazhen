//! A JSON object whose keys a message doesn't fix, kept in the order it arrived: `bazhen doctor`
//! prints a record's entries as the daemon listed them.

use std::collections::HashMap;
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

#[cfg(feature = "schema")]
impl<V: schemars::JsonSchema> schemars::JsonSchema for Record<V> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Record_of_{}", V::schema_name()).into()
    }

    fn schema_id() -> std::borrow::Cow<'static, str> {
        format!("bazhen_protocol::Record<{}>", V::schema_id()).into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        HashMap::<String, V>::json_schema(generator)
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
        let mut at: HashMap<String, usize> = HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, V>()? {
            // A repeated key keeps its first place and its last value, as JSON.parse does.
            if let Some(entry) = at.get(&key).and_then(|&i| entries.get_mut(i)) {
                entry.1 = value;
            } else {
                at.insert(key.clone(), entries.len());
                entries.push((key, value));
            }
        }
        Ok(Record(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_order_keys_came_in_and_a_repeated_key_its_first_place_and_last_value() {
        let record: Record<u64> = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(record.entries(), [("b".to_owned(), 3), ("a".to_owned(), 2)]);
        assert_eq!(serde_json::to_string(&record).unwrap(), r#"{"b":3,"a":2}"#);
    }
}
