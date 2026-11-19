//! The keys `config.toml` may hold, checked as `ConfigFile` in `apps/daemon/src/config/config.ts`
//! checks them with zod, and refused with the first issue zod reports, in its words: each table's
//! keys in the schema's order, a table's unknown keys after them, and a list's items in order.

use std::fmt;

use bazhen_protocol::text::is_origin;
use toml::de::{DeTable, DeValue};
use toml::value::Datetime;

use super::{
    FileConfig, HOLDER_MAX_HISTORY_LINES, Listen, PairingMode, RuntimeKind, Shell, ranges, sizes,
};

/// The largest integer JavaScript holds exactly, and so the furthest a TOML integer may go, in
/// either direction, for the TypeScript daemon to read it.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The first thing wrong with a file: the dotted path to it, and what zod says of it.
#[derive(Debug)]
struct Issue {
    path: String,
    message: String,
}

impl fmt::Display for Issue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let path = if self.path.is_empty() {
            "(top level)"
        } else {
            &self.path
        };
        write!(f, "{path}: {}", self.message)
    }
}

type Checked<T> = Result<T, Issue>;

fn issue<T>(path: &str, message: String) -> Checked<T> {
    Err(Issue {
        path: path.to_owned(),
        message,
    })
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

/// A TOML number as JavaScript holds it, which doesn't tell an integer from a float.
#[derive(Debug, Clone, Copy)]
enum Number {
    Int(i64),
    Float(f64),
}

fn integer(value: &toml::de::DeInteger<'_>) -> Option<i64> {
    i64::from_str_radix(value.as_str(), value.radix())
        .ok()
        .filter(|n| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(n))
}

fn float(value: &toml::de::DeFloat<'_>) -> f64 {
    let text = value.as_str();
    let (negative, magnitude) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let magnitude = match magnitude {
        "nan" => f64::NAN,
        "inf" => f64::INFINITY,
        // Past f64's range a float is infinite, as JavaScript reads it.
        digits => digits.parse().unwrap_or(f64::NAN),
    };
    if negative { -magnitude } else { magnitude }
}

fn number(value: &DeValue<'_>) -> Option<Number> {
    match value {
        DeValue::Integer(n) => integer(n).map(Number::Int),
        DeValue::Float(f) => Some(Number::Float(float(f))),
        _ => None,
    }
}

fn leap_second(at: &Datetime) -> bool {
    at.time.is_some_and(|time| time.second == Some(60))
}

/// What in `value` the TOML parser the TypeScript daemon uses refuses the whole file for, in its
/// words: an integer JavaScript can't hold exactly, or a leap second, which its `Date` can't.
fn unreadable(value: &DeValue<'_>) -> Option<&'static str> {
    match value {
        DeValue::Integer(n) if integer(n).is_none() => {
            Some("integer value cannot be represented losslessly")
        }
        DeValue::Datetime(at) if leap_second(at) => Some("invalid date"),
        DeValue::Array(items) => items.iter().find_map(|item| unreadable(item.get_ref())),
        DeValue::Table(table) => table.values().find_map(|item| unreadable(item.get_ref())),
        _ => None,
    }
}

/// Whether `err`, from parsing `text`, is only a day past its month's end, such as 2023-02-30,
/// which JavaScript's `Date`, and so the TOML parser the TypeScript daemon uses, reads as a day of
/// the next month. Its value is read as a datetime all the same, refused wherever it stands.
pub(super) fn rolls_over(text: &str, err: &toml::de::Error) -> bool {
    let Some(raw) = err.span().and_then(|span| text.get(span)) else {
        return false;
    };
    let Some(((month, day), rest)) = raw
        .split_at_checked(10)
        .and_then(|(date, rest)| Some((date.split_at_checked(8)?, rest)))
    else {
        return false;
    };
    matches!(day, "29" | "30" | "31")
        && format!("{month}28{rest}")
            .parse::<Datetime>()
            .is_ok_and(|at| !leap_second(&at))
}

/// What zod says it received, for a value of the wrong type.
fn received(value: &DeValue<'_>) -> &'static str {
    match value {
        DeValue::String(_) => "string",
        DeValue::Integer(_) => "number",
        DeValue::Float(f) => received_number(float(f)),
        DeValue::Boolean(_) => "boolean",
        DeValue::Datetime(_) => "TomlDate",
        DeValue::Array(_) => "array",
        DeValue::Table(_) => "object",
    }
}

fn received_number(n: f64) -> &'static str {
    if n.is_nan() {
        "NaN"
    } else if n == f64::INFINITY {
        "Infinity"
    } else if n == f64::NEG_INFINITY {
        "-Infinity"
    } else {
        "number"
    }
}

fn expected(what: &str, value: &DeValue<'_>) -> String {
    format!(
        "Invalid input: expected {what}, received {}",
        received(value)
    )
}

/// `z.int().min(min).max(max)` of a number: a safe integer first, then the bounds.
fn bounded(n: Number, min: i64, max: Option<i64>) -> Result<i64, String> {
    let n = match n {
        Number::Int(n) => n,
        Number::Float(f) if !f.is_finite() => {
            return Err(format!(
                "Invalid input: expected number, received {}",
                received_number(f)
            ));
        }
        // Past 2^52 every float is whole, so these are whole numbers JavaScript can't hold exactly.
        Number::Float(f) if f > 9_007_199_254_740_991.0 => {
            return Err(format!("Too big: expected int to be <={MAX_SAFE_INTEGER}"));
        }
        Number::Float(f) if f < -9_007_199_254_740_991.0 => {
            return Err(format!(
                "Too small: expected int to be >=-{MAX_SAFE_INTEGER}"
            ));
        }
        // A whole number within ±2^53 prints as its digits, which read as an integer; a fraction
        // prints its point, which doesn't.
        Number::Float(f) => format!("{f}")
            .parse()
            .map_err(|_| "Invalid input: expected int, received number".to_owned())?,
    };
    if n < min {
        return Err(format!("Too small: expected number to be >={min}"));
    }
    match max {
        Some(max) if n > max => Err(format!("Too big: expected number to be <={max}")),
        _ => Ok(n),
    }
}

fn int<T: TryFrom<i64>>(value: &DeValue<'_>, path: &str, min: i64, max: Option<i64>) -> Checked<T> {
    let Some(n) = number(value) else {
        return issue(path, expected("number", value));
    };
    let n = bounded(n, min, max).or_else(|message| issue(path, message))?;
    T::try_from(n).or_else(|_| issue(path, format!("Too big: expected number to be <={n}")))
}

const PORT_MAX: i64 = 65_535;

fn port(value: &DeValue<'_>, path: &str) -> Checked<u16> {
    int(value, path, 1, Some(PORT_MAX))
}

/// A port as `BAZHEN_PORT` gives one, once `Number` has read it.
pub(super) fn port_number(n: f64) -> Result<u16, String> {
    let n = bounded(Number::Float(n), 1, Some(PORT_MAX))?;
    u16::try_from(n).map_err(|_| format!("Too big: expected number to be <={PORT_MAX}"))
}

fn boolean(value: &DeValue<'_>, path: &str) -> Checked<bool> {
    match value {
        DeValue::Boolean(b) => Ok(*b),
        _ => issue(path, expected("boolean", value)),
    }
}

/// A string, refused with what `refusal` says of it, if anything.
fn string(
    value: &DeValue<'_>,
    path: &str,
    refusal: impl Fn(&str) -> Option<String>,
) -> Checked<String> {
    let DeValue::String(text) = value else {
        return issue(path, expected("string", value));
    };
    match refusal(text) {
        Some(message) => issue(path, message),
        None => Ok(text.clone().into_owned()),
    }
}

fn list<T>(
    value: &DeValue<'_>,
    path: &str,
    item: impl Fn(&DeValue<'_>, &str) -> Checked<T>,
) -> Checked<Vec<T>> {
    let DeValue::Array(items) = value else {
        return issue(path, expected("array", value));
    };
    items
        .iter()
        .enumerate()
        .map(|(i, v)| item(v.get_ref(), &child(path, &i.to_string())))
        .collect()
}

/// One of `options`, by its name.
fn one_of<T: Copy>(text: Option<&str>, options: &[(&str, T)]) -> Result<T, String> {
    options
        .iter()
        .find(|(name, _)| Some(*name) == text)
        .map(|&(_, option)| option)
        .ok_or_else(|| {
            let names: Vec<String> = options.iter().map(|(n, _)| format!("\"{n}\"")).collect();
            format!("Invalid option: expected one of {}", names.join("|"))
        })
}

fn choice<T: Copy>(value: &DeValue<'_>, path: &str, options: &[(&str, T)]) -> Checked<T> {
    let text = match value {
        DeValue::String(text) => Some(text.as_ref()),
        _ => None,
    };
    one_of(text, options).or_else(|message| issue(path, message))
}

const SHELLS: [(&str, Shell); 2] = [("direct", Shell::Direct), ("login", Shell::Login)];
const PAIRINGS: [(&str, PairingMode); 2] =
    [("auto", PairingMode::Auto), ("always", PairingMode::Always)];
const LISTENS: [(&str, Listen); 2] = [("loopback", Listen::Loopback), ("lan", Listen::Lan)];
const RUNTIMES: [(&str, RuntimeKind); 2] =
    [("tmux", RuntimeKind::Tmux), ("holder", RuntimeKind::Holder)];
const FLAGS: [(&str, bool); 2] = [("true", true), ("false", false)];

/// `BAZHEN_AGENTS_SHELL`.
pub(super) fn shell(raw: &str) -> Result<Shell, String> {
    one_of(Some(raw), &SHELLS)
}

/// `BAZHEN_PAIRING`.
pub(super) fn pairing(raw: &str) -> Result<PairingMode, String> {
    one_of(Some(raw), &PAIRINGS)
}

/// `BAZHEN_WEB_LISTEN`.
pub(super) fn listen(raw: &str) -> Result<Listen, String> {
    one_of(Some(raw), &LISTENS)
}

/// `BAZHEN_ALLOW_INSECURE_ORIGINS`: `true` or `false`.
pub(super) fn flag(raw: &str) -> Result<bool, String> {
    one_of(Some(raw), &FLAGS)
}

/// A variable's name, or a prefix of one ending in `*`, as `ENV_RULE` in packages/core takes.
fn is_env_rule(rule: &str) -> bool {
    let name = rule.strip_suffix('*').unwrap_or(rule);
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn env_rules(value: &DeValue<'_>, path: &str) -> Checked<Vec<String>> {
    list(value, path, |v, p| {
        string(v, p, |rule| {
            (!is_env_rule(rule))
                .then(|| "must be a variable name, or a prefix ending in *".to_owned())
        })
    })
}

fn origins(value: &DeValue<'_>, path: &str) -> Checked<Vec<String>> {
    list(value, path, |v, p| {
        string(v, p, |origin| {
            (!is_origin(origin))
                .then(|| "must be an origin, such as https://bazhen.example.com".to_owned())
        })
    })
}

fn memory_max(value: &DeValue<'_>, path: &str) -> Checked<String> {
    string(value, path, |v| {
        sizes::memory_max_refusal(v).map(|why| format!("{v} {why}"))
    })
}

fn swap_max(value: &DeValue<'_>, path: &str) -> Checked<String> {
    string(value, path, |v| {
        sizes::swap_max_refusal(v).map(|why| format!("{v} {why}"))
    })
}

fn lan_allow(value: &DeValue<'_>, path: &str) -> Checked<Vec<String>> {
    list(value, path, |v, p| {
        string(v, p, |text| {
            ranges::parse_range(text)
                .err()
                .map(|problem| format!("{text} {problem}"))
        })
    })
}

fn absolute(value: &DeValue<'_>, path: &str) -> Checked<String> {
    string(value, path, |text| {
        (!text.starts_with('/')).then(|| "Invalid string: must start with \"/\"".to_owned())
    })
}

/// A key JavaScript lists before the rest, in numeric order: an array index.
fn array_index(key: &str) -> Option<u64> {
    let canonical =
        key.bytes().all(|b| b.is_ascii_digit()) && (key == "0" || !key.starts_with('0'));
    key.parse::<u64>()
        .ok()
        .filter(|&i| canonical && i < u64::from(u32::MAX))
}

/// A table of the file, at `path`.
struct Table<'a, 'i> {
    entries: &'a DeTable<'i>,
    path: String,
}

impl<'a, 'i> Table<'a, 'i> {
    fn of(value: &'a DeValue<'i>, path: String) -> Checked<Self> {
        match value {
            DeValue::Table(entries) => Ok(Self { entries, path }),
            _ => issue(&path, expected("object", value)),
        }
    }

    fn get(&self, key: &str) -> Option<&'a DeValue<'i>> {
        self.entries.get(key).map(toml::Spanned::get_ref)
    }

    /// The value at `key`, if there is one, as `parse` reads it.
    fn field<T>(
        &self,
        key: &str,
        parse: impl Fn(&DeValue<'_>, &str) -> Checked<T>,
    ) -> Checked<Option<T>> {
        self.get(key)
            .map(|value| parse(value, &child(&self.path, key)))
            .transpose()
    }

    /// The table at `key`, if there is one.
    fn table(&self, key: &str) -> Checked<Option<Table<'a, 'i>>> {
        self.get(key)
            .map(|value| Table::of(value, child(&self.path, key)))
            .transpose()
    }

    /// Refuses the keys not in `known`, all at once, in the order JavaScript lists them.
    fn strict(&self, known: &[&str]) -> Checked<()> {
        let mut unknown: Vec<_> = self
            .entries
            .keys()
            .filter(|key| !known.contains(&key.get_ref().as_ref()))
            .collect();
        if unknown.is_empty() {
            return Ok(());
        }
        unknown.sort_by_key(|key| match array_index(key.get_ref()) {
            Some(index) => (0, index),
            None => (1, u64::try_from(key.span().start).unwrap_or(u64::MAX)),
        });
        let names: Vec<String> = unknown
            .iter()
            .map(|key| format!("\"{}\"", key.get_ref()))
            .collect();
        let s = if names.len() > 1 { "s" } else { "" };
        issue(
            &self.path,
            format!("Unrecognized key{s}: {}", names.join(", ")),
        )
    }
}

/// What `root`, a parsed file, says, or the message for the first thing wrong with it.
pub(super) fn file_config(root: &DeTable<'_>) -> Result<FileConfig, String> {
    if let Some(why) = root.values().find_map(|value| unreadable(value.get_ref())) {
        return Err(format!("Invalid TOML document: {why}"));
    }
    let top = Table {
        entries: root,
        path: String::new(),
    };
    read(&top).map_err(|issue| issue.to_string())
}

fn read(top: &Table<'_, '_>) -> Checked<FileConfig> {
    let mut out = FileConfig::default();
    if let Some(daemon) = top.table("daemon")? {
        out.port = daemon.field("port", port)?;
        daemon.strict(&["port"])?;
    }
    if let Some(bank) = top.table("bank")? {
        out.bank = bank.field("path", absolute)?;
        bank.strict(&["path"])?;
    }
    if let Some(notifications) = top.table("notifications")? {
        out.desktop_notifications = notifications.field("desktop", boolean)?;
        notifications.strict(&["desktop"])?;
    }
    if let Some(shells) = top.table("shells")? {
        out.retype_last_command = shells.field("retype_last_command", boolean)?;
        shells.strict(&["retype_last_command"])?;
    }
    if let Some(agents) = top.table("agents")? {
        out.shell = agents.field("shell", |v, p| choice(v, p, &SHELLS))?;
        out.max_launched = agents.field("max_launched", |v, p| int(v, p, 0, None))?;
        out.max_launch_depth = agents.field("max_launch_depth", |v, p| int(v, p, 1, None))?;
        out.start_deadline_seconds =
            agents.field("start_deadline_seconds", |v, p| int(v, p, 1, None))?;
        if let Some(env) = agents.table("env")? {
            out.env_deny = env.field("deny", env_rules)?;
            out.env_passthrough = env.field("passthrough", env_rules)?;
            env.strict(&["deny", "passthrough"])?;
        }
        agents.strict(&[
            "shell",
            "max_launched",
            "max_launch_depth",
            "start_deadline_seconds",
            "env",
        ])?;
    }
    if let Some(terminals) = top.table("terminals")? {
        out.max_open = terminals.field("max_open", |v, p| int(v, p, 1, None))?;
        out.memory_max = terminals.field("memory_max", memory_max)?;
        out.total_memory_max = terminals.field("total_memory_max", memory_max)?;
        out.swap_max = terminals.field("swap_max", swap_max)?;
        out.history_lines = terminals.field("history_lines", |v, p| {
            int(v, p, 0, Some(i64::from(HOLDER_MAX_HISTORY_LINES)))
        })?;
        terminals.strict(&[
            "max_open",
            "memory_max",
            "total_memory_max",
            "swap_max",
            "history_lines",
        ])?;
    }
    if let Some(runtime) = top.table("runtime")? {
        out.default_runtime = runtime.field("default", |v, p| choice(v, p, &RUNTIMES))?;
        runtime.strict(&["default"])?;
    }
    if let Some(web) = top.table("web")? {
        out.external_origins = web.field("external_origins", origins)?;
        out.allow_insecure_origins = web.field("allow_insecure_origins", boolean)?;
        out.pairing = web.field("pairing", |v, p| choice(v, p, &PAIRINGS))?;
        out.listen = web.field("listen", |v, p| choice(v, p, &LISTENS))?;
        out.lan_port = web.field("lan_port", port)?;
        out.lan_allow = web.field("lan_allow", lan_allow)?;
        web.strict(&[
            "external_origins",
            "allow_insecure_origins",
            "pairing",
            "listen",
            "lan_port",
            "lan_allow",
        ])?;
    }
    top.strict(&[
        "daemon",
        "bank",
        "notifications",
        "shells",
        "agents",
        "terminals",
        "runtime",
        "web",
    ])?;
    Ok(out)
}
