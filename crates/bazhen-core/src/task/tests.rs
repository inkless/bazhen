//! Who may do what to a task, as packages/core's task.test.ts has it, with its invariants over
//! any sequence of commands.

use std::sync::atomic::{AtomicU64, Ordering};

use bazhen_protocol::ids::{Id, Kind};
use bazhen_protocol::roles::{RoleDefinition, RoleSource};
use proptest::prelude::*;

use super::*;

fn id<K: Kind>() -> Id<K> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    Id::mint(NEXT.fetch_add(1, Ordering::Relaxed), [0; 16])
}

fn role(key: &str) -> Role {
    Role::parse(key).unwrap()
}

fn definition(key: &str, grants: &[&str], single: bool, most: Option<u64>) -> RoleDefinition {
    RoleDefinition {
        key: role(key),
        title: key.to_owned(),
        description: String::new(),
        grants: grants.iter().map(|g| role(g)).collect(),
        single_per_task: single,
        max_active_tasks: most,
        prompt: key.to_owned(),
        source: RoleSource::Builtin,
    }
}

fn roles() -> RoleBook {
    RoleBook::new(vec![
        definition("coordinator", &["lead", "worker", "reviewer"], true, None),
        definition("lead", &["worker", "reviewer"], true, None),
        definition("worker", &[], false, Some(1)),
        definition("reviewer", &[], false, None),
    ])
}

/// Four agents, the same in every call.
fn agents() -> [AgentId; 4] {
    [1, 2, 3, 4].map(|n| AgentId::mint(0, [n; 16]))
}

fn asgn(agent: &AgentId, key: &str, parent: Option<&AssignmentId>) -> ActiveAssignment {
    ActiveAssignment {
        id: id(),
        agent_id: agent.clone(),
        role: role(key),
        parent_assignment_id: parent.cloned(),
    }
}

fn open(active: Vec<ActiveAssignment>, owner: Option<&AgentId>) -> TaskView {
    TaskView {
        state: TaskState::Open,
        owner_agent_id: owner.cloned(),
        owner_holds: true,
        active,
        open_subtasks: Vec::new(),
    }
}

/// What a check answered, as the TS tests' `refusal` names it.
fn refusal<T>(checked: Result<T, TaskRefused>) -> &'static str {
    match checked.map_err(|refused| refused.refusal) {
        Ok(_) => "allowed",
        Err(Refusal::Forbidden) => "forbidden",
        Err(Refusal::Conflict) => "conflict",
    }
}

fn grant(
    view: &TaskView,
    caller: Caller<'_>,
    agent: &AgentId,
    key: &str,
    held: u64,
) -> &'static str {
    refusal(check_grant(view, caller, agent, &role(key), &roles(), held))
}

#[test]
fn lets_a_coordinator_grant_a_lead_a_worker_and_a_reviewer_but_never_another_coordinator() {
    let [a, b, ..] = agents();
    let coord = asgn(&a, "coordinator", None);
    let view = open(vec![coord.clone()], None);
    let granted = ["lead", "worker", "reviewer"]
        .map(|key| check_grant(&view, Some(&a), &b, &role(key), &roles(), 0));
    assert_eq!(granted, [0, 1, 2].map(|_| Ok(Some(coord.id.clone()))));
    assert_eq!(grant(&view, Some(&a), &b, "coordinator", 0), "forbidden");
}

#[test]
fn lets_a_lead_grant_no_lead_and_a_worker_nothing() {
    let [a, b, c, _] = agents();
    let view = open(vec![asgn(&a, "lead", None), asgn(&b, "worker", None)], None);
    assert_eq!(
        [
            grant(&view, Some(&a), &c, "worker", 0),
            grant(&view, Some(&a), &c, "lead", 0),
            grant(&view, Some(&b), &c, "worker", 0),
        ],
        ["allowed", "forbidden", "forbidden"]
    );
}

#[test]
fn lets_the_agent_that_created_a_task_grant_as_its_coordinator_would_from_no_assignment() {
    let [a, b, ..] = agents();
    let view = open(Vec::new(), Some(&a));
    assert_eq!(
        check_grant(&view, Some(&a), &b, &role("lead"), &roles(), 0),
        Ok(None)
    );
    assert_eq!(grant(&view, Some(&a), &b, "coordinator", 0), "forbidden");
}

#[test]
fn gives_an_owner_that_no_longer_holds_its_subtasks_authority_no_say_over_it() {
    let [a, b, ..] = agents();
    let view = TaskView {
        owner_holds: false,
        ..open(Vec::new(), Some(&a))
    };
    assert_eq!(
        [
            grant(&view, Some(&a), &b, "worker", 0),
            refusal(check_finish(
                &view,
                Some(&a),
                TaskOutcome::Cancelled,
                false,
                &roles()
            )),
        ],
        ["forbidden", "forbidden"]
    );
}

#[test]
fn refuses_a_second_lead_while_one_is_active_but_takes_any_number_of_workers() {
    let [a, b, c, _] = agents();
    let view = open(vec![asgn(&a, "lead", None), asgn(&b, "worker", None)], None);
    assert_eq!(
        [
            grant(&view, None, &c, "lead", 0),
            grant(&view, None, &c, "worker", 0)
        ],
        ["conflict", "allowed"]
    );
}

#[test]
fn refuses_to_assign_anyone_to_a_finished_task() {
    let [a, ..] = agents();
    let view = TaskView {
        state: TaskState::Done,
        ..open(Vec::new(), None)
    };
    assert_eq!(grant(&view, None, &a, "worker", 0), "conflict");
}

#[test]
fn refuses_an_agent_already_on_the_task_another_role() {
    let [a, ..] = agents();
    let view = open(vec![asgn(&a, "reviewer", None)], None);
    assert_eq!(grant(&view, None, &a, "worker", 0), "conflict");
}

#[test]
fn refuses_a_worker_a_second_task_the_most_a_worker_holds_and_limits_no_coordinator() {
    let [a, ..] = agents();
    let view = open(Vec::new(), None);
    assert_eq!(
        [
            grant(&view, None, &a, "worker", 0),
            grant(&view, None, &a, "worker", 1),
            grant(&view, None, &a, "coordinator", 9),
        ],
        ["allowed", "conflict", "allowed"]
    );
}

#[test]
fn hands_on_what_the_holders_definition_grants_not_what_the_builtin_would() {
    let [a, b, c, _] = agents();
    let flat = RoleBook::new(vec![
        definition("coordinator", &["worker"], false, None),
        definition("worker", &["worker2"], false, None),
        definition("worker2", &[], false, None),
    ]);
    let view = open(
        vec![asgn(&a, "coordinator", None), asgn(&b, "worker", None)],
        None,
    );
    let flat_grant = |caller: &AgentId, key: &str| {
        refusal(check_grant(&view, Some(caller), &c, &role(key), &flat, 0))
    };
    assert_eq!(
        [
            flat_grant(&a, "worker"),
            flat_grant(&b, "worker2"),
            flat_grant(&a, "worker2")
        ],
        ["allowed", "allowed", "forbidden"]
    );
}

#[test]
fn lets_nobody_grant_a_role_no_definition_has_the_human_included() {
    let [a, ..] = agents();
    assert_eq!(
        grant(&open(Vec::new(), None), None, &a, "auditor", 0),
        "forbidden"
    );
}

#[test]
fn leaves_an_assignment_whose_role_is_no_longer_defined_able_to_finish_only_its_own_part() {
    let [a, b, ..] = agents();
    let orphan = asgn(&a, "auditor", None);
    let view = open(vec![orphan.clone()], None);
    assert_eq!(grant(&view, Some(&a), &b, "worker", 0), "forbidden");
    assert_eq!(
        check_finish(&view, Some(&a), TaskOutcome::Done, false, &roles()),
        Ok(Finish::Assignment(&orphan))
    );
}

#[test]
fn makes_a_reviewers_done_complete_only_its_own_part_as_a_workers_does() {
    let [a, b, ..] = agents();
    let reviewer = asgn(&b, "reviewer", None);
    let view = open(vec![asgn(&a, "lead", None), reviewer.clone()], None);
    assert_eq!(
        check_finish(&view, Some(&b), TaskOutcome::Done, false, &roles()),
        Ok(Finish::Assignment(&reviewer))
    );
}

#[test]
fn refuses_a_worker_that_would_own_the_subtask_it_hands_on() {
    let [a, ..] = agents();
    let view = open(vec![asgn(&a, "worker", None)], None);
    assert_eq!(
        refusal(check_delegate(&view, &a, &role("worker"), &roles())),
        "forbidden"
    );
}

#[test]
fn delegates_from_the_leads_own_assignment_so_the_subtasks_worker_answers_to_it() {
    let [a, ..] = agents();
    let lead = asgn(&a, "lead", None);
    let view = open(vec![lead.clone()], None);
    assert_eq!(
        check_delegate(&view, &a, &role("worker"), &roles()),
        Ok(Some(lead.id))
    );
}

#[test]
fn delegates_from_the_coordinator_assignment_of_an_agent_holding_two_granting_roles() {
    let [a, ..] = agents();
    let lead = asgn(&a, "lead", None);
    let coord = asgn(&a, "coordinator", None);
    let view = open(vec![lead, coord.clone()], None);
    assert_eq!(
        check_delegate(&view, &a, &role("worker"), &roles()),
        Ok(Some(coord.id))
    );
}

#[test]
fn lets_a_coordinator_take_back_a_worker_its_lead_granted_and_no_agent_outside_that_line() {
    let [a, b, c, d] = agents();
    let coord = asgn(&a, "coordinator", None);
    let lead = asgn(&b, "lead", Some(&coord.id));
    let worker = asgn(&c, "worker", Some(&lead.id));
    let line = [b.clone(), a.clone()];
    let view = open(vec![coord, lead, worker.clone()], None);
    assert_eq!(
        [
            refusal(check_unassign(&view, Some(&a), &worker.id, &line)),
            refusal(check_unassign(&view, Some(&d), &worker.id, &line)),
            refusal(check_unassign(&view, None, &worker.id, &[])),
            refusal(check_unassign(&view, None, &id(), &[])),
        ],
        ["allowed", "forbidden", "allowed", "conflict"]
    );
}

#[test]
fn lets_a_lead_finish_the_task_but_makes_a_workers_done_complete_only_its_own_part() {
    let [a, b, ..] = agents();
    let worker = asgn(&b, "worker", None);
    let view = open(vec![asgn(&a, "lead", None), worker.clone()], None);
    assert_eq!(
        [
            check_finish(&view, Some(&a), TaskOutcome::Done, false, &roles()),
            check_finish(&view, Some(&b), TaskOutcome::Done, false, &roles()),
        ],
        [Ok(Finish::Task), Ok(Finish::Assignment(&worker))]
    );
}

#[test]
fn refuses_a_worker_that_cancels_and_an_agent_with_no_part_in_the_task() {
    let [a, b, c, _] = agents();
    let view = open(vec![asgn(&b, "worker", None)], Some(&a));
    assert_eq!(
        [
            refusal(check_finish(
                &view,
                Some(&b),
                TaskOutcome::Cancelled,
                false,
                &roles()
            )),
            refusal(check_finish(
                &view,
                Some(&c),
                TaskOutcome::Done,
                false,
                &roles()
            )),
            refusal(check_finish(
                &view,
                Some(&a),
                TaskOutcome::Cancelled,
                false,
                &roles()
            )),
        ],
        ["forbidden", "forbidden", "allowed"]
    );
}

#[test]
fn lets_a_coordinator_mark_the_humans_task_done_but_not_cancel_it() {
    let [a, ..] = agents();
    let view = open(vec![asgn(&a, "coordinator", None)], None);
    let finish = |caller: Caller<'_>, outcome| {
        refusal(check_finish(&view, caller, outcome, false, &roles()))
    };
    assert_eq!(
        [
            finish(Some(&a), TaskOutcome::Done),
            finish(Some(&a), TaskOutcome::Cancelled),
            finish(None, TaskOutcome::Cancelled),
        ],
        ["allowed", "forbidden", "allowed"]
    );
}

#[test]
fn refuses_to_finish_over_open_subtasks_unless_they_are_cancelled_with_it() {
    let [a, ..] = agents();
    let view = TaskView {
        open_subtasks: vec![id()],
        ..open(Vec::new(), Some(&a))
    };
    assert_eq!(
        refusal(check_finish(
            &view,
            Some(&a),
            TaskOutcome::Done,
            false,
            &roles()
        )),
        "conflict"
    );
    assert_eq!(
        check_finish(&view, Some(&a), TaskOutcome::Done, true, &roles()),
        Ok(Finish::Task)
    );
}

#[test]
fn refuses_to_finish_a_task_twice() {
    let view = TaskView {
        state: TaskState::Cancelled,
        ..open(Vec::new(), None)
    };
    assert_eq!(
        refusal(check_finish(&view, None, TaskOutcome::Done, true, &roles())),
        "conflict"
    );
}

#[test]
fn lets_an_agent_on_the_task_its_owner_and_the_human_note_it_and_no_one_else() {
    let [a, b, c, _] = agents();
    let view = open(vec![asgn(&a, "worker", None)], Some(&b));
    assert_eq!(
        [Some(&a), Some(&b), None, Some(&c)].map(|caller| refusal(check_note(&view, caller))),
        ["allowed", "allowed", "allowed", "forbidden"]
    );
}

#[test]
fn refuses_a_note_on_a_finished_task_even_from_the_human() {
    let view = TaskView {
        state: TaskState::Done,
        ..open(Vec::new(), None)
    };
    assert_eq!(refusal(check_note(&view, None)), "conflict");
}

#[test]
fn gives_an_owner_whose_subtask_moved_up_no_say_on_it() {
    let [_, b, ..] = agents();
    let view = TaskView {
        owner_holds: false,
        ..open(Vec::new(), Some(&b))
    };
    assert_eq!(refusal(check_note(&view, Some(&b))), "forbidden");
}

#[test]
fn words_each_refusal_as_the_typescript_daemon_does() {
    let [a, b, c, _] = agents();
    let sub = id::<bazhen_protocol::ids::kind::Task>();
    let worker = asgn(&b, "worker", None);
    let view = open(vec![asgn(&a, "lead", None), worker.clone()], None);
    let message = |checked: Result<(), TaskRefused>| checked.err().map(|e| e.to_string());
    let finished = TaskView {
        state: TaskState::Done,
        ..open(Vec::new(), None)
    };
    let with_sub = TaskView {
        open_subtasks: vec![sub.clone()],
        ..open(Vec::new(), None)
    };
    let said = [
        message(check_grant(&view, Some(&c), &c, &role("worker"), &roles(), 0).map(drop)),
        message(check_grant(&view, Some(&a), &c, &role("lead"), &roles(), 0).map(drop)),
        message(check_grant(&view, None, &c, &role("auditor"), &roles(), 0).map(drop)),
        message(check_grant(&view, None, &b, &role("reviewer"), &roles(), 0).map(drop)),
        message(check_grant(&view, None, &c, &role("lead"), &roles(), 0).map(drop)),
        message(check_grant(&view, None, &c, &role("worker"), &roles(), 1).map(drop)),
        message(check_grant(&finished, None, &c, &role("worker"), &roles(), 0).map(drop)),
        message(check_unassign(&view, Some(&c), &worker.id, &[])),
        message(check_finish(&view, Some(&c), TaskOutcome::Done, false, &roles()).map(drop)),
        message(check_finish(&view, Some(&a), TaskOutcome::Cancelled, false, &roles()).map(drop)),
        message(check_finish(&finished, None, TaskOutcome::Done, false, &roles()).map(drop)),
        message(check_finish(&with_sub, None, TaskOutcome::Done, false, &roles()).map(drop)),
        message(check_note(&view, Some(&c))),
    ];
    assert_eq!(
        said.map(Option::unwrap_or_default),
        [
            "only the task's coordinator, lead or owner can assign it".to_owned(),
            format!("agent {a} can't make an agent lead"),
            "the human can't make an agent auditor".to_owned(),
            format!("{b} is already assigned to the task"),
            format!("{a} is already the task's lead"),
            format!(
                "{c} already works on 1 task as a worker, the most a worker may at once: finish \
                 or unassign one first"
            ),
            "the task is done".to_owned(),
            "only an agent it was granted under, the owner or the human can unassign it".to_owned(),
            "only its owner, coordinator, lead or the human can mark the task done".to_owned(),
            "the human's task: only the human cancels it".to_owned(),
            "the task is already done".to_owned(),
            format!(
                "the task has open subtasks ({sub}): finish them first, or cancel them with it"
            ),
            "only an agent on the task, its owner or the human notes it".to_owned(),
        ]
    );
}

/// A command the invariants run: a grant, or an unassign of the active assignment at an index.
#[derive(Debug, Clone)]
enum Command {
    Grant {
        caller: Option<usize>,
        agent: usize,
        role: &'static str,
    },
    Unassign {
        caller: Option<usize>,
        index: usize,
    },
}

fn commands() -> impl Strategy<Value = Vec<Command>> {
    let caller = prop::option::of(0..4usize);
    let grant = (
        caller.clone(),
        0..4usize,
        prop::sample::select(vec!["coordinator", "lead", "worker", "reviewer"]),
    )
        .prop_map(|(caller, agent, role)| Command::Grant {
            caller,
            agent,
            role,
        });
    let unassign =
        (caller, 0..=5usize).prop_map(|(caller, index)| Command::Unassign { caller, index });
    prop::collection::vec(prop_oneof![3 => grant, 1 => unassign], 0..=30)
}

/// An active assignment, with who granted it.
#[derive(Debug, Clone)]
struct Granted {
    active: ActiveAssignment,
    by: Option<AgentId>,
}

/// The agents `a` was granted under, nearest first, as the store reads them.
fn granters_of(active: &[Granted], a: &Granted) -> Vec<AgentId> {
    let parent = active
        .iter()
        .find(|p| Some(&p.active.id) == a.active.parent_assignment_id.as_ref());
    parent.map_or_else(Vec::new, |p| {
        let mut line = vec![p.active.agent_id.clone()];
        line.extend(granters_of(active, p));
        line
    })
}

/// Removes `a` and everything granted under it, as ending an assignment does.
fn without_line(active: Vec<Granted>, a: &ActiveAssignment) -> Vec<Granted> {
    let under: Vec<ActiveAssignment> = active
        .iter()
        .filter(|x| x.active.parent_assignment_id.as_ref() == Some(&a.id))
        .map(|x| x.active.clone())
        .collect();
    let rest = active.into_iter().filter(|x| x.active.id != a.id).collect();
    under.iter().fold(rest, without_line)
}

/// Applies each command the rules allow, as the daemon would, and returns every state seen.
fn run(owner: Option<&AgentId>, list: &[Command]) -> Vec<Vec<Granted>> {
    let agents = agents();
    let pick = |n: Option<usize>| n.map(|n| &agents[n]);
    let mut active: Vec<Granted> = Vec::new();
    let mut seen = Vec::new();
    for command in list {
        let view = open(active.iter().map(|g| g.active.clone()).collect(), owner);
        match command {
            Command::Grant {
                caller,
                agent,
                role: key,
            } => {
                let agent = &agents[*agent];
                if let Ok(parent) =
                    check_grant(&view, pick(*caller), agent, &role(key), &roles(), 0)
                {
                    active.push(Granted {
                        active: asgn(agent, key, parent.as_ref()),
                        by: pick(*caller).cloned(),
                    });
                }
            }
            Command::Unassign { caller, index } => {
                if let Some(target) = active.get(index % active.len().max(1)).cloned() {
                    let line = granters_of(&active, &target);
                    if check_unassign(&view, pick(*caller), &target.active.id, &line).is_ok() {
                        active = without_line(active, &target.active);
                    }
                }
            }
        }
        seen.push(active.clone());
    }
    seen
}

fn at_most_one(active: &[Granted], key: &str) -> bool {
    active
        .iter()
        .filter(|g| g.active.role.as_str() == key)
        .count()
        <= 1
}

fn each_agent_once(active: &[Granted]) -> bool {
    let mut agents: Vec<&AgentId> = active.iter().map(|g| &g.active.agent_id).collect();
    agents.sort_by_key(|a| a.as_str());
    agents.dedup();
    agents.len() == active.len()
}

proptest! {
    #[test]
    fn never_holds_two_coordinators_two_leads_or_one_agent_twice(
        owned in any::<bool>(),
        list in commands(),
    ) {
        let [a, ..] = agents();
        for active in run(owned.then_some(&a), &list) {
            prop_assert!(at_most_one(&active, "coordinator"));
            prop_assert!(at_most_one(&active, "lead"));
            prop_assert!(each_agent_once(&active));
        }
    }

    #[test]
    fn makes_coordinators_only_on_the_humans_word(list in commands()) {
        let [.., d] = agents();
        for active in run(Some(&d), &list) {
            prop_assert!(active.iter().all(|g| g.active.role.as_str() != "coordinator" || g.by.is_none()));
        }
    }
}
