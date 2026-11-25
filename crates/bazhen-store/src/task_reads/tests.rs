//! The task reads, each over rows laid down as the projections leave them.

use bazhen_protocol::names::Role;
use bazhen_protocol::tasks::{AssignmentEndReason, AssignmentState};

use super::*;
use crate::Store;
use crate::testing::TempDir;

pub(crate) fn agent(n: u8) -> AgentId {
    AgentId::parse(&format!("agent_0190a1b2c3d47abc8def0123456789a{n}")).unwrap()
}

pub(crate) fn task(n: u8) -> TaskId {
    TaskId::parse(&format!("task_0190a1b2c3d47abc8def0123456789b{n}")).unwrap()
}

pub(crate) fn asgn(n: u8) -> AssignmentId {
    AssignmentId::parse(&format!("asgn_0190a1b2c3d47abc8def0123456789c{n}")).unwrap()
}

fn text(id: Option<String>) -> String {
    id.map_or_else(|| "NULL".to_owned(), |id| format!("'{id}'"))
}

/// A row to lay down, as a projection would leave it.
pub(crate) enum Row {
    /// A task: its number, state, owner, parent and the assignment it was delegated under, made
    /// at the event its number names.
    Task(u8, &'static str, Option<u8>, Option<u8>, Option<u8>, u8),
    /// An assignment: its number, task, agent, role, parent, end reason if it ended, and the
    /// event that made it.
    Asgn(
        u8,
        u8,
        u8,
        &'static str,
        Option<u8>,
        Option<&'static str>,
        u8,
    ),
    /// A note: its event, task, author, the author's role, text and whether it is a handoff.
    Note(u8, u8, Option<u8>, Option<&'static str>, &'static str, bool),
}

fn sql(row: &Row) -> String {
    match *row {
        Row::Task(n, state, owner, parent, from, event) => format!(
            "INSERT INTO tasks (id, title, brief, state, owner_agent_id, parent_task_id, note,
               delegated_from, created_event_id, updated_event_id)
             VALUES ('{}', 'T{n}', 'brief {n}', '{state}', {}, {}, {}, {}, {event}, {event});",
            task(n),
            text(owner.map(|a| agent(a).to_string())),
            text(parent.map(|t| task(t).to_string())),
            text((state != "open").then(|| format!("note {n}"))),
            text(from.map(|a| asgn(a).to_string())),
        ),
        Row::Asgn(n, on, by, role, parent, ended, event) => format!(
            "INSERT INTO assignments (id, task_id, agent_session_id, role, parent_assignment_id,
               state, end_reason, created_event_id, updated_event_id)
             VALUES ('{}', '{}', '{}', '{role}', {}, '{}', {}, {event}, {event});",
            asgn(n),
            task(on),
            agent(by),
            text(parent.map(|a| asgn(a).to_string())),
            if ended.is_some() { "ended" } else { "active" },
            text(ended.map(str::to_owned)),
        ),
        Row::Note(event, on, by, role, words, handoff) => format!(
            "INSERT INTO task_notes (event_id, task_id, agent_session_id, author_role, text,
               handoff)
             VALUES ({event}, '{}', {}, {}, '{words}', {});",
            task(on),
            text(by.map(|a| agent(a).to_string())),
            text(role.map(str::to_owned)),
            i32::from(handoff),
        ),
    }
}

/// A store holding agents 1 to 4, twenty events, and `rows` in their order.
pub(crate) fn holding(rows: &[Row]) -> (TempDir, Store) {
    let dir = TempDir::new("task-reads");
    let store = Store::open(&dir.db("tasks.db")).unwrap();
    let event = "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
           SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{}' FROM host;";
    let agents = (1..=4).map(|n| {
        format!(
            "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
               created_event_id, updated_event_id)
             VALUES ('{}', 'env_local', 'claude-code', 'p', '/', 'running', 1, 1);",
            agent(n)
        )
    });
    let all: Vec<String> = std::iter::repeat_n(event.to_owned(), 20)
        .chain(std::iter::once(
            "INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);"
                .to_owned(),
        ))
        .chain(agents)
        .chain(rows.iter().map(sql))
        .collect();
    store.db.execute_batch(&all.concat()).unwrap();
    (dir, store)
}

pub(crate) fn role(key: &str) -> Role {
    Role::parse(key).unwrap()
}

#[test]
fn reads_a_task_with_only_its_active_assignments_and_open_subtasks_and_none_for_no_task() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", Some(1), None, None, 1),
        Row::Asgn(1, 1, 2, "worker", None, None, 2),
        Row::Asgn(2, 1, 3, "reviewer", None, Some("unassigned"), 3),
        Row::Asgn(3, 1, 4, "lead", Some(1), None, 4),
        Row::Task(2, "open", None, Some(1), None, 5),
        Row::Task(3, "done", None, Some(1), None, 6),
    ]);
    let view = store.reads().task_view(&task(1)).unwrap();
    assert_eq!(
        view,
        Some(TaskView {
            state: TaskState::Open,
            owner_agent_id: Some(agent(1)),
            owner_holds: true,
            active: vec![
                ActiveAssignment {
                    id: asgn(1),
                    agent_id: agent(2),
                    role: role("worker"),
                    parent_assignment_id: None,
                },
                ActiveAssignment {
                    id: asgn(3),
                    agent_id: agent(4),
                    role: role("lead"),
                    parent_assignment_id: Some(asgn(1)),
                },
            ],
            open_subtasks: vec![task(2)],
        })
    );
    assert_eq!(store.reads().task_view(&task(9)).unwrap(), None);
}

#[test]
fn strands_an_open_subtask_whose_delegating_assignment_ended_or_whose_parent_changed_owner() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", Some(1), None, None, 1),
        Row::Asgn(1, 1, 2, "lead", None, None, 2),
        Row::Asgn(2, 1, 3, "lead", None, Some("unassigned"), 3),
        // Delegated under an active assignment: held.
        Row::Task(2, "open", Some(2), Some(1), Some(1), 4),
        // Delegated under one that ended: stranded.
        Row::Task(3, "open", Some(3), Some(1), Some(2), 5),
        // Delegated as the parent's owner, which it still is: held.
        Row::Task(4, "open", Some(1), Some(1), None, 6),
        // Delegated as the parent's owner, which it no longer is: stranded.
        Row::Task(5, "open", Some(4), Some(1), None, 7),
        // The human's subtask, and a finished one, are never stranded.
        Row::Task(6, "open", None, Some(1), None, 8),
        Row::Task(7, "done", Some(3), Some(1), Some(2), 9),
    ]);
    let holds = (2..=7).map(|n| {
        store
            .reads()
            .task_view(&task(n))
            .unwrap()
            .unwrap()
            .owner_holds
    });
    assert_eq!(
        holds.collect::<Vec<_>>(),
        [true, false, true, false, true, true]
    );
    let moves_to = Stranded {
        task_id: task(3),
        owner_agent_id: Some(agent(1)),
        delegated_from: None,
    };
    assert_eq!(
        store.reads().stranded().unwrap(),
        [
            moves_to.clone(),
            Stranded {
                task_id: task(5),
                ..moves_to
            }
        ]
    );
}

#[test]
fn moves_a_stranded_subtask_to_its_parents_owner_with_what_made_that_one_the_owner() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Asgn(1, 1, 1, "coordinator", None, None, 2),
        Row::Task(2, "open", Some(1), Some(1), Some(1), 3),
        Row::Asgn(2, 2, 2, "lead", None, Some("unassigned"), 4),
        Row::Task(3, "open", Some(2), Some(2), Some(2), 5),
    ]);
    assert_eq!(
        store.reads().stranded().unwrap(),
        [Stranded {
            task_id: task(3),
            owner_agent_id: Some(agent(1)),
            delegated_from: Some(asgn(1)),
        }]
    );
}

#[test]
fn reads_the_agents_an_assignment_was_granted_under_nearest_first_across_tasks() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Asgn(1, 1, 1, "coordinator", None, None, 2),
        Row::Asgn(2, 1, 2, "lead", Some(1), None, 3),
        Row::Task(2, "open", Some(2), Some(1), Some(2), 4),
        Row::Asgn(3, 2, 3, "worker", Some(2), None, 5),
    ]);
    assert_eq!(
        [3, 2, 1].map(|n| store.reads().granters(&asgn(n)).unwrap()),
        [vec![agent(2), agent(1)], vec![agent(1)], vec![]]
    );
}

#[test]
fn finds_each_active_assignment_under_others_however_deep_past_ended_ones() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Asgn(1, 1, 1, "coordinator", None, None, 2),
        Row::Asgn(2, 1, 2, "lead", Some(1), Some("unassigned"), 3),
        Row::Asgn(3, 1, 3, "worker", Some(2), None, 4),
        Row::Asgn(4, 1, 4, "reviewer", Some(1), None, 5),
        Row::Asgn(5, 1, 2, "worker", None, None, 6),
    ]);
    let ids = |under: &[AssignmentId]| -> Vec<AssignmentId> {
        let found = store.reads().active_under(under).unwrap();
        found.into_iter().map(|a| a.id).collect()
    };
    assert_eq!(
        [ids(&[asgn(1)]), ids(&[asgn(2), asgn(5)]), ids(&[])],
        [vec![asgn(3), asgn(4)], vec![asgn(3)], vec![]]
    );
}

#[test]
fn reads_the_owners_coordinators_and_leads_of_a_task_and_every_task_above_it() {
    // Agent 1 coordinates, 2 leads and 3 owns, each and nothing else; 4 is a worker, and a lead
    // no longer.
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Asgn(1, 1, 1, "coordinator", None, None, 2),
        Row::Asgn(2, 1, 4, "worker", None, None, 3),
        Row::Task(2, "open", Some(3), Some(1), Some(1), 4),
        Row::Asgn(3, 2, 2, "lead", Some(1), None, 5),
        Row::Asgn(4, 2, 4, "lead", Some(1), Some("unassigned"), 6),
        Row::Task(3, "open", Some(3), Some(2), Some(3), 7),
    ]);
    let mut above = store.reads().above_on_tree(&task(3)).unwrap();
    above.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    assert_eq!(above, [agent(1), agent(2), agent(3)]);
    assert_eq!(store.reads().above_on_tree(&task(1)).unwrap(), [agent(1)]);
}

#[test]
fn lists_a_tasks_open_subtasks_however_deep_the_deepest_first() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Task(2, "open", None, Some(1), None, 2),
        Row::Task(3, "cancelled", None, Some(1), None, 3),
        Row::Task(4, "open", None, Some(3), None, 4),
        Row::Task(5, "open", None, Some(2), None, 5),
        Row::Task(6, "open", None, Some(5), None, 6),
    ]);
    assert_eq!(
        store.reads().open_subtasks_under(&task(1)).unwrap(),
        [task(6), task(4), task(5), task(2)]
    );
}

#[test]
fn hands_on_the_latest_handoff_written_since_the_task_was_last_granted_and_no_other_note() {
    let rows = |granted: u8| {
        [
            Row::Task(1, "open", None, None, None, 1),
            Row::Note(3, 1, None, None, "before", true),
            Row::Asgn(1, 1, 1, "worker", None, Some("completed"), granted),
            Row::Note(5, 1, Some(1), Some("worker"), "first", true),
            Row::Note(6, 1, Some(1), Some("worker"), "latest", true),
            Row::Note(7, 1, Some(1), Some("worker"), "progress", false),
        ]
    };
    let (_dir, store) = holding(&rows(4));
    let handed = store.reads().pending_handoff(&task(1)).unwrap();
    assert_eq!(
        handed.map(|n| (n.event_id, n.text)),
        Some((6, "latest".to_owned()))
    );
    let (_again, regranted) = holding(&rows(8));
    assert_eq!(regranted.reads().pending_handoff(&task(1)).unwrap(), None);
}

#[test]
fn reads_a_task_in_full_with_every_assignment_its_subtasks_and_its_notes_oldest_first() {
    let (_dir, store) = holding(&[
        Row::Task(1, "done", Some(1), None, None, 1),
        Row::Asgn(1, 1, 2, "worker", None, Some("completed"), 2),
        Row::Asgn(2, 1, 3, "reviewer", None, None, 3),
        Row::Task(2, "open", Some(1), Some(1), None, 4),
        Row::Note(6, 1, None, None, "by hand", false),
        Row::Note(5, 1, Some(2), Some("worker"), "over to you", true),
    ]);
    let detail = store.reads().task_detail(&task(1)).unwrap().unwrap();
    let note_of = |n: &TaskNote| (n.event_id, n.agent_id.clone(), n.role.clone(), n.handoff);
    assert_eq!(
        (
            (detail.id, detail.title, detail.state, detail.owner_agent_id),
            (detail.parent_task_id, detail.brief, detail.note),
            detail
                .assignments
                .iter()
                .map(|a| (a.id.clone(), a.state, a.end_reason))
                .collect::<Vec<_>>(),
            detail
                .subtasks
                .iter()
                .map(|t| t.id.clone())
                .collect::<Vec<_>>(),
            detail.notes.iter().map(note_of).collect::<Vec<_>>(),
        ),
        (
            (task(1), "T1".to_owned(), TaskState::Done, Some(agent(1))),
            (None, "brief 1".to_owned(), Some("note 1".to_owned())),
            vec![
                (
                    asgn(1),
                    AssignmentState::Ended,
                    Some(AssignmentEndReason::Completed)
                ),
                (asgn(2), AssignmentState::Active, None),
            ],
            vec![task(2)],
            vec![
                (5, Some(agent(2)), Some(role("worker")), true),
                (6, None, None, false),
            ],
        )
    );
    assert_eq!(store.reads().task_detail(&task(9)).unwrap(), None);
}

#[test]
fn reads_an_agents_active_assignments_on_every_task_oldest_first() {
    let (_dir, store) = holding(&[
        Row::Task(1, "open", None, None, None, 1),
        Row::Task(2, "open", None, None, None, 2),
        Row::Asgn(1, 2, 1, "worker", None, None, 3),
        Row::Asgn(2, 1, 1, "lead", None, None, 4),
        Row::Asgn(3, 1, 2, "worker", None, None, 5),
        Row::Asgn(4, 2, 1, "reviewer", None, Some("unassigned"), 6),
    ]);
    let held = store.reads().active_assignments_of(&agent(1)).unwrap();
    assert_eq!(
        held.into_iter()
            .map(|a| (a.id, a.task_id))
            .collect::<Vec<_>>(),
        [(asgn(1), task(2)), (asgn(2), task(1))]
    );
}

#[test]
fn reads_a_task_in_full_only_in_a_transaction_of_its_own() {
    let (_dir, mut store) = holding(&[Row::Task(1, "open", None, None, None, 1)]);
    let inside = store
        .write(|w| Ok::<_, rusqlite::Error>(w.reads().task_detail(&task(1)).map(|_| ())))
        .unwrap();
    assert!(
        matches!(inside, Err(TaskReadError::Sqlite(_))),
        "{inside:?}"
    );
    assert!(store.reads().task_detail(&task(1)).unwrap().is_some());
}

#[test]
fn reads_a_task_in_full_inside_a_writers_transaction_as_the_writer_sees_it() {
    let (_dir, mut store) = holding(&[Row::Task(1, "open", None, None, None, 1)]);
    let title = store.write(|w| {
        w.connection().execute(
            "UPDATE tasks SET title = 'Renamed' WHERE id = ?",
            [task(1).as_str()],
        )?;
        Ok::<_, TaskReadError>(w.task_detail(&task(1))?.map(|t| t.title))
    });
    assert_eq!(
        title.map_err(|e| e.to_string()),
        Ok(Some("Renamed".to_owned()))
    );
}
