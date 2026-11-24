//! One role file's text, as the definition of the role its file name keys, or why it isn't one,
//! in the words the TypeScript daemon uses: its front matter is held to the same strict schema,
//! each problem named as zod names the first it finds.

use bazhen_protocol::names::Role;
use bazhen_protocol::roles::RoleDefinition;
pub use bazhen_protocol::roles::RoleSource;

use crate::yaml::{self, Refused, Value};

/// The longest prompt a role may have, in UTF-16 units as JavaScript counts a string. An agent
/// given a role it wasn't launched in is sent the role's prompt as a message of its own, so it
/// must fit in one, with room for its heading.
pub const PROMPT_MAX: usize = 10_000;

/// No role file is this long; one that is was not written as one.
pub const FILE_MAX: usize = 64 * 1024;

const TITLE_MAX: usize = 80;
const DESCRIPTION_MAX: usize = 500;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// What starts a problem a YAML syntax error raises; the parser's words follow it.
pub const SYNTAX: &str = "its front matter isn't YAML: ";

/// The role a file named `<key>.md` holding `bytes` defines, or the problem with it. Bytes that
/// aren't UTF-8 read as U+FFFD, as Node decodes them.
///
/// # Errors
///
/// The problem, as the TypeScript daemon words it, with the key, the front matter or the prompt.
pub fn parse_role(key: &str, bytes: &[u8], source: RoleSource) -> Result<RoleDefinition, String> {
    let Some(role) = Role::parse(key) else {
        return Err(
            "a role file is named <role>.md, the role lowercase letters, digits or -".to_owned(),
        );
    };
    let text = String::from_utf8_lossy(bytes);
    let Some((front, body)) = split(&text) else {
        return Err("it must start with front matter between --- lines".to_owned());
    };
    let value = yaml::parse(front).map_err(|refused| match refused {
        Refused::Syntax(words) => format!("{SYNTAX}{words}"),
        Refused::Unsupported(what) => {
            format!("its front matter has {what}, which a role file can't")
        }
    })?;
    // Front matter that holds nothing, or null, is read as `?? {}` reads it: as no settings.
    let value = match value {
        None | Some(Value::Null) => Value::Object(Vec::new()),
        Some(value) => value,
    };
    let settings = front_matter(value).map_err(|issue| {
        if issue.path.is_empty() {
            format!("front matter {}", issue.message)
        } else {
            format!("front matter {}: {}", issue.path, issue.message)
        }
    })?;
    let prompt = js_trim(body);
    if prompt.is_empty() {
        return Err("it has no prompt after its front matter".to_owned());
    }
    let length = prompt.encode_utf16().count();
    if length > PROMPT_MAX {
        return Err(format!(
            "its prompt is {length} characters, over the {PROMPT_MAX} a role's may be"
        ));
    }
    Ok(RoleDefinition {
        key: role,
        title: settings.title,
        description: settings.description,
        grants: settings.grants,
        single_per_task: settings.single_per_task,
        max_active_tasks: settings.max_active_tasks,
        prompt: prompt.to_owned(),
        source,
    })
}

/// The front matter and the body of a file that opens with a `---` block, as
/// `/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/` splits it: the first closing `---` line ends
/// the block.
fn split(text: &str) -> Option<(&str, &str)> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    rest.match_indices('\n').find_map(|(at, _)| {
        let front = rest.get(..at)?;
        let after = rest.get(at + 1..)?.strip_prefix("---")?;
        let after = after.trim_start_matches([' ', '\t']);
        let body = if after.is_empty() {
            after
        } else {
            after
                .strip_prefix("\r\n")
                .or_else(|| after.strip_prefix('\n'))?
        };
        Some((front.strip_suffix('\r').unwrap_or(front), body))
    })
}

/// Whether JavaScript's `trim` takes `c`: its white space and line terminators, which aren't
/// Rust's (U+FEFF is one, U+0085 isn't).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// The first problem zod finds, and where.
struct Issue {
    path: String,
    message: String,
}

impl Issue {
    fn at(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }

    fn expected(path: impl Into<String>, expected: &str, got: Option<&Value>) -> Self {
        Self::at(
            path,
            format!(
                "Invalid input: expected {expected}, received {}",
                received(got)
            ),
        )
    }
}

/// What zod calls the type of a value it was handed; None is a key the file left out.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(n)) if n.is_nan() => "NaN",
        Some(Value::Number(n)) if *n == f64::INFINITY => "Infinity",
        Some(Value::Number(n)) if *n == f64::NEG_INFINITY => "-Infinity",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

struct Settings {
    title: String,
    description: String,
    grants: Vec<Role>,
    single_per_task: bool,
    max_active_tasks: Option<u64>,
}

const KEYS: [&str; 5] = [
    "title",
    "description",
    "grants",
    "singlePerTask",
    "maxActiveTasks",
];

/// The front matter's settings, or the first issue zod's strict schema finds: each key's in the
/// order the schema names them, then any key it doesn't know.
fn front_matter(value: Value) -> Result<Settings, Issue> {
    let Value::Object(entries) = value else {
        return Err(Issue::expected("", "object", Some(&value)));
    };
    let get = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let title = text(get("title"), "title", 1, TITLE_MAX)?;
    let description = match get("description") {
        None => String::new(),
        got => text(got, "description", 0, DESCRIPTION_MAX)?,
    };
    let grants = match get("grants") {
        None => Vec::new(),
        Some(Value::Array(items)) => grants(items)?,
        got => return Err(Issue::expected("grants", "array", got)),
    };
    let single_per_task = match get("singlePerTask") {
        None => false,
        Some(Value::Bool(b)) => *b,
        got => return Err(Issue::expected("singlePerTask", "boolean", got)),
    };
    let max_active_tasks = match get("maxActiveTasks") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(positive_int(*n)?),
        got => return Err(Issue::expected("maxActiveTasks", "number", got)),
    };
    let unknown: Vec<String> = entries
        .iter()
        .filter(|(k, _)| !KEYS.contains(&k.as_str()))
        .map(|(k, _)| format!("\"{k}\""))
        .collect();
    match unknown.as_slice() {
        [] => {}
        [one] => return Err(Issue::at("", format!("Unrecognized key: {one}"))),
        many => {
            return Err(Issue::at(
                "",
                format!("Unrecognized keys: {}", many.join(", ")),
            ));
        }
    }
    Ok(Settings {
        title,
        description,
        grants,
        single_per_task,
        max_active_tasks,
    })
}

/// A string, trimmed, of `min` to `max` code points, as zod measures one.
fn text(value: Option<&Value>, path: &str, min: usize, max: usize) -> Result<String, Issue> {
    let Some(Value::String(s)) = value else {
        return Err(Issue::expected(path, "string", value));
    };
    let trimmed = js_trim(s);
    let length = trimmed.chars().count();
    if length < min {
        return Err(Issue::at(
            path,
            format!("Too small: expected string to have >={min} characters"),
        ));
    }
    if length > max {
        return Err(Issue::at(
            path,
            format!("Too big: expected string to have <={max} characters"),
        ));
    }
    Ok(trimmed.to_owned())
}

fn grants(items: &[Value]) -> Result<Vec<Role>, Issue> {
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let path = format!("grants.{i}");
            let Value::String(s) = item else {
                return Err(Issue::expected(path, "string", Some(item)));
            };
            Role::parse(s).ok_or_else(|| {
                Issue::at(
                    path,
                    "a role is 1 to 32 lowercase letters, digits or -, starting with a letter",
                )
            })
        })
        .collect()
}

/// `z.int().positive()`: a finite whole number within JavaScript's safe integers, above zero.
fn positive_int(n: f64) -> Result<u64, Issue> {
    const PATH: &str = "maxActiveTasks";
    if !n.is_finite() {
        return Err(Issue::expected(PATH, "number", Some(&Value::Number(n))));
    }
    if n.fract() != 0.0 {
        return Err(Issue::at(
            PATH,
            "Invalid input: expected int, received number",
        ));
    }
    if n > MAX_SAFE_INTEGER {
        return Err(Issue::at(
            PATH,
            "Too big: expected int to be <=9007199254740991",
        ));
    }
    if n < -MAX_SAFE_INTEGER {
        return Err(Issue::at(
            PATH,
            "Too small: expected int to be >=-9007199254740991",
        ));
    }
    if n <= 0.0 {
        return Err(Issue::at(PATH, "Too small: expected number to be >0"));
    }
    // Whole and safe, so Rust writes it in digits alone, as u64 reads them.
    n.to_string()
        .parse()
        .map_err(|_| Issue::at(PATH, "Invalid input: expected int, received number"))
}
