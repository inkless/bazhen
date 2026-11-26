//! The verbs that give agents work, over agents launched on the fake runtime.

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
