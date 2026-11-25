//! The lift, over a store holding the tasks a verb or a close left stranded.

use super::*;

#[test]
fn passes_until_one_does_nothing_and_says_so_or_stops_at_its_bound() {
    let mut calls = 0;
    let ended = passes(5, || {
        calls += 1;
        Ok::<_, ()>(calls < 3)
    });
    let mut forever = 0;
    let outran = passes(4, || {
        forever += 1;
        Ok::<_, ()>(true)
    });
    assert_eq!((ended, calls, outran, forever), (Ok(true), 3, Ok(false), 4));
}

mod properties {
    use bazhen_harness::Delivery;
    use bazhen_protocol::agents::HarnessId;
    use proptest::prelude::*;

    use super::super::lift_stranded;
    use crate::mail::tests::taking;
    use crate::testing::TempDir;
    use crate::testing::stub_harness::StubHarness;

    /// A task as drawn: which earlier task it is under, who owns it (0 the human), which of its
    /// parent's assignments it was delegated under, and its own assignments, each an agent and
    /// whether it ended.
    type Drawn = (Option<u8>, u8, Option<u8>, Vec<(u8, bool)>);

    fn drawn() -> impl Strategy<Value = Drawn> {
        (
            proptest::option::of(any::<u8>()),
            0u8..4,
            proptest::option::of(any::<u8>()),
            proptest::collection::vec((1u8..4, any::<bool>()), 0..3),
        )
    }

    fn agent(n: u8) -> String {
        format!("agent_0190a1b2c3d47abc8def0123456789a{n}")
    }

    fn task(n: usize) -> String {
        format!("task_0190a1b2c3d47abc8def0123456789b{n}")
    }

    fn asgn(task: usize, n: usize) -> String {
        format!("asgn_0190a1b2c3d47abc8def012345678{task}c{n}")
    }

    fn text(value: Option<String>) -> String {
        value.map_or_else(|| "NULL".to_owned(), |v| format!("'{v}'"))
    }

    /// The rows a tree of `tasks` leaves, as tasks are made: a subtask's delegation names one of
    /// its parent's assignments, and a task with no parent has none. Agents `closed` are gone.
    fn rows(tasks: &[Drawn], closed: [bool; 3]) -> String {
        let mut sql: Vec<String> = Vec::new();
        for _ in 0..20 {
            sql.push(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                 SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{}' FROM host;"
                    .to_owned(),
            );
        }
        sql.push(
            "INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);"
                .to_owned(),
        );
        for (n, gone) in (1u8..=3).zip(closed) {
            let state = if gone { "closed" } else { "running" };
            sql.push(format!(
                "INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id)
                 VALUES ('{}', 'env_local', 'claude-code', 'p', '/', '{state}', 1, 1);",
                agent(n)
            ));
        }
        for (i, (parent, owner, from, held)) in tasks.iter().enumerate() {
            let parent = (i > 0)
                .then_some(())
                .and(*parent)
                .map(|p| usize::from(p) % i);
            let from = match (parent, *owner, from) {
                (Some(p), 1.., Some(pick)) if !tasks[p].3.is_empty() => {
                    Some(asgn(p, usize::from(*pick) % tasks[p].3.len()))
                }
                _ => None,
            };
            sql.push(format!(
                "INSERT INTO tasks (id, title, brief, state, owner_agent_id, parent_task_id,
                   delegated_from, created_event_id, updated_event_id)
                 VALUES ('{}', 'T', 'b', 'open', {}, {}, NULL, {e}, {e});",
                task(i),
                text((*owner > 0).then(|| agent(*owner))),
                text(parent.map(task)),
                e = i + 1,
            ));
            for (j, (by, ended)) in held.iter().enumerate() {
                sql.push(format!(
                    "INSERT INTO assignments (id, task_id, agent_session_id, role, state,
                       end_reason, created_event_id, updated_event_id)
                     VALUES ('{}', '{}', '{}', 'lead', '{}', {}, 10, 10);",
                    asgn(i, j),
                    task(i),
                    agent(*by),
                    if *ended { "ended" } else { "active" },
                    if *ended { "'unassigned'" } else { "NULL" },
                ));
            }
            if let Some(from) = from {
                sql.push(format!(
                    "UPDATE tasks SET delegated_from = '{from}' WHERE id = '{}';",
                    task(i)
                ));
            }
        }
        sql.concat()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        /// However a tree of tasks was left stranded, the lift ends within its bound and leaves
        /// no subtask stranded.
        #[test]
        fn lifting_ends_and_leaves_nothing_stranded(
            tasks in proptest::collection::vec(drawn(), 1..7),
            closed in any::<[bool; 3]>(),
        ) {
            let dir = TempDir::new("lift");
            let mut store = bazhen_store::Store::open(&dir.path().join("bazhen.db")).unwrap();
            let harnesses = StubHarness::new(taking(Delivery::Pull)).served_as(HarnessId::ClaudeCode);
            let sql = rows(&tasks, closed);
            let lifted = store
                .write(|w| {
                    w.connection().execute_batch(&sql)?;
                    let mut queued = Vec::new();
                    lift_stranded(w, &harnesses, &mut queued)
                })
                .unwrap();
            prop_assert!(!lifted.outran);
            prop_assert_eq!(store.reads().stranded().unwrap(), Vec::new());
        }
    }
}
