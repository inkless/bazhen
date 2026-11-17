//! The command line: words, and the options any verb may be given, each spelled exactly, long only.
//! Which verb takes which option is the verb's to check, so a misplaced one gets a message that
//! says where it belongs.

use std::ffi::OsString;

use clap::parser::ValueSource;
use clap::{Arg, ArgAction, ArgMatches, Command};

/// The options that take a value.
const VALUED: [&str; 15] = [
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
    /// The words that aren't options, in order, each with its place on the command line.
    words: Vec<(usize, String)>,
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
        .indices_of("words")
        .into_iter()
        .flatten()
        .zip(matches.get_many::<String>("words").into_iter().flatten())
        .map(|(at, word)| (at, word.clone()))
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
        self.words.get(n).map(|(_, w)| w.as_str())
    }

    /// The words from `n` on.
    pub(crate) fn words_from(&self, n: usize) -> Vec<&str> {
        self.words.iter().skip(n).map(|(_, w)| w.as_str()).collect()
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

    /// Where option `name` was given.
    pub(crate) fn place(&self, name: &str) -> Option<usize> {
        self.options
            .iter()
            .find(|(n, _, _)| *n == name)
            .map(|&(_, _, at)| at)
    }

    /// Where the word at `n` was given.
    pub(crate) fn word_place(&self, n: usize) -> Option<usize> {
        self.words.get(n).map(|&(at, _)| at)
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
        let p = parse_line(&["send", "--wait", "a", "hi", "--timeout=10", "there"]).unwrap();
        assert_eq!(p.words_from(0), ["send", "a", "hi", "there"]);
        assert_eq!(p.value("timeout"), Some("10"));
        assert!(p.has("wait"));
        assert_eq!(p.given().collect::<Vec<_>>(), ["wait", "timeout"]);
        assert!(p.place("wait") < p.word_place(1));
    }

    #[test]
    fn refuses_an_option_it_doesnt_know_a_prefix_a_short_one_and_help() {
        for line in [
            &["task", "list", "--everything"][..],
            &["task", "create", "--tit", "t"],
            &["status", "-h"],
            &["status", "--help"],
            &["status", "--version"],
        ] {
            assert!(parse_line(line).is_err(), "{line:?}");
        }
        let error = parse_line(&["task", "list", "--everything"]).unwrap_err();
        assert!(error.0.contains("--everything"), "{}", error.0);
    }

    #[test]
    fn keeps_the_last_value_of_an_option_given_twice() {
        let p = parse_line(&["task", "--title", "a", "--title", "b"]).unwrap();
        assert_eq!(p.value("title"), Some("b"));
    }

    #[test]
    fn reads_everything_after_a_double_dash_as_words() {
        let p = parse_line(&["send", "a", "--", "--all", "-x"]).unwrap();
        assert_eq!(p.words_from(1), ["a", "--all", "-x"]);
        assert!(!p.has("all"));
    }
}
