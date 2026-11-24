//! The crate against what `moon run :schema` records of packages/core and of the TypeScript
//! daemon's role files (packages/protocol/fixtures/core/ and fixtures/roles/): every machine's
//! every state and event, every command offered, every mail label, every resolution of role files
//! and every role file's text, each with the same answer in the same words. A fixture file no test
//! here reads fails.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use bazhen_core::agent::{self, AgentEvent};
use bazhen_core::mail::{self, MailboxEvent, leading_mail_id, mail_label, quote_labels};
use bazhen_core::role_file::{SYNTAX, parse_role};
use bazhen_core::roles::{UserRole, resolve_roles};
use bazhen_core::{attention, machine::InvalidTransition};
use bazhen_protocol::agents::AgentState;
use bazhen_protocol::mail::{AttentionCloseReason, AttentionState, MailboxState};
use bazhen_protocol::roles::{RoleDefinition, RoleProblem, RoleSource};
use bazhen_protocol::shells::TerminalState;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, String>;

fn dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures")
        .join(name)
}

fn read(name: &str, file: &str) -> Result<Value> {
    let text = fs::read_to_string(dir(name).join(file)).map_err(|e| format!("{file}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{file}: {e}"))
}

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|e| format!("{value}: {e}"))
}

fn rows<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    value[key]
        .as_array()
        .ok_or_else(|| format!("no {key} array"))
}

fn str_of<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("{value}: no {key}"))
}

/// Where a machine's table says each event leads, or the words refusing it.
fn expected(event: &Value) -> Result<std::result::Result<String, String>> {
    match (event["to"].as_str(), event["refused"].as_str()) {
        (Some(to), None) => Ok(Ok(to.to_owned())),
        (None, Some(refused)) => Ok(Err(refused.to_owned())),
        _ => Err(format!("{event}: neither to nor refused")),
    }
}

fn answer<S: serde::Serialize>(
    got: std::result::Result<S, InvalidTransition>,
) -> Result<std::result::Result<String, String>> {
    Ok(match got {
        Ok(state) => Ok(str_of(&json!({ "s": state }), "s")?.to_owned()),
        Err(refused) => Err(refused.to_string()),
    })
}

/// The one of `all` named `name`.
fn by_name<T: Copy>(all: &[T], as_str: fn(T) -> &'static str, name: &str) -> Result<T> {
    all.iter()
        .copied()
        .find(|t| as_str(*t) == name)
        .ok_or_else(|| format!("no event {name}"))
}

/// Checks a machine's rows: the events each lists are `events`, and each state leads where
/// packages/core's does, and is final where it is.
fn check_machine<S: DeserializeOwned + Copy>(
    rows: &[Value],
    events: &[&str],
    next: impl Fn(S, &str) -> Result<std::result::Result<String, String>>,
    is_final: impl Fn(S) -> bool,
) -> Result<()> {
    let mut events = events.to_vec();
    events.sort_unstable();
    for row in rows {
        let from: S = decode(&row["from"])?;
        let mut listed: Vec<&str> = rows_of(row)?
            .iter()
            .map(|e| str_of(e, "event"))
            .collect::<Result<_>>()?;
        listed.sort_unstable();
        assert_eq!(listed, events, "the events of {}", row["from"]);
        assert_eq!(
            Some(is_final(from)),
            row["final"].as_bool(),
            "{} final",
            row["from"]
        );
        for event in rows_of(row)? {
            assert_eq!(
                next(from, str_of(event, "event")?)?,
                expected(event)?,
                "{} on {}",
                row["from"],
                event["event"]
            );
        }
    }
    Ok(())
}

fn rows_of(row: &Value) -> Result<&Vec<Value>> {
    rows(row, "events")
}

#[test]
fn moves_each_machine_as_packages_core_does_and_refuses_in_its_words() -> Result<()> {
    let machines = read("core", "machines.json")?;
    let agent_events: Vec<&str> = AgentEvent::ALL.iter().map(|e| e.as_str()).collect();
    check_machine::<AgentState>(
        rows(&machines, "agent")?,
        &agent_events,
        |from, name| {
            let event = by_name(&AgentEvent::ALL, AgentEvent::as_str, name)?;
            answer(agent::next(from, event))
        },
        agent::is_final,
    )?;
    let mail_events: Vec<&str> = MailboxEvent::ALL.iter().map(|e| e.as_str()).collect();
    check_machine::<MailboxState>(
        rows(&machines, "mailbox")?,
        &mail_events,
        |from, name| {
            let event = by_name(&MailboxEvent::ALL, MailboxEvent::as_str, name)?;
            answer(mail::next(from, event))
        },
        mail::is_final,
    )?;
    let reasons: Vec<&str> = AttentionCloseReason::ALL
        .iter()
        .map(|r| r.as_str())
        .collect();
    check_machine::<AttentionState>(
        rows(&machines, "attention")?,
        &reasons,
        |from, name| {
            let reason = by_name(
                &AttentionCloseReason::ALL,
                AttentionCloseReason::as_str,
                name,
            )?;
            answer(attention::next(from, reason))
        },
        |from| !attention::accepts(from),
    )
}

#[test]
fn offers_the_commands_packages_core_offers_in_every_state() -> Result<()> {
    let rows = read("core", "commands.json")?;
    let rows = rows.as_array().ok_or("commands.json isn't a list")?;
    assert_ne!(rows.len(), 0);
    for row in rows {
        let state: AgentState = decode(&row["state"])?;
        let terminal: Option<TerminalState> = decode(&row["terminalState"])?;
        let generation: Option<u64> = decode(&row["generation"])?;
        let resumes = row["resumes"].as_bool().ok_or("no resumes")?;
        assert_eq!(
            json!(agent::agent_commands(state, terminal)),
            row["commands"],
            "{row}"
        );
        let offered = agent::offered_commands(state, terminal, generation, || resumes);
        assert_eq!(json!(offered), row["offered"], "{row}");
    }
    Ok(())
}

#[test]
fn labels_quotes_and_reads_mail_as_packages_core_does() -> Result<()> {
    let fixture = read("core", "mail.json")?;
    for case in rows(&fixture, "labels")? {
        assert_eq!(mail_label(str_of(case, "id")?), str_of(case, "label")?);
    }
    for case in rows(&fixture, "quoted")? {
        assert_eq!(quote_labels(str_of(case, "body")?), str_of(case, "quoted")?);
    }
    for case in rows(&fixture, "leading")? {
        assert_eq!(
            leading_mail_id(str_of(case, "text")?),
            case["id"].as_str(),
            "{case}"
        );
    }
    Ok(())
}

#[test]
fn resolves_role_files_as_packages_core_does() -> Result<()> {
    let fixture = read("core", "roles.json")?;
    let builtins: Vec<RoleDefinition> = decode(&fixture["builtins"])?;
    for case in rows(&fixture, "cases")? {
        let user: Vec<UserRole> = rows(case, "user")?
            .iter()
            .map(|u| {
                Ok(UserRole {
                    file: str_of(u, "file")?.to_owned(),
                    role: decode(&u["role"])?,
                })
            })
            .collect::<Result<_>>()?;
        let (book, problems) = resolve_roles(&builtins, &user);
        let roles: Vec<RoleDefinition> = decode(&case["roles"])?;
        let want: Vec<RoleProblem> = decode(&case["problems"])?;
        assert_eq!(
            (book.roles(), problems),
            (roles.as_slice(), want),
            "{}",
            case["name"]
        );
    }
    Ok(())
}

#[test]
fn reads_each_role_file_to_the_definition_or_the_problem_the_typescript_daemon_does() -> Result<()>
{
    let cases = read("roles", "cases.json")?;
    let cases = cases.as_array().ok_or("cases.json isn't a list")?;
    assert!(cases.len() > 50, "{} cases", cases.len());
    let mut wrong = Vec::new();
    for case in cases {
        let name = str_of(case, "name")?;
        let got = parse_role(
            str_of(case, "key")?,
            str_of(case, "text")?.as_bytes(),
            RoleSource::User,
        );
        let same = match (&got, case["problem"].as_str(), case["syntax"].as_bool()) {
            (Ok(role), None, None) => json!(role) == case["role"],
            (Err(problem), Some(_), Some(true)) => problem.starts_with(SYNTAX),
            (Err(problem), Some(want), None) => problem == want,
            _ => false,
        };
        if !same {
            wrong.push(format!(
                "{name}: {got:?}, where TypeScript gave {}",
                case["problem"]
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    Ok(())
}

#[test]
fn reads_the_built_in_role_files_as_the_typescript_daemon_does() -> Result<()> {
    let want: Vec<RoleDefinition> = decode(&read("roles", "builtins.json")?)?;
    let roles = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/daemon/roles");
    for role in &want {
        let key = role.key.as_str();
        let bytes = fs::read(roles.join(format!("{key}.md"))).map_err(|e| format!("{key}: {e}"))?;
        assert_eq!(
            parse_role(key, &bytes, RoleSource::Builtin).as_ref(),
            Ok(role),
            "{key}"
        );
    }
    Ok(())
}

#[test]
fn reads_every_fixture_file_it_is_given() -> Result<()> {
    for (name, read) in [
        (
            "core",
            ["commands.json", "machines.json", "mail.json", "roles.json"].as_slice(),
        ),
        ("roles", ["builtins.json", "cases.json"].as_slice()),
    ] {
        let files: BTreeSet<String> = fs::read_dir(dir(name))
            .map_err(|e| e.to_string())?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<std::io::Result<_>>()
            .map_err(|e| e.to_string())?;
        let read: BTreeSet<String> = read.iter().map(|&f| f.to_owned()).collect();
        assert_eq!(files, read, "fixtures/{name}/");
    }
    Ok(())
}
