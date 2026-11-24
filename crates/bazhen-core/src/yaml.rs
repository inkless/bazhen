//! A role file's front matter, read from saphyr's events into the values JavaScript's `yaml`
//! package makes of it under its default YAML 1.2 core schema: a plain scalar is null, a bool, a
//! number or a string by the same tests, and any other scalar is a string. What a role file has
//! no use for, and what that schema would read another way, is refused: anchors, aliases, tags,
//! directives and more than one document.

use saphyr_parser::{Event, Parser, ScalarStyle};

/// A front matter value, as JavaScript holds it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    /// Keys in the order the file gives them, each once.
    Object(Vec<(String, Value)>),
}

/// Why front matter isn't read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Refused {
    /// It isn't YAML, in the parser's words, which name a place and never quote the file.
    Syntax(String),
    /// It is YAML a role file doesn't take.
    Unsupported(&'static str),
}

/// What's being built: a list, or a map and the key whose value comes next.
enum Open {
    Array(Vec<Value>),
    Object(Vec<(String, Value)>, Option<String>),
}

/// The document `text` holds, or None for none.
pub(crate) fn parse(text: &str) -> Result<Option<Value>, Refused> {
    if text.lines().any(|line| line.starts_with('%')) {
        return Err(Refused::Unsupported("a YAML directive"));
    }
    let mut stack: Vec<Open> = Vec::new();
    let mut root: Option<Value> = None;
    let mut documents = 0_usize;
    for event in Parser::new_from_str(text) {
        let (event, _) = event.map_err(|e| {
            let info = e.info().lines().next().unwrap_or("unreadable");
            let mark = e.marker();
            Refused::Syntax(format!(
                "{info} at line {}, column {}",
                mark.line(),
                mark.col() + 1
            ))
        })?;
        let value = match event {
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => continue,
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err(Refused::Syntax(
                        "Source contains multiple documents".to_owned(),
                    ));
                }
                continue;
            }
            Event::Alias(_) => return Err(Refused::Unsupported("a YAML alias")),
            Event::Scalar(text, style, anchor, tag) => {
                plain(anchor, tag.is_some())?;
                if style == ScalarStyle::Plain {
                    resolve(&text)
                } else {
                    Value::String(text.into_owned())
                }
            }
            Event::SequenceStart(anchor, tag) => {
                plain(anchor, tag.is_some())?;
                stack.push(Open::Array(Vec::new()));
                continue;
            }
            Event::MappingStart(anchor, tag) => {
                plain(anchor, tag.is_some())?;
                stack.push(Open::Object(Vec::new(), None));
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => match stack.pop() {
                Some(Open::Array(items)) => Value::Array(items),
                Some(Open::Object(entries, None)) => Value::Object(entries),
                Some(Open::Object(_, Some(_))) | None => {
                    return Err(Refused::Syntax(
                        "a collection ended out of place".to_owned(),
                    ));
                }
            },
        };
        match stack.last_mut() {
            None => root = Some(value),
            Some(Open::Array(items)) => items.push(value),
            Some(Open::Object(entries, key @ None)) => {
                let name = match value {
                    Value::String(name) => name,
                    Value::Null => String::new(),
                    Value::Bool(b) => b.to_string(),
                    // Only an unknown key's message shows it, which JavaScript may write otherwise.
                    Value::Number(n) => n.to_string(),
                    Value::Array(_) | Value::Object(_) => {
                        return Err(Refused::Unsupported("a key that isn't a scalar"));
                    }
                };
                if entries.iter().any(|(k, _)| *k == name) {
                    return Err(Refused::Syntax("Map keys must be unique".to_owned()));
                }
                *key = Some(name);
            }
            Some(Open::Object(entries, key)) => {
                if let Some(name) = key.take() {
                    entries.push((name, value));
                }
            }
        }
    }
    Ok(root)
}

/// Refuses an anchor or a tag: the core schema would read neither as the file means it.
fn plain(anchor: usize, tagged: bool) -> Result<(), Refused> {
    if anchor != 0 {
        return Err(Refused::Unsupported("a YAML anchor"));
    }
    if tagged {
        return Err(Refused::Unsupported("a YAML tag"));
    }
    Ok(())
}

/// A plain scalar, by the core schema's tests in the order the `yaml` package tries them.
fn resolve(text: &str) -> Value {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => {
            return Value::Number(f64::INFINITY);
        }
        "-.inf" | "-.Inf" | "-.INF" => return Value::Number(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return Value::Number(f64::NAN),
        _ => {}
    }
    if let Some(digits) = text.strip_prefix("0o")
        && !digits.is_empty()
        && digits.bytes().all(|b| (b'0'..=b'7').contains(&b))
    {
        return Value::Number(radix(digits, 8));
    }
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if !unsigned.is_empty() && unsigned.bytes().all(|b| b.is_ascii_digit()) {
        return Value::Number(number(text));
    }
    if let Some(digits) = text.strip_prefix("0x")
        && !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Value::Number(radix(digits, 16));
    }
    if is_float(unsigned) {
        return Value::Number(number(text));
    }
    Value::String(text.to_owned())
}

/// Digits in a radix, as `parseInt` reads them.
fn radix(digits: &str, base: u32) -> f64 {
    digits.chars().fold(0.0, |n, c| {
        n * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
    })
}

/// A decimal number the tests above passed, as `parseFloat` reads it.
fn number(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// `(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, with a fraction or an exponent: the floats
/// of the core schema, past their sign.
fn is_float(text: &str) -> bool {
    let (mantissa, exponent) = match text.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, Some(exponent)),
        None => (text, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => {
            (whole.is_empty() && digits(fraction))
                || (digits(whole) && (fraction.is_empty() || digits(fraction)))
        }
        None => exponent.is_some() && digits(mantissa),
    };
    let exponent_ok = exponent.is_none_or(|e| digits(e.strip_prefix(['-', '+']).unwrap_or(e)));
    mantissa_ok && exponent_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(entries: &[(&str, Value)]) -> Value {
        Value::Object(
            entries
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn reads_plain_scalars_as_the_core_schema_does() {
        let cases = [
            ("~", Value::Null),
            ("", Value::Null),
            ("True", Value::Bool(true)),
            ("FALSE", Value::Bool(false)),
            ("yes", Value::String("yes".to_owned())),
            ("+3", Value::Number(3.0)),
            ("007", Value::Number(7.0)),
            ("0x1F", Value::Number(31.0)),
            ("0o17", Value::Number(15.0)),
            ("0b1", Value::String("0b1".to_owned())),
            ("2.", Value::Number(2.0)),
            (".5", Value::Number(0.5)),
            ("1e3", Value::Number(1000.0)),
            ("1.5E-1", Value::Number(0.15)),
            ("1_000", Value::String("1_000".to_owned())),
            ("-.Inf", Value::Number(f64::NEG_INFINITY)),
            (".", Value::String(".".to_owned())),
            ("e5", Value::String("e5".to_owned())),
            ("1e", Value::String("1e".to_owned())),
            ("0x", Value::String("0x".to_owned())),
            ("-0x1", Value::String("-0x1".to_owned())),
        ];
        for (text, value) in cases {
            assert_eq!(resolve(text), value, "{text}");
        }
        assert!(matches!(resolve(".NaN"), Value::Number(n) if n.is_nan()));
    }

    #[test]
    fn reads_a_mapping_of_lists_and_quoted_strings() {
        assert_eq!(
            parse("a: [1, '2']\nb:\n  - x\nc: \"3\"\n"),
            Ok(Some(object(&[
                (
                    "a",
                    Value::Array(vec![Value::Number(1.0), Value::String("2".to_owned())])
                ),
                ("b", Value::Array(vec![Value::String("x".to_owned())])),
                ("c", Value::String("3".to_owned())),
            ])))
        );
        assert_eq!(parse(""), Ok(None));
        assert_eq!(parse("# nothing\n"), Ok(None));
    }

    #[test]
    fn refuses_anchors_aliases_tags_directives_and_a_second_document() {
        let refused = |text: &str| parse(text).err();
        assert_eq!(
            refused("a: &x 1\nb: *x"),
            Some(Refused::Unsupported("a YAML anchor"))
        );
        assert_eq!(
            refused("a: !!str 1"),
            Some(Refused::Unsupported("a YAML tag"))
        );
        assert_eq!(refused("a: !x 1"), Some(Refused::Unsupported("a YAML tag")));
        assert_eq!(
            refused("%YAML 1.1\n---\na: yes"),
            Some(Refused::Unsupported("a YAML directive"))
        );
        assert_eq!(
            refused("? [a]\n: 1"),
            Some(Refused::Unsupported("a key that isn't a scalar"))
        );
        assert!(matches!(refused("a: 1\n--- x"), Some(Refused::Syntax(_))));
        assert!(matches!(refused("a: 1\na: 2"), Some(Refused::Syntax(_))));
    }
}
