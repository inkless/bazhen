//! The verbs that give agents work, over agents launched on the fake runtime.

use std::sync::Arc;

use axum::body::Body;
use bazhen_core::roles::RoleBook;
use bazhen_harness::Delivery;
use bazhen_protocol::agents::{HarnessId, LaunchAgentRequest};
use bazhen_store::{NewNote, NewTask};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use super::*;
use crate::mail::tests::{Fixture, fixture, pull, taking};
use crate::testing::stub_harness::StubHarness;

/// A task the human made, with `brief`.
fn made(f: &Fixture, key: &str, brief: &str) -> String {
    let task = NewTask {
        caller: None,
        key: key.to_owned(),
        title: "Fix the build".to_owned(),
        brief: brief.to_owned(),
        parent: None,
    };
    let made = f
        .runtime
        .block_on(
            f.shared
                .store
                .run(move |store| store.create_task(&task, &RoleBook::new(Vec::new()))),
        )
        .unwrap()
        .unwrap();
    made.task_id.as_str().to_owned()
}

/// Asks, as `caller`, that `agent` be given `role` on `task`.
fn assign_as(
    f: &Fixture,
    caller: Option<&AgentId>,
    task: &str,
    key: &str,
    agent: &str,
    role: &str,
) -> (u16, Value) {
    let body = json!({ "idempotencyKey": key, "agentId": agent, "role": role });
    let response = f.runtime.block_on(assign(
        State(f.shared.clone()),
        Some(Extension(Caller(caller.cloned()))),
        Path(task.to_owned()),
        Bytes::from(body.to_string()),
    ));
    let status = response.status().as_u16();
    let bytes = f
        .runtime
        .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The status and message of a refusal.
fn refused(answer: &(u16, Value)) -> (u16, String) {
    (
        answer.0,
        answer.1["message"].as_str().unwrap_or_default().to_owned(),
    )
}

/// The bodies of the mail queued, in order.
fn bodies(f: &Fixture) -> Vec<String> {
    f.mail()
        .into_iter()
        .filter(|(kind, _)| kind == "mailbox.queued")
        .map(|(_, payload)| payload["body"].as_str().unwrap().to_owned())
        .collect()
}

/// How many assignments were granted.
fn granted(f: &Fixture) -> usize {
    let reader = f.shared.store.reader().unwrap();
    let events = reader.reads().events(0, 1000).unwrap();
    events
        .iter()
        .filter(|e| e.kind == "assignment.granted")
        .count()
}

#[test]
fn mails_an_assignee_new_to_its_role_the_roles_prompt_then_the_brief_handed_over_once_committed() {
    let f = fixture(pull());
    let task = made(&f, "c", "It fails on Node 26.");
    let answer = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    assert_eq!(answer.0, 200, "{}", answer.1);
    let mail = bodies(&f);
    assert_eq!(mail.len(), 2, "{mail:?}");
    assert!(mail[0].starts_with(&format!("## Your role on task {task}: Worker\n\n")));
    assert!(mail[1].starts_with(&format!(
        "You are assigned to task {task} as its worker, by the human.\n\nTitle: Fix the build\
         \n\nIt fails on Node 26.\n\n"
    )));
    let handed: Vec<_> = f
        .hand_over()
        .into_iter()
        .map(|q| (q.agent, q.delivery))
        .collect();
    assert_eq!(
        handed,
        [
            (f.to.clone(), Delivery::Pull),
            (f.to.clone(), Delivery::Pull)
        ]
    );
    let detail = f
        .shared
        .store
        .reader()
        .unwrap()
        .reads()
        .task_detail(&TaskId::parse(&task).unwrap())
        .unwrap()
        .unwrap();
    let held = &detail.assignments[0];
    assert_eq!(
        (
            held.id.as_str(),
            &held.agent_id,
            held.role.as_str(),
            &held.parent_assignment_id
        ),
        (
            answer.1["assignmentId"].as_str().unwrap(),
            &f.to,
            "worker",
            &None
        )
    );
    assert_eq!(answer.1["eventIds"].as_array().unwrap().len(), 3);
}

#[test]
fn sends_a_roles_prompt_only_to_an_agent_neither_launched_in_it_nor_holding_it_before() {
    let f = fixture(pull());
    let request = LaunchAgentRequest {
        idempotency_key: "launch-3".to_owned(),
        harness: HarnessId::ClaudeCode,
        cwd: "~/repo".to_owned(),
        project: None,
        theme: None,
        name: None,
        role: Some(Role::parse("reviewer").unwrap()),
        compact_window_tokens: None,
    };
    let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
    let launched = f
        .runtime
        .block_on(agents.launch(&request))
        .unwrap()
        .agent_id;
    f.set_state(&launched, "running");
    let (one, two) = (made(&f, "c1", "b"), made(&f, "c2", "b"));
    for (task, key, agent) in [
        (&one, "a1", &f.to),
        (&two, "a2", &f.to),
        (&one, "a3", &launched),
    ] {
        let answer = assign_as(&f, None, task, key, agent.as_str(), "reviewer");
        assert_eq!(answer.0, 200, "{}", answer.1);
    }
    let heads: Vec<String> = bodies(&f)
        .iter()
        .map(|body| body.lines().next().unwrap().to_owned())
        .collect();
    assert_eq!(
        heads,
        [
            format!("## Your role on task {one}: Reviewer"),
            format!("You are assigned to task {one} as its reviewer, by the human."),
            format!("You are assigned to task {two} as its reviewer, by the human."),
            format!("You are assigned to task {one} as its reviewer, by the human."),
        ]
    );
}

#[test]
fn refuses_what_it_cant_assign_and_records_and_hands_over_nothing() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let (to, peer) = (f.to.as_str().to_owned(), f.peer.as_str().to_owned());
    let unknown = "task_0190a1b2c3d47abc8def0123456789ff";
    let mut answers = vec![
        refused(&assign_as(&f, None, &task, "k1", &to, "auditor")),
        refused(&assign_as(&f, None, &task, "k2", "nobody", "worker")),
        refused(&assign_as(&f, None, unknown, "k3", &to, "worker")),
        refused(&assign_as(&f, None, "nonsense", "k4", &to, "worker")),
        (
            assign_as(&f, Some(&f.peer), &task, "k5", &to, "worker").0,
            String::new(),
        ),
    ];
    f.set_state(&f.to.clone(), "closed");
    answers.push(refused(&assign_as(&f, None, &task, "k6", &to, "worker")));
    f.set_state(&f.peer.clone(), "lost");
    answers.push(refused(&assign_as(
        &f,
        Some(&f.peer),
        &task,
        "k7",
        &to,
        "worker",
    )));
    assert_eq!(
        answers,
        [
            (
                400,
                "no role is defined as auditor: bazhen roles lists them".to_owned()
            ),
            (404, "no agent nobody by that name".to_owned()),
            (404, format!("no task {unknown}")),
            (404, "no task nonsense".to_owned()),
            (403, String::new()),
            (404, format!("no agent {to} that can take a task")),
            (404, format!("no agent {peer} that is open")),
        ]
    );
    assert_eq!(
        (granted(&f), bodies(&f).len(), f.hand_over().len()),
        (0, 0, 0)
    );
}

#[test]
fn records_no_assignment_when_its_agent_takes_no_mail() {
    let f = fixture(StubHarness::new(taking(Delivery::None)));
    let task = made(&f, "c", "b");
    let answer = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    assert_eq!(
        (refused(&answer), granted(&f)),
        ((404, format!("no agent {} that takes mail", f.to)), 0)
    );
}

#[test]
fn hands_an_assignments_mail_over_only_once_its_write_commits() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    // The first answer the write keeps is its last step: refusing it fails the write after the
    // grant has queued its mail.
    f.runtime
        .block_on(f.shared.store.run(|store| {
            store.write(|w| {
                w.connection().execute_batch(
                    "CREATE TEMP TRIGGER later AFTER INSERT ON main.idempotency_keys \
                     BEGIN SELECT RAISE(ABORT, 'a later step fails'); END",
                )?;
                Ok::<_, AppendError>(())
            })
        }))
        .unwrap()
        .unwrap();
    let answer = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    assert_eq!(
        (answer.0, granted(&f), bodies(&f).len(), f.hand_over().len()),
        (500, 0, 0, 0)
    );
}

/// Polls `route` once, so it queues its write behind a job that holds the writer, then drops it,
/// as a client that hangs up does, and lets the writer go on: whether the route had answered.
fn left_before_it_committed(f: &Fixture, route: impl Future<Output = Response>) -> bool {
    f.runtime.block_on(async {
        let (go, waits) = std::sync::mpsc::channel::<()>();
        f.shared
            .store
            .queue(move |_| {
                let _ = waits.recv();
            })
            .unwrap();
        let mut route = Box::pin(route);
        let answered = route
            .as_mut()
            .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
            .is_ready();
        drop(route);
        drop(go);
        f.shared.store.run(|_| ()).await.unwrap();
        answered
    })
}

#[test]
fn hands_over_the_mail_of_an_assignment_whose_caller_left_before_it_committed() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let body = json!({ "idempotencyKey": "a", "agentId": f.to.as_str(), "role": "worker" });
    let before = bodies(&f).len();
    let assigned = left_before_it_committed(
        &f,
        assign(
            State(f.shared.clone()),
            Some(Extension(Caller(None))),
            Path(task),
            Bytes::from(body.to_string()),
        ),
    );
    let (assign_queued, assign_handed) = (bodies(&f).len() - before, f.hand_over().len());
    let asking = assigning("m", f.peer.as_str(), "worker").to_string();
    let (asked, grant) = crate::tasks::asked(asking.as_bytes()).unwrap();
    let before = bodies(&f).len();
    let created = left_before_it_committed(&f, create(f.shared.clone(), asked, grant));
    let (create_queued, create_handed) = (bodies(&f).len() - before, f.hand_over().len());
    assert_eq!(
        (
            (assigned, assign_queued > 0, assign_handed),
            (created, create_queued > 0, create_handed),
            granted(&f)
        ),
        (
            (false, true, assign_queued),
            (false, true, create_queued),
            2
        )
    );
}

#[test]
fn refuses_a_brief_too_long_for_the_mailbox_recording_nothing() {
    let f = fixture(pull());
    let task = made(&f, "c", &"x".repeat(19_950));
    let (status, message) = refused(&assign_as(&f, None, &task, "a", f.to.as_str(), "worker"));
    assert_eq!(
        (
            status,
            message.starts_with("the message to the agent would be "),
            granted(&f)
        ),
        (400, true, 0)
    );
}

#[test]
fn answers_a_repeated_assignment_with_its_first_answer_and_mails_no_one_twice() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let first = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    let handed = f.hand_over().len();
    let again = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    assert_eq!(
        (
            again,
            handed,
            f.hand_over().len(),
            granted(&f),
            bodies(&f).len()
        ),
        (first, 2, 0, 1, 2)
    );
    assert_eq!(
        [
            refused(&assign_as(&f, None, &task, "a", f.to.as_str(), "reviewer")),
            refused(&assign_as(&f, None, &task, "b", f.to.as_str(), "reviewer")),
        ],
        [
            (
                409,
                "idempotency key a was first used for a different request".to_owned()
            ),
            (409, format!("{} is already assigned to the task", f.to)),
        ]
    );
}

#[test]
fn carries_the_handoff_note_left_on_the_task_in_the_brief() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let note = NewNote {
        caller: None,
        task: TaskId::parse(&task).unwrap(),
        key: "n".to_owned(),
        text: "half done".to_owned(),
        handoff: true,
    };
    f.runtime
        .block_on(f.shared.store.run(move |store| store.note_task(&note)))
        .unwrap()
        .unwrap();
    let answer = assign_as(&f, None, &task, "a", f.to.as_str(), "worker");
    assert_eq!(answer.0, 200, "{}", answer.1);
    let brief = bodies(&f).pop().unwrap();
    assert!(
        brief.contains("\n\nA handoff note on this task from the human, at ")
            && brief.contains("\n\n> half done\n\nEnd of the handoff note."),
        "{brief}"
    );
}

/// A token shaped as the daemon mints them.
const PEER_TOKEN: &str = "pppppppppppppppppppppppppppppppppppppppppp0";

#[test]
fn refuses_an_agent_on_the_socket_off_the_task_where_the_human_assigns_it() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let peer = f.peer.clone();
    f.runtime
        .block_on(f.shared.store.run(move |store| {
            store.write(|w| {
                w.connection().execute(
                    "UPDATE agent_sessions SET token_hash = ? WHERE id = ?",
                    (crate::tokens::hash_of(PEER_TOKEN), peer.as_str()),
                )?;
                Ok::<_, AppendError>(())
            })
        }))
        .unwrap()
        .unwrap();
    let ask = |key: &str, token: Option<&str>| {
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/v1/tasks/{task}/assign"))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("bazhen-agent-token", token);
        }
        let body = json!({ "idempotencyKey": key, "agentId": f.to.as_str(), "role": "worker" });
        let request = request.body(Body::from(body.to_string())).unwrap();
        let router = crate::routes::socket_router(f.shared.clone());
        let response = f.runtime.block_on(router.oneshot(request)).unwrap();
        let status = response.status().as_u16();
        let bytes = f
            .runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body["message"].as_str().map(str::to_owned))
    };
    assert_eq!(
        [ask("k1", Some(PEER_TOKEN)), ask("k2", None)],
        [
            (
                403,
                Some("only the task's coordinator, lead or owner can assign it".to_owned())
            ),
            (200, None)
        ]
    );
}

/// Asks, as `caller`, for the task `body` names, as `POST /v1/tasks` does.
fn create_as(f: &Fixture, caller: Option<&AgentId>, body: &Value) -> (u16, Value) {
    let (task, assign) = crate::tasks::asked(body.to_string().as_bytes()).unwrap();
    let task = NewTask {
        caller: caller.cloned(),
        ..task
    };
    let response = f.runtime.block_on(create(f.shared.clone(), task, assign));
    let status = response.status().as_u16();
    let bytes = f
        .runtime
        .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A body asking for a task, granting `role` on it to `agent`.
fn assigning(key: &str, agent: &str, role: &str) -> Value {
    json!({
        "idempotencyKey": key,
        "title": "Fix the build",
        "brief": "It fails.",
        "assign": { "agentId": agent, "role": role },
    })
}

/// What `read` reads of the store, on the writer's connection.
fn sql<T: Send + 'static>(
    f: &Fixture,
    read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
) -> T {
    f.runtime
        .block_on(
            f.shared
                .store
                .run(move |store| store.write(|w| Ok::<_, AppendError>(read(w.connection())?))),
        )
        .unwrap()
        .unwrap()
}

/// Each task's id, owner and the assignment it was delegated from, oldest first.
fn tasks_made(f: &Fixture) -> Vec<(String, Option<String>, Option<String>)> {
    sql(f, |db| {
        db.prepare(
            "SELECT id, owner_agent_id, delegated_from FROM tasks ORDER BY created_event_id",
        )?
        .query_map((), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect()
    })
}

#[test]
fn makes_a_task_and_grants_the_role_asked_on_it_in_one_write_keeping_the_agent_as_resolved() {
    let f = fixture(pull());
    let reader = f.shared.store.reader().unwrap();
    let to = f.to.clone();
    let name: String = sql(&f, move |db| {
        db.query_row(
            "SELECT name FROM agent_sessions WHERE id = ?",
            [to.as_str()],
            |row| row.get(0),
        )
    });
    let (status, made) = create_as(&f, None, &assigning("c", &name, "worker"));
    assert_eq!(status, 200, "{made}");
    let task = made["taskId"].as_str().unwrap();
    let detail = reader
        .reads()
        .task_detail(&TaskId::parse(task).unwrap())
        .unwrap()
        .unwrap();
    let held = &detail.assignments[0];
    assert_eq!(
        (
            held.id.as_str(),
            &held.agent_id,
            held.role.as_str(),
            &held.parent_assignment_id,
            made["eventIds"].as_array().unwrap().len(),
        ),
        (
            made["assignmentId"].as_str().unwrap(),
            &f.to,
            "worker",
            &None,
            4
        )
    );
    let kept: String = sql(&f, |db| {
        db.query_row(
            "SELECT response FROM idempotency_keys WHERE key = 'c'",
            (),
            |row| row.get(0),
        )
    });
    let kept: Value = serde_json::from_str(&kept).unwrap();
    assert_eq!(
        kept["request"].as_str().unwrap(),
        format!(
            r#"{{"caller":null,"title":"Fix the build","brief":"It fails.","assign":{{"agentId":"{}","role":"worker"}}}}"#,
            f.to
        )
    );
    let heads: Vec<String> = bodies(&f)
        .iter()
        .map(|body| body.lines().next().unwrap().to_owned())
        .collect();
    assert_eq!(
        (heads, f.hand_over().len()),
        (
            vec![
                format!("## Your role on task {task}: Worker"),
                format!("You are assigned to task {task} as its worker, by the human."),
            ],
            2
        )
    );
}

#[test]
fn makes_no_task_when_the_role_it_asks_to_grant_cant_be_granted() {
    let f = fixture(pull());
    let to = f.to.as_str().to_owned();
    let mut answers = vec![
        refused(&create_as(&f, None, &assigning("c1", &to, "auditor"))),
        refused(&create_as(&f, None, &assigning("c2", "nobody", "worker"))),
    ];
    f.set_state(&f.to.clone(), "closed");
    answers.push(refused(&create_as(
        &f,
        None,
        &assigning("c3", &to, "worker"),
    )));
    assert_eq!(
        answers,
        [
            (
                400,
                "no role is defined as auditor: bazhen roles lists them".to_owned()
            ),
            (404, "no agent nobody by that name".to_owned()),
            (404, format!("no agent {to} that can take a task")),
        ]
    );
    assert_eq!(
        (
            tasks_made(&f),
            granted(&f),
            bodies(&f).len(),
            f.hand_over().len()
        ),
        (vec![], 0, 0, 0)
    );
}

#[test]
fn grants_an_agents_subtask_under_the_assignment_it_delegates_from_and_its_own_under_none() {
    let f = fixture(pull());
    let parent = made(&f, "p", "b");
    let lead = assign_as(&f, None, &parent, "a", f.peer.as_str(), "lead");
    assert_eq!(lead.0, 200, "{}", lead.1);
    let lead = lead.1["assignmentId"].as_str().unwrap().to_owned();
    f.hand_over();
    let mut sub = assigning("s", f.to.as_str(), "worker");
    sub["parentTaskId"] = json!(parent);
    let (status, delegated) = create_as(&f, Some(&f.peer), &sub);
    assert_eq!(status, 200, "{delegated}");
    let own = json!({ "idempotencyKey": "o", "title": "T", "brief": "b" });
    let (_, own) = create_as(&f, Some(&f.peer), &own);
    let mut under_own = json!({ "idempotencyKey": "u", "title": "T", "brief": "b" });
    under_own["parentTaskId"] = own["taskId"].clone();
    let (status, under_own) = create_as(&f, Some(&f.peer), &under_own);
    assert_eq!(status, 200, "{under_own}");
    let id = |made: &Value| made["taskId"].as_str().unwrap().to_owned();
    let peer = Some(f.peer.as_str().to_owned());
    assert_eq!(
        tasks_made(&f),
        [
            (parent.clone(), None, None),
            (id(&delegated), peer.clone(), Some(lead.clone())),
            (id(&own), peer.clone(), None),
            (id(&under_own), peer, None),
        ]
    );
    let detail = f
        .shared
        .store
        .reader()
        .unwrap()
        .reads()
        .task_detail(&TaskId::parse(&id(&delegated)).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        detail.assignments[0]
            .parent_assignment_id
            .as_ref()
            .map(|a| a.as_str().to_owned()),
        Some(lead)
    );
}

#[test]
fn refuses_an_agents_subtask_assigning_a_role_its_role_on_the_parent_doesnt_grant() {
    let f = fixture(pull());
    let parent = made(&f, "p", "b");
    let lead = assign_as(&f, None, &parent, "a", f.peer.as_str(), "lead");
    assert_eq!(lead.0, 200, "{}", lead.1);
    f.hand_over();
    let mut sub = assigning("s", f.to.as_str(), "lead");
    sub["parentTaskId"] = json!(parent);
    assert_eq!(
        (
            refused(&create_as(&f, Some(&f.peer), &sub)),
            tasks_made(&f).len()
        ),
        (
            (403, format!("agent {} can't make an agent lead", f.peer)),
            1
        )
    );
}

#[test]
fn refuses_an_agents_subtask_under_a_task_it_neither_owns_nor_grants_on_making_nothing() {
    let f = fixture(pull());
    let parent = made(&f, "p", "b");
    let worker = assign_as(&f, None, &parent, "a", f.peer.as_str(), "worker");
    assert_eq!(worker.0, 200, "{}", worker.1);
    let mut sub = json!({ "idempotencyKey": "s", "title": "T", "brief": "b" });
    sub["parentTaskId"] = json!(parent);
    assert_eq!(
        (
            refused(&create_as(&f, Some(&f.peer), &sub)),
            tasks_made(&f).len()
        ),
        (
            (
                403,
                "only the task's coordinator, lead or owner can assign it".to_owned()
            ),
            1
        )
    );
}

/// Asks, as `caller`, that `assignment` be taken off `task`.
fn unassign_as(
    f: &Fixture,
    caller: Option<&AgentId>,
    task: &str,
    key: &str,
    assignment: &str,
) -> (u16, Value) {
    let body = json!({ "idempotencyKey": key, "assignmentId": assignment });
    let response = f.runtime.block_on(unassign(
        State(f.shared.clone()),
        Some(Extension(Caller(caller.cloned()))),
        Path(task.to_owned()),
        Bytes::from(body.to_string()),
    ));
    let status = response.status().as_u16();
    let bytes = f
        .runtime
        .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// The id of the assignment an answer granted.
fn granted_id(answer: &(u16, Value)) -> String {
    assert_eq!(answer.0, 200, "{}", answer.1);
    answer.1["assignmentId"].as_str().unwrap().to_owned()
}

/// Each assignment's id, state and end reason, oldest first.
fn assignments(f: &Fixture) -> Vec<(String, String, Option<String>)> {
    sql(f, |db| {
        db.prepare("SELECT id, state, end_reason FROM assignments ORDER BY created_event_id")?
            .query_map((), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect()
    })
}

/// How many events there are.
fn events(f: &Fixture) -> i64 {
    sql(f, |db| {
        db.query_row("SELECT count(*) FROM events", (), |row| row.get(0))
    })
}

/// Each open item's agent, kind, summary and task.
fn items(f: &Fixture) -> Vec<(String, String, String, Option<String>)> {
    sql(f, |db| {
        db.prepare(
            "SELECT agent_session_id, kind, summary, task_id FROM attention_items
             WHERE state = 'open' ORDER BY created_event_id",
        )?
        .query_map((), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect()
    })
}

/// A task as mail names it.
fn named(f: &Fixture, task: &str) -> bazhen_protocol::tasks::Task {
    let task = TaskId::parse(task).unwrap();
    f.shared
        .store
        .reader()
        .unwrap()
        .reads()
        .task(&task)
        .unwrap()
        .unwrap()
}

/// A body asking for a subtask of `parent`.
fn under(key: &str, parent: &str) -> Value {
    json!({ "idempotencyKey": key, "title": "Part of it", "brief": "b", "parentTaskId": parent })
}

#[test]
fn unassigns_an_agent_ending_what_was_granted_under_it_and_mails_each_agent_it_ends() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let lead = granted_id(&assign_as(&f, None, &task, "a", f.peer.as_str(), "lead"));
    let worker = granted_id(&assign_as(
        &f,
        Some(&f.peer),
        &task,
        "w",
        f.to.as_str(),
        "worker",
    ));
    let before = bodies(&f).len();
    let answer = unassign_as(&f, None, &task, "u", &lead);
    assert_eq!(answer.0, 200, "{}", answer.1);
    let ended = |id: &str, why: &str| (id.to_owned(), "ended".to_owned(), Some(why.to_owned()));
    let named = named(&f, &task);
    assert_eq!(
        (
            assignments(&f),
            bodies(&f)[before..].to_vec(),
            answer.1["eventIds"].as_array().unwrap().len()
        ),
        (
            vec![ended(&lead, "unassigned"), ended(&worker, "parent_ended")],
            vec![
                crate::task_mail::unassigned_mail(&named, None),
                line_ended_mail(&named)
            ],
            3
        )
    );
}

#[test]
fn names_the_agent_that_unassigns_and_mails_no_caller_it_takes_off() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    granted_id(&assign_as(&f, None, &task, "a", f.peer.as_str(), "lead"));
    let worker = granted_id(&assign_as(
        &f,
        Some(&f.peer),
        &task,
        "w",
        f.to.as_str(),
        "worker",
    ));
    let (_, own) = create_as(
        &f,
        Some(&f.peer),
        &json!({ "idempotencyKey": "o", "title": "T", "brief": "b" }),
    );
    let own = own["taskId"].as_str().unwrap().to_owned();
    let itself = granted_id(&assign_as(
        &f,
        Some(&f.peer),
        &own,
        "s",
        f.peer.as_str(),
        "worker",
    ));
    let before = bodies(&f).len();
    let by_lead = unassign_as(&f, Some(&f.peer), &task, "u1", &worker);
    let by_itself = unassign_as(&f, Some(&f.peer), &own, "u2", &itself);
    let name: String = {
        let peer = f.peer.clone();
        sql(&f, move |db| {
            db.query_row(
                "SELECT name FROM agent_sessions WHERE id = ?",
                [peer.as_str()],
                |row| row.get(0),
            )
        })
    };
    let from = Agent {
        id: &f.peer,
        name: &name,
    };
    assert_eq!(
        (by_lead.0, by_itself.0, bodies(&f)[before..].to_vec()),
        (
            200,
            200,
            vec![crate::task_mail::unassigned_mail(
                &named(&f, &task),
                Some(from)
            )]
        )
    );
}

#[test]
fn refuses_to_unassign_one_not_active_or_for_an_agent_it_wasnt_granted_under_recording_nothing() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let theirs = granted_id(&assign_as(&f, None, &task, "a1", f.to.as_str(), "worker"));
    granted_id(&assign_as(&f, None, &task, "a2", f.peer.as_str(), "worker"));
    assert_eq!(unassign_as(&f, None, &task, "u1", &theirs).0, 200);
    let before = events(&f);
    let other = made(&f, "c2", "b");
    let held = granted_id(&assign_as(&f, None, &other, "a3", f.to.as_str(), "worker"));
    let before_refusals = events(&f);
    assert_eq!(
        [
            refused(&unassign_as(&f, None, &task, "u2", &theirs)),
            refused(&unassign_as(&f, Some(&f.peer), &other, "u3", &held)),
        ],
        [
            (409, format!("{theirs} is not active")),
            (
                403,
                "only an agent it was granted under, the owner or the human can unassign it"
                    .to_owned()
            ),
        ]
    );
    assert!(before_refusals > before);
    assert_eq!(events(&f), before_refusals);
}

#[test]
fn answers_a_replayed_unassign_as_it_first_did_and_refuses_its_key_for_another() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let one = granted_id(&assign_as(&f, None, &task, "a1", f.to.as_str(), "worker"));
    let two = granted_id(&assign_as(&f, None, &task, "a2", f.peer.as_str(), "worker"));
    let first = unassign_as(&f, None, &task, "u", &one);
    assert_eq!(first.0, 200, "{}", first.1);
    assert_eq!(
        [
            unassign_as(&f, None, &task, "u", &one),
            (
                refused(&unassign_as(&f, None, &task, "u", &two)).0,
                Value::Null
            ),
        ],
        [first.clone(), (409, Value::Null)]
    );
}

#[test]
fn unassigns_an_agent_gone_by_then_leaving_it_untold() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let held = granted_id(&assign_as(&f, None, &task, "a", f.to.as_str(), "worker"));
    f.set_state(&f.to.clone(), "closed");
    let before = bodies(&f).len();
    let answer = unassign_as(&f, None, &task, "u", &held);
    assert_eq!((answer.0, bodies(&f).len()), (200, before), "{}", answer.1);
}

#[test]
fn moves_a_subtask_its_delegation_left_to_the_human_and_escalates_the_agent_it_was_delegated_by() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let lead = granted_id(&assign_as(&f, None, &task, "a", f.peer.as_str(), "lead"));
    let (_, sub) = create_as(&f, Some(&f.peer), &under("s", &task));
    let sub = sub["taskId"].as_str().unwrap().to_owned();
    let answer = unassign_as(&f, None, &task, "u", &lead);
    assert_eq!(answer.0, 200, "{}", answer.1);
    let named = named(&f, &sub);
    assert_eq!(
        (tasks_made(&f)[1].clone(), items(&f)),
        (
            (sub.clone(), None, None),
            vec![(
                f.peer.as_str().to_owned(),
                "escalation".to_owned(),
                crate::task_mail::fell_to_the_human(&named, &f.peer),
                Some(sub)
            )]
        )
    );
}

#[test]
fn lifts_a_chain_of_subtasks_to_the_live_owner_above_with_its_delegation_and_mails_it() {
    let f = fixture(pull());
    let top = made(&f, "c", "b");
    let above = granted_id(&assign_as(&f, None, &top, "a1", f.peer.as_str(), "lead"));
    let (_, part) = create_as(&f, Some(&f.peer), &under("p", &top));
    let part = part["taskId"].as_str().unwrap().to_owned();
    let lead = granted_id(&assign_as(
        &f,
        Some(&f.peer),
        &part,
        "a2",
        f.to.as_str(),
        "lead",
    ));
    let (_, sub) = create_as(&f, Some(&f.to), &under("s", &part));
    let sub = sub["taskId"].as_str().unwrap().to_owned();
    let (_, deeper) = create_as(&f, Some(&f.to), &under("d", &sub));
    let deeper = deeper["taskId"].as_str().unwrap().to_owned();
    let before = bodies(&f).len();
    let answer = unassign_as(&f, Some(&f.peer), &part, "u", &lead);
    assert_eq!(answer.0, 200, "{}", answer.1);
    let peer = Some(f.peer.as_str().to_owned());
    let mail = bodies(&f)[before..].to_vec();
    assert_eq!(
        (tasks_made(&f)[2..].to_vec(), mail[1..].to_vec()),
        (
            vec![
                (sub.clone(), peer.clone(), Some(above.clone())),
                (deeper.clone(), peer, Some(above)),
            ],
            vec![
                crate::task_mail::owned_mail(&named(&f, &sub)),
                crate::task_mail::owned_mail(&named(&f, &deeper)),
            ]
        )
    );
}

#[test]
fn mails_an_owner_each_time_a_start_lifts_a_subtask_to_it_however_often_it_was_told_before() {
    let f = fixture(pull());
    let top = made(&f, "c", "b");
    granted_id(&assign_as(&f, None, &top, "a1", f.peer.as_str(), "lead"));
    let (_, part) = create_as(&f, Some(&f.peer), &under("p", &top));
    let part = part["taskId"].as_str().unwrap().to_owned();
    let lead = granted_id(&assign_as(
        &f,
        Some(&f.peer),
        &part,
        "a2",
        f.to.as_str(),
        "lead",
    ));
    let (_, sub) = create_as(&f, Some(&f.to), &under("s", &part));
    let sub = sub["taskId"].as_str().unwrap().to_owned();
    let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
    let before = bodies(&f).len();
    // The lead's delegation ended as a daemon that didn't lift in the same write would leave it,
    // then the subtask left with `to` under it again, as a store a daemon restored would hold it.
    for _ in 0..2 {
        let (to, sub, lead) = (f.to.as_str().to_owned(), sub.clone(), lead.clone());
        sql(&f, move |db| {
            db.execute(
                "UPDATE tasks SET owner_agent_id = ?, delegated_from = ? WHERE id = ?",
                (&to, &lead, &sub),
            )?;
            db.execute(
                "UPDATE assignments SET state = 'ended', end_reason = 'unassigned' WHERE id = ?",
                [&lead],
            )
        });
        f.runtime
            .block_on(crate::task_lift::at_start(&f.shared.store, &agents));
    }
    let owned = crate::task_mail::owned_mail(&named(&f, &sub));
    assert_eq!(bodies(&f)[before..].to_vec(), vec![owned.clone(), owned]);
}

#[test]
fn lifts_what_a_store_left_stranded_at_start_and_nothing_a_second_time() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let lead = granted_id(&assign_as(&f, None, &task, "a", f.peer.as_str(), "lead"));
    let (_, sub) = create_as(&f, Some(&f.peer), &under("s", &task));
    let sub = sub["taskId"].as_str().unwrap().to_owned();
    // Ended as a daemon that didn't lift in the same write would have left it.
    sql(&f, move |db| {
        db.execute(
            "UPDATE assignments SET state = 'ended', end_reason = 'unassigned' WHERE id = ?",
            [lead],
        )
    });
    let agents = Arc::clone(f.shared.agents.as_ref().unwrap());
    let changes = |f: &Fixture| -> i64 {
        sql(f, |db| {
            db.query_row(
                "SELECT count(*) FROM events WHERE type = 'task.owner_changed'",
                (),
                |row| row.get(0),
            )
        })
    };
    f.runtime
        .block_on(crate::task_lift::at_start(&f.shared.store, &agents));
    let once = (tasks_made(&f)[1].clone(), changes(&f), items(&f).len());
    f.runtime
        .block_on(crate::task_lift::at_start(&f.shared.store, &agents));
    assert_eq!(
        (once, changes(&f), items(&f).len()),
        (((sub, None, None), 1, 1), 1, 1)
    );
}

#[test]
fn refuses_an_agent_on_the_socket_that_cant_unassign_where_the_human_can() {
    let f = fixture(pull());
    let task = made(&f, "c", "b");
    let held = granted_id(&assign_as(&f, None, &task, "a", f.to.as_str(), "worker"));
    granted_id(&assign_as(&f, None, &task, "a2", f.peer.as_str(), "worker"));
    let peer = f.peer.clone();
    sql(&f, move |db| {
        db.execute(
            "UPDATE agent_sessions SET token_hash = ? WHERE id = ?",
            (crate::tokens::hash_of(PEER_TOKEN), peer.as_str()),
        )
    });
    let ask = |key: &str, token: Option<&str>| {
        let mut request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/v1/tasks/{task}/unassign"))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("bazhen-agent-token", token);
        }
        let body = json!({ "idempotencyKey": key, "assignmentId": held });
        let request = request.body(Body::from(body.to_string())).unwrap();
        let router = crate::routes::socket_router(f.shared.clone());
        let response = f.runtime.block_on(router.oneshot(request)).unwrap();
        let status = response.status().as_u16();
        let bytes = f
            .runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1 << 20))
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body["message"].as_str().map(str::to_owned))
    };
    assert_eq!(
        [ask("k1", Some(PEER_TOKEN)), ask("k2", None)],
        [
            (
                403,
                Some(
                    "only an agent it was granted under, the owner or the human can unassign it"
                        .to_owned()
                )
            ),
            (200, None)
        ]
    );
}

#[test]
fn refuses_to_unassign_on_no_task_or_a_path_that_names_none() {
    let f = fixture(pull());
    let asgn = "asgn_01900000000070008000000000000009";
    let unknown = "task_0190a1b2c3d47abc8def0123456789ff";
    assert_eq!(
        [
            refused(&unassign_as(&f, None, unknown, "u1", asgn)),
            refused(&unassign_as(&f, None, "nonsense", "u2", asgn)),
        ],
        [
            (404, format!("no task {unknown}")),
            (404, "no task nonsense".to_owned())
        ]
    );
}
