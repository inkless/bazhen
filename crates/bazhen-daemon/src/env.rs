//! What the daemon is given of the environment `bazhen start` ran in (`@bazhen/core`'s
//! `filterEnv`, and `handOff` in `env/capture.ts`): the user's, minus what no agent may inherit,
//! plus Bazhen's own settings.

use std::collections::BTreeMap;
use std::ffi::OsString;

use bazhen_protocol::record::Record;
use serde::{Deserialize, Serialize};

pub(crate) use crate::config::EnvRules;

/// What an agent must not inherit. Everything else is kept, so agents see what a new terminal tab
/// would. Harness session variables are listed by name, so the user's own harness configuration
/// passes through. A trailing `*` matches a prefix.
pub(crate) const ENV_DENYLIST: &[&str] = &[
    // Bazhen and tmux: Bazhen sets its own afresh for each agent.
    "BAZHEN_*",
    "TMUX",
    "TMUX_PANE",
    // Harness sessions: a nested harness would believe it runs inside its parent, or send its
    // messages to the parent's socket.
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_ENV_FILE",
    "CLAUDE_PROJECT_DIR",
    "AI_AGENT",
    "CODEX_THREAD_ID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    // Terminal presentation: tmux sets its own, and a foreign value cost Codex its true colour.
    "TERM",
    "TERMINFO",
    "TERM_PROGRAM*",
    "TERM_SESSION_ID",
    "COLORTERM",
    "FORCE_COLOR",
    "NO_COLOR",
    "ITERM_*",
    "KITTY_*",
    "WEZTERM_*",
    "VSCODE_*",
    // Shell internals.
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
];

/// What `bazhen start` tells the daemon it removed: when, and how many per rule; never values.
const HANDOFF: &str = "BAZHEN_CAPTURE";

/// What Bazhen sets for each agent: started from inside one, the daemon must not carry it.
const PER_AGENT: [&str; 3] = ["BAZHEN_AGENT_ID", "BAZHEN_AGENT_AUTH_FILE", "BAZHEN_SOCKET"];

/// An environment, by name. A name or value needn't be UTF-8; each is passed on as it came.
pub(crate) type Env = BTreeMap<OsString, OsString>;

/// How many variables each denying rule removed, each rule where it first removed one, as a
/// JavaScript object keeps its keys.
pub(crate) type Removed = Vec<(String, u64)>;

fn tally(removed: &mut Removed, rule: &str, count: u64) {
    match removed.iter_mut().find(|(seen, _)| seen == rule) {
        Some((_, total)) => *total += count,
        None => removed.push((rule.to_owned(), count)),
    }
}

/// What filtering kept, and how many variables each denying rule removed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Filtered {
    pub(crate) env: Env,
    pub(crate) removed: Removed,
}

fn matches(name: &[u8], pattern: &str) -> bool {
    pattern.strip_suffix('*').map_or_else(
        || name == pattern.as_bytes(),
        |prefix| name.starts_with(prefix.as_bytes()),
    )
}

/// The rule that removes `name`: the user's denial first, then the denylist unless the user lets
/// it through.
fn denying<'a>(name: &[u8], rules: &'a EnvRules) -> Option<&'a str> {
    let user = |list: &'a [String]| list.iter().map(String::as_str).find(|p| matches(name, p));
    user(&rules.deny).or_else(|| match user(&rules.passthrough) {
        Some(_) => None,
        None => ENV_DENYLIST.iter().copied().find(|p| matches(name, p)),
    })
}

/// `source` without what no agent may inherit, by the denylist and the user's rules, counting
/// the removals in the order `source` lists its variables.
pub(crate) fn filter_env<'a>(
    source: impl IntoIterator<Item = (&'a OsString, &'a OsString)>,
    rules: &EnvRules,
) -> Filtered {
    let mut filtered = Filtered::default();
    for (name, value) in source {
        match denying(name.as_encoded_bytes(), rules) {
            None => {
                filtered.env.insert(name.clone(), value.clone());
            }
            Some(rule) => tally(&mut filtered.removed, rule, 1),
        }
    }
    filtered
}

/// The record `hand_off` leaves the daemon, and the only one `capture` takes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handoff {
    at: String,
    removed: Record<u64>,
}

/// The environment `bazhen start` gives the daemon: the user's, minus what no agent may inherit,
/// plus Bazhen's own settings, which the daemon reads and strips again before any agent sees
/// them, and a record of what was removed. So the daemon never holds a parent harness's session
/// variables or messaging socket.
pub(crate) fn hand_off(source: &Env, rules: &EnvRules, at: jiff::Timestamp) -> Env {
    let Filtered { mut env, removed } = filter_env(source, rules);
    for (name, value) in source {
        let bytes = name.as_encoded_bytes();
        let per_agent = PER_AGENT.iter().any(|p| p.as_bytes() == bytes);
        if bytes.starts_with(b"BAZHEN_") && !per_agent {
            env.insert(name.clone(), value.clone());
        }
    }
    let record = Handoff {
        at: format!("{at:.3}"),
        removed: Record::new(removed),
    };
    // A record of strings and counts always serializes; were it ever not to, the daemon counts
    // only its own removals, as with no record.
    if let Ok(record) = serde_json::to_string(&record) {
        env.insert(HANDOFF.into(), record.into());
    }
    env
}

/// What every terminal starts with, how many variables each denying rule removed, for `bazhen
/// doctor`, and when it was captured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Capture {
    pub(crate) env: Env,
    pub(crate) removed: Removed,
    pub(crate) at: String,
}

/// A rule as the config takes one: a variable's name, or a prefix of one ending in `*`.
fn is_rule(rule: &str) -> bool {
    let name = rule.strip_suffix('*').unwrap_or(rule);
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What `bazhen start` said it removed, when it is the record `hand_off` writes and nothing else,
/// its rules in the order it wrote them.
fn handoff(raw: Option<&OsString>) -> Option<(String, Removed)> {
    let record: Handoff = serde_json::from_str(raw?.to_str()?).ok()?;
    record.at.parse::<jiff::Timestamp>().ok()?;
    let removed = record.removed.entries();
    if !removed.iter().all(|(rule, _)| is_rule(rule)) {
        return None;
    }
    Some((record.at, removed.to_vec()))
}

/// The daemon's capture, once at start, counting what `bazhen start` removed before it existed
/// (`capture` in `env/capture.ts`). `source` is the environment in the order the process was
/// given it, which is the order its removals are counted in.
pub(crate) fn capture(
    source: &[(OsString, OsString)],
    rules: &EnvRules,
    now: jiff::Timestamp,
) -> Capture {
    let Filtered { env, mut removed } = filter_env(source.iter().map(|(n, v)| (n, v)), rules);
    let given = source
        .iter()
        .find(|(name, _)| name == HANDOFF)
        .map(|(_, value)| value);
    let Some((at, before)) = handoff(given) else {
        return Capture {
            env,
            removed,
            at: format!("{now:.3}"),
        };
    };
    // The BAZHEN_* the daemon removes here are its own settings, which start already counted.
    removed.retain(|(rule, _)| rule != "BAZHEN_*");
    for (rule, count) in before {
        tally(&mut removed, &rule, count);
    }
    Capture { env, removed, at }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_what_bazhen_start_removed_with_what_the_daemon_removes_but_not_its_own_settings() {
        let r = rules(&[], &[]);
        let handed = hand_off(
            &env(&[("TMUX", "/tmp/t"), ("TMUX_PANE", "%1"), ("HOME", "/h")]),
            &r,
            at(),
        );
        let mut given: Vec<_> = handed.into_iter().collect();
        given.push(("BAZHEN_HOME".into(), "/b".into()));
        let captured = capture(&given, &r, jiff::Timestamp::UNIX_EPOCH);
        assert_eq!(captured.at, "2026-11-12T10:00:00.000Z");
        assert_eq!(
            captured.removed,
            [("TMUX".to_owned(), 1), ("TMUX_PANE".to_owned(), 1)]
        );
        assert!(captured.env.contains_key(&OsString::from("HOME")));
        assert!(!captured.env.contains_key(&OsString::from("BAZHEN_HOME")));
    }

    #[test]
    fn captures_at_now_and_counts_only_its_own_removals_with_no_record_it_can_read() {
        let r = rules(&[], &[]);
        for record in [None, Some("{\"at\":\"then\",\"removed\":{}}"), Some("[]")] {
            let mut given = ordered(&[("TMUX", "/tmp/t"), ("BAZHEN_HOME", "/b")]);
            if let Some(record) = record {
                given.push((HANDOFF.into(), record.into()));
            }
            let captured = capture(&given, &r, at());
            // The record it couldn't read is one of Bazhen's own variables, removed with the rest.
            let bazhen = 1 + u64::from(record.is_some());
            assert_eq!(captured.at, "2026-11-12T10:00:00.000Z");
            assert_eq!(
                captured.removed,
                [("TMUX".to_owned(), 1), ("BAZHEN_*".to_owned(), bazhen)],
                "{record:?}"
            );
        }
    }

    #[test]
    fn counts_removals_in_the_order_it_found_them_and_then_those_bazhen_start_counted() {
        let record =
            r#"{"at":"2026-11-12T10:00:00.000Z","removed":{"TMUX_PANE":1,"TMUX":2,"AI_AGENT":1}}"#;
        let given = ordered(&[
            ("TMUX", "/tmp/t"),
            ("ITERM_PROFILE", "p"),
            ("CLAUDECODE", "1"),
            (HANDOFF, record),
        ]);
        let captured = capture(&given, &rules(&[], &[]), at());
        assert_eq!(
            captured.removed,
            [
                ("TMUX".to_owned(), 3),
                ("ITERM_*".to_owned(), 1),
                ("CLAUDECODE".to_owned(), 1),
                ("TMUX_PANE".to_owned(), 1),
                ("AI_AGENT".to_owned(), 1),
            ]
        );
    }

    /// The environment as a process is given it, in this order.
    fn ordered(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(n, v)| (OsString::from(n), OsString::from(v)))
            .collect()
    }

    fn rules(deny: &[&str], passthrough: &[&str]) -> EnvRules {
        let owned = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect();
        EnvRules {
            deny: owned(deny),
            passthrough: owned(passthrough),
        }
    }

    fn kept(source: &[(&str, &str)], r: &EnvRules) -> Env {
        filter_env(&env(source), r).env
    }

    #[test]
    fn keeps_the_users_own_variables_as_a_new_terminal_tab_would() {
        let own = [("GH_TOKEN", "t"), ("PATH", "/bin"), ("SSH_AUTH_SOCK", "/s")];
        assert_eq!(kept(&own, &EnvRules::default()), env(&own));
    }

    #[test]
    fn strips_harness_session_tmux_and_presentation_variables() {
        let stripped = [
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "s"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "/s"),
            ("TMUX", "/t"),
            ("TERM_PROGRAM_VERSION", "3"),
            ("FORCE_COLOR", "1"),
            ("BAZHEN_AGENT_ID", "agent_x"),
            ("SHLVL", "2"),
            // What Claude Code sets for its children that names its own session or paths.
            ("CLAUDE_CODE_SESSION_ATTENDED", "x"),
            ("CLAUDE_CODE_EXECPATH", "x"),
            ("CLAUDE_ENV_FILE", "x"),
            ("CLAUDE_PROJECT_DIR", "x"),
            ("AI_AGENT", "x"),
        ];
        assert_eq!(kept(&stripped, &EnvRules::default()), Env::new());
    }

    #[test]
    fn keeps_the_users_harness_configuration_while_stripping_harness_session_variables() {
        assert_eq!(
            kept(
                &[
                    ("CODEX_HOME", "/h"),
                    ("CODEX_THREAD_ID", "t"),
                    ("CLAUDE_CODE_USE_BEDROCK", "1"),
                    ("CLAUDE_CODE_SESSION_ID", "s"),
                ],
                &EnvRules::default()
            ),
            env(&[("CODEX_HOME", "/h"), ("CLAUDE_CODE_USE_BEDROCK", "1")])
        );
    }

    #[test]
    fn counts_what_each_pattern_removed() {
        let source = env(&[
            ("ITERM_PROFILE", "1"),
            ("ITERM_SESSION_ID", "1"),
            ("TMUX", "/t"),
        ]);
        assert_eq!(
            filter_env(&source, &EnvRules::default()).removed,
            [("ITERM_*".to_owned(), 2), ("TMUX".to_owned(), 1)]
        );
    }

    #[test]
    fn applies_the_users_rules_and_their_denial_wins_over_a_passthrough() {
        assert_eq!(
            [
                kept(
                    &[("MY_SECRET", "s"), ("TERM_PROGRAM", "kitty")],
                    &rules(&["MY_*"], &["TERM_PROGRAM"])
                ),
                kept(
                    &[("CODEX_HOME", "/h")],
                    &rules(&["CODEX_HOME"], &["CODEX_HOME"])
                ),
            ],
            [env(&[("TERM_PROGRAM", "kitty")]), Env::new()]
        );
    }

    const SHELL: [(&str, &str); 10] = [
        ("HOME", "/home/u"),
        ("GH_TOKEN", "t"),
        ("CLAUDECODE", "1"),
        ("TMUX", "/tmp/tmux-1/default,1,0"),
        ("BAZHEN_HOME", "/b"),
        ("BAZHEN_AGENT_ID", "agent_parent"),
        ("BAZHEN_AGENT_AUTH_FILE", "/run/b/agents/agent_parent.token"),
        ("BAZHEN_SOCKET", "/tmp/parent.sock"),
        ("SECRET_KEY", "s"),
        ("TERM", "xterm-256color"),
    ];

    fn at() -> jiff::Timestamp {
        "2026-11-12T10:00:00Z".parse().unwrap()
    }

    #[test]
    fn hands_off_the_users_variables_and_bazhens_settings_but_no_parent_agents_internals() {
        let mut daemon = hand_off(&env(&SHELL), &EnvRules::default(), at());
        let record = daemon.remove(&OsString::from(HANDOFF)).unwrap();
        assert_eq!(
            daemon,
            env(&[
                ("HOME", "/home/u"),
                ("GH_TOKEN", "t"),
                ("SECRET_KEY", "s"),
                ("BAZHEN_HOME", "/b")
            ])
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(record.to_str().unwrap()).unwrap(),
            serde_json::json!({
                "at": "2026-11-12T10:00:00.000Z",
                "removed": { "BAZHEN_*": 4, "CLAUDECODE": 1, "TMUX": 1, "TERM": 1 },
            })
        );
    }

    #[test]
    fn hands_off_under_the_configured_deny_and_passthrough_rules() {
        let mut daemon = hand_off(&env(&SHELL), &rules(&["SECRET_*"], &["TERM"]), at());
        daemon.remove(&OsString::from(HANDOFF));
        assert_eq!(
            daemon,
            env(&[
                ("HOME", "/home/u"),
                ("GH_TOKEN", "t"),
                ("TERM", "xterm-256color"),
                ("BAZHEN_HOME", "/b")
            ])
        );
    }
}
