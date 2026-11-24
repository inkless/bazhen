//! What holds over any sequence of events, any role files and any role file's bytes, as
//! packages/core's machine.property.test.ts holds it of the machines.

use std::collections::BTreeSet;

use bazhen_core::agent::{self, AgentEvent};
use bazhen_core::mail::{self, MailboxEvent};
use bazhen_core::role_file::{FILE_MAX, PROMPT_MAX, parse_role};
use bazhen_core::roles::{RoleBook, UserRole, resolve_roles};
use bazhen_protocol::agents::AgentState;
use bazhen_protocol::mail::MailboxState;
use bazhen_protocol::names::Role;
use bazhen_protocol::roles::{RoleDefinition, RoleSource};
use proptest::prelude::*;

fn agent_events() -> impl Strategy<Value = Vec<AgentEvent>> {
    prop::collection::vec(prop::sample::select(AgentEvent::ALL.to_vec()), 0..40)
}

fn mail_events() -> impl Strategy<Value = Vec<MailboxEvent>> {
    prop::collection::vec(prop::sample::select(MailboxEvent::ALL.to_vec()), 0..30)
}

/// Each state a walk from starting passes through, with the event that led to it.
fn walk(events: &[AgentEvent]) -> Vec<(AgentEvent, AgentState, AgentState)> {
    let mut state = AgentState::Starting;
    let mut steps = Vec::new();
    for &event in events {
        if let Ok(to) = agent::next(state, event) {
            steps.push((event, state, to));
            state = to;
        }
    }
    steps
}

/// A role file's text, which bytes at random almost never are: a title near the cap of 80, and a
/// prompt that is empty, blank, short, or near the cap of `PROMPT_MAX`.
fn role_text() -> impl Strategy<Value = Vec<u8>> {
    let prompt = prop_oneof![
        "[ \t\n]{0,3}".prop_map(String::from),
        "[ \n]{0,2}[a-z]{1,8}".prop_map(String::from),
        (PROMPT_MAX - 3..PROMPT_MAX + 3).prop_map(|n| "x".repeat(n)),
    ];
    ("[A-Za-z0-9]([A-Za-z0-9 ]{0,90}[A-Za-z0-9])?", prompt)
        .prop_map(|(title, prompt)| format!("---\ntitle: {title}\n---\n{prompt}").into_bytes())
}

proptest! {
    #[test]
    fn an_agent_takes_no_event_once_closed_or_failed(events in agent_events()) {
        for (_, from, _) in walk(&events) {
            prop_assert!(!from.ended());
        }
        for state in [AgentState::Closed, AgentState::Failed] {
            prop_assert!(agent::is_final(state));
        }
    }

    #[test]
    fn an_agent_is_lost_only_when_its_target_is_absent_or_a_relaunch_fails(
        events in agent_events(),
    ) {
        for (event, from, to) in walk(&events) {
            if to == AgentState::Lost && from != AgentState::Lost {
                prop_assert!(matches!(event, AgentEvent::TargetAbsent | AgentEvent::RelaunchRejected));
            }
        }
    }

    #[test]
    fn an_agent_runs_only_once_its_harness_has_shown_a_sign_since_it_last_started(
        events in agent_events(),
    ) {
        let mut signed = false;
        for (event, _, to) in walk(&events) {
            if to == AgentState::Starting {
                signed = false;
            }
            if event == AgentEvent::HarnessReady {
                signed = true;
            }
            prop_assert!(to != AgentState::Running || signed);
            prop_assert!(to != AgentState::Unknown || signed);
        }
    }

    #[test]
    fn an_agent_starts_again_only_when_asked_or_on_a_process_replaced_from_outside(
        events in agent_events(),
    ) {
        for (event, from, to) in walk(&events) {
            if to == AgentState::Starting && from != AgentState::Starting {
                prop_assert!(matches!(
                    event,
                    AgentEvent::RespawnRequested
                        | AgentEvent::RelaunchRequested
                        | AgentEvent::ProcessAdopted
                ));
            }
        }
    }

    #[test]
    fn a_message_is_delivered_only_on_a_confirm_given_up_only_by_cap_or_close_and_final_then(
        events in mail_events(),
    ) {
        let mut state = MailboxState::Queued;
        for event in events {
            let Ok(to) = mail::next(state, event) else { continue };
            prop_assert!(!mail::is_final(state));
            prop_assert!(to != MailboxState::Delivered || event == MailboxEvent::Confirm);
            prop_assert!(
                to != MailboxState::Undeliverable
                    || matches!(event, MailboxEvent::GiveUp | MailboxEvent::AgentClosed)
            );
            state = to;
        }
    }

    #[test]
    fn reads_any_bytes_without_panicking_and_keeps_only_what_a_role_may_be(
        bytes in prop_oneof![prop::collection::vec(any::<u8>(), 0..2048), role_text()],
    ) {
        if let Ok(role) = parse_role("tester", &bytes, RoleSource::User) {
            prop_assert!(role.title.chars().count() <= 80);
            prop_assert!(role.prompt.encode_utf16().count() <= PROMPT_MAX);
            prop_assert!(!role.prompt.is_empty());
        }
    }

    #[test]
    fn reads_any_front_matter_without_panicking(
        front in "[-a-zA-Z0-9 :\\[\\]{}'\",#&*!|>~.\n\t]{0,200}",
        body in "[a-z \n]{0,20}",
    ) {
        let text = format!("---\n{front}\n---\n{body}");
        prop_assert!(text.len() < FILE_MAX);
        if let Ok(role) = parse_role("tester", text.as_bytes(), RoleSource::User) {
            prop_assert!(!role.title.trim().is_empty());
        }
    }

    #[test]
    fn resolves_any_role_files_to_a_book_with_no_grant_undefined_and_no_way_back(
        grants in prop::collection::vec(prop::collection::vec(0..7_usize, 0..3), 0..6),
    ) {
        const KEYS: [&str; 7] = ["coordinator", "lead", "worker", "reviewer", "a", "b", "ghost"];
        let user: Vec<UserRole> = grants
            .iter()
            .enumerate()
            .filter_map(|(i, granted)| {
                let key = KEYS.get(i)?;
                let grants = granted.iter().filter_map(|&g| Role::parse(KEYS.get(g)?)).collect();
                Some(UserRole { file: format!("roles/{key}.md"), role: role(key, grants) })
            })
            .collect();
        let (book, problems) = resolve_roles(&builtins(), &user);
        for role in book.roles() {
            prop_assert!(role.grants.iter().all(|g| book.get(g).is_some()));
            if role.source == RoleSource::User {
                prop_assert!(!reaches(&book, &role.key));
            }
        }
        let skipped: BTreeSet<&str> = problems.iter().map(|p| p.file.as_str()).collect();
        prop_assert_eq!(skipped.len(), problems.len());
    }
}

fn role(key: &str, grants: Vec<Role>) -> RoleDefinition {
    RoleDefinition {
        key: Role::parse(key).unwrap_or_default(),
        title: key.to_owned(),
        description: String::new(),
        grants,
        single_per_task: false,
        max_active_tasks: None,
        prompt: format!("Be a {key}."),
        source: RoleSource::User,
    }
}

fn builtins() -> Vec<RoleDefinition> {
    let parse = |k: &str| Role::parse(k).unwrap_or_default();
    [
        ("coordinator", vec![parse("lead"), parse("worker")]),
        ("lead", vec![parse("worker")]),
        ("worker", vec![]),
        ("reviewer", vec![]),
    ]
    .into_iter()
    .map(|(key, grants)| RoleDefinition {
        source: RoleSource::Builtin,
        ..role(key, grants)
    })
    .collect()
}

/// Whether `key` can be granted back through the roles it grants.
fn reaches(book: &RoleBook, key: &Role) -> bool {
    let mut seen = BTreeSet::new();
    let mut frontier = vec![key.clone()];
    while let Some(at) = frontier.pop() {
        for granted in book.rules(&at).grants {
            if granted == key {
                return true;
            }
            if seen.insert(granted.as_str().to_owned()) {
                frontier.push(granted.clone());
            }
        }
    }
    false
}
