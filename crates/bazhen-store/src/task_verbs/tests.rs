//! The task verbs' writes, over rows laid down as the projections leave them.

use bazhen_core::task::Refusal;

use super::*;
use crate::task_reads::tests::{Row, agent, holding, role, task};

fn note(caller: Option<u8>, on: u8, key: &str, text: &str) -> NewNote {
    NewNote {
        caller: caller.map(agent),
        task: task(on),
        key: key.to_owned(),
        text: text.to_owned(),
        handoff: false,
    }
}

/// Task 1, open and owned by agent 1, with agent 2 its worker; task 2 done.
fn tasks() -> [Row; 3] {
    [
        Row::Task(1, "open", Some(1), None, None, 1),
        Row::Asgn(1, 1, 2, "worker", None, None, 2),
        Row::Task(2, "done", None, None, None, 3),
    ]
}

/// How the store refused the verb, or `None` when it didn't.
fn refusal<T>(done: Result<T, TaskVerbError>) -> Option<Refusal> {
    match done {
        Err(TaskVerbError::Refused(refused)) => Some(refused.refusal),
        _ => None,
    }
}

#[test]
fn notes_a_task_with_the_role_its_agent_holds_there_and_none_for_the_human_or_an_owner() {
    let (_dir, mut store) = holding(&tasks());
    let handoff = NewNote {
        handoff: true,
        ..note(Some(2), 1, "k1", "tests pass")
    };
    let answers = [
        store.note_task(&handoff).unwrap(),
        store.note_task(&note(None, 1, "k2", "looks good")).unwrap(),
        store.note_task(&note(Some(1), 1, "k3", "ship it")).unwrap(),
    ];
    let notes = store.reads().task_detail(&task(1)).unwrap().unwrap().notes;
    assert_eq!(
        notes
            .iter()
            .map(|n| (
                n.event_id,
                n.agent_id.clone(),
                n.role.clone(),
                n.text.as_str(),
                n.handoff
            ))
            .collect::<Vec<_>>(),
        [
            (
                answers[0].event_ids[0],
                Some(agent(2)),
                Some(role("worker")),
                "tests pass",
                true
            ),
            (answers[1].event_ids[0], None, None, "looks good", false),
            (
                answers[2].event_ids[0],
                Some(agent(1)),
                None,
                "ship it",
                false
            ),
        ]
    );
}

#[test]
fn refuses_a_note_from_an_agent_off_the_task_or_on_a_finished_one_and_records_nothing() {
    let (_dir, mut store) = holding(&tasks());
    let refused = [
        store.note_task(&note(Some(3), 1, "k1", "x")),
        store.note_task(&note(None, 2, "k2", "x")),
    ]
    .map(refusal);
    assert_eq!(refused, [Some(Refusal::Forbidden), Some(Refusal::Conflict)]);
    let noted: i64 = store
        .db
        .query_row("SELECT count(*) FROM task_notes", (), |row| row.get(0))
        .unwrap();
    assert_eq!(noted, 0);
}

#[test]
fn refuses_a_note_from_an_agent_that_cant_act_or_on_no_task() {
    let (_dir, mut store) = holding(&tasks());
    store
        .db
        .execute(
            "UPDATE agent_sessions SET state = 'closed' WHERE id = ?",
            [agent(2).as_str()],
        )
        .unwrap();
    assert_eq!(
        [
            store.note_task(&note(Some(2), 1, "k1", "x")),
            store.note_task(&note(None, 9, "k2", "x")),
        ]
        .map(|done| done.err().map(|err| err.to_string())),
        [
            Some(format!("no agent {} that is open", agent(2))),
            Some(format!("no task {}", task(9))),
        ]
    );
}

#[test]
fn answers_a_key_used_again_with_its_first_answer_and_refuses_it_for_another_note() {
    let (_dir, mut store) = holding(&tasks());
    let first = store.note_task(&note(None, 1, "k1", "once")).unwrap();
    assert_eq!(
        store.note_task(&note(None, 1, "k1", "once")).unwrap(),
        first
    );
    assert!(matches!(
        store.note_task(&note(None, 1, "k1", "twice")),
        Err(TaskVerbError::Once(OnceError::Conflict(key))) if key == "k1"
    ));
    assert_eq!(
        store
            .reads()
            .task_detail(&task(1))
            .unwrap()
            .unwrap()
            .notes
            .len(),
        1
    );
}
