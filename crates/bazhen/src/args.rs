//! The command line: words, and the options any verb may be given, each spelled exactly, long only.
//! Which verb takes which option is the verb's to check, so a misplaced one gets a message that
//! says where it belongs.

use std::ffi::OsString;

use clap::parser::ValueSource;
use clap::{Arg, ArgAction, ArgMatches, Command};

/// The options that take a value.
const VALUED: [&str; 17] = [
    "title",
    "brief",
    "brief-file",
    "file",
    "parent",
    "assign",
    "role",
    "note",
    "task",
    "launch",
    "dir",
    "name",
    "home",
    "port",
    "timeout",
    "after",
    "compact-window",
];

/// The options that are on or off.
const SWITCHES: [&str; 9] = [
    "all",
    "cascade",
    "json",
    "wait",
    "handoff",
    "direct",
    "force",
    "confirm-busy",
    "fresh",
];

/// What the command line said.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Parsed {
    /// The words that aren't options, in order.
    words: Vec<String>,
    /// Each option given, in the order it first came, with its value and its place.
    options: Vec<(&'static str, Option<String>, usize)>,
}

/// A command line that doesn't parse; the message says why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BadLine(pub(crate) String);

fn command() -> Command {
    let mut command = Command::new("bazhen")
        .no_binary_name(true)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .args_override_self(true)
        .arg(
            Arg::new("words")
                .num_args(0..)
                .action(ArgAction::Append)
                .value_parser(clap::value_parser!(String)),
        );
    for name in VALUED {
        command = command.arg(
            Arg::new(name)
                .long(name)
                .num_args(1)
                .action(ArgAction::Set)
                .value_parser(clap::value_parser!(String)),
        );
    }
    for name in SWITCHES {
        command = command.arg(Arg::new(name).long(name).action(ArgAction::SetTrue));
    }
    command
}

/// The words and options of `args`, the command line after `bazhen`.
pub(crate) fn parse(args: Vec<OsString>) -> Result<Parsed, BadLine> {
    let matches = command()
        .try_get_matches_from(args)
        .map_err(|e| BadLine(error_text(&e)))?;
    let words = matches
        .get_many::<String>("words")
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let mut options: Vec<(&'static str, Option<String>, usize)> = VALUED
        .iter()
        .chain(SWITCHES.iter())
        .filter_map(|&name| given(&matches, name))
        .collect();
    options.sort_by_key(|&(_, _, at)| at);
    Ok(Parsed { words, options })
}

fn given(
    matches: &ArgMatches,
    name: &'static str,
) -> Option<(&'static str, Option<String>, usize)> {
    if matches.value_source(name) != Some(ValueSource::CommandLine) {
        return None;
    }
    let at = matches.index_of(name)?;
    let value = VALUED
        .contains(&name)
        .then(|| matches.get_one::<String>(name).cloned())
        .flatten();
    Some((name, value, at))
}

/// clap's error as one line, without its own usage or tips.
fn error_text(error: &clap::Error) -> String {
    let text = error.to_string();
    let first = text.lines().next().unwrap_or_default();
    first.strip_prefix("error: ").unwrap_or(first).to_owned()
}

impl Parsed {
    /// The word at `n`, counting from the verb.
    pub(crate) fn word(&self, n: usize) -> Option<&str> {
        self.words.get(n).map(String::as_str)
    }

    /// The words from `n` on.
    pub(crate) fn words_from(&self, n: usize) -> Vec<&str> {
        self.words.iter().skip(n).map(String::as_str).collect()
    }

    /// The value of option `name`, if given.
    pub(crate) fn value(&self, name: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(n, _, _)| *n == name)
            .and_then(|(_, v, _)| v.as_deref())
    }

    /// Whether option `name` was given.
    pub(crate) fn has(&self, name: &str) -> bool {
        self.options.iter().any(|(n, _, _)| *n == name)
    }

    /// The command line without its first `n` words, as a verb under a namespace reads it.
    pub(crate) fn skip(&self, n: usize) -> Self {
        Self {
            words: self.words.iter().skip(n).cloned().collect(),
            options: self.options.clone(),
        }
    }

    /// The options given, in the order they came.
    pub(crate) fn given(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.options.iter().map(|&(n, _, _)| n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_line(line: &[&str]) -> Result<Parsed, BadLine> {
        parse(line.iter().map(OsString::from).collect())
    }

    #[test]
    fn reads_options_anywhere_among_the_words_and_an_inline_value() {
        let p = parse_line(&[
            "agents",
            "send",
            "--wait",
            "a",
            "hi",
            "--timeout=10",
            "there",
        ])
        .unwrap();
        assert_eq!(p.words_from(0), ["agents", "send", "a", "hi", "there"]);
        assert_eq!(p.value("timeout"), Some("10"));
        assert!(p.has("wait"));
        assert_eq!(p.given().collect::<Vec<_>>(), ["wait", "timeout"]);
    }

    #[test]
    fn refuses_an_option_it_doesnt_know_a_prefix_a_short_one_and_help() {
        for line in [
            &["tasks", "list", "--everything"][..],
            &["tasks", "create", "--tit", "t"],
            &["status", "-h"],
            &["status", "--help"],
            &["status", "--version"],
        ] {
            assert!(parse_line(line).is_err(), "{line:?}");
        }
        let error = parse_line(&["tasks", "list", "--everything"]).unwrap_err();
        assert!(error.0.contains("--everything"), "{}", error.0);
    }

    #[test]
    fn keeps_the_last_value_of_an_option_given_twice() {
        let p = parse_line(&["tasks", "--title", "a", "--title", "b"]).unwrap();
        assert_eq!(p.value("title"), Some("b"));
    }

    #[test]
    fn reads_everything_after_a_double_dash_as_words() {
        let p = parse_line(&["agents", "send", "a", "--", "--all", "-x"]).unwrap();
        assert_eq!(p.words_from(2), ["a", "--all", "-x"]);
        assert!(!p.has("all"));
    }
}
