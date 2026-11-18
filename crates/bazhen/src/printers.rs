//! The task verbs' answers as plain lines, which a model reads as easily as a person.

use bazhen_protocol::agents::{
    Agent, FleetAgent, FleetAttention, FleetHeadline, FleetSignal, FleetTask, StateSnapshot,
};
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::mail::AttentionState;
use bazhen_protocol::names::Role;
use bazhen_protocol::roles::RolesResponse;
use bazhen_protocol::tasks::{Assignment, AssignmentState, Task, TaskDetail, TaskNote, TaskState};
use bazhen_protocol::text::quote_note;

use crate::fmt::{age_seconds, ago};

/// An agent's active assignments, in the snapshot's order.
pub(crate) fn active_for<'a>(s: &'a StateSnapshot, agent: &str) -> Vec<&'a Assignment> {
    s.assignments
        .iter()
        .filter(|a| a.agent_id.as_str() == agent && a.state == AssignmentState::Active)
        .collect()
}

/// An agent as the CLI prints it: by its name while it is not ended, as the name then names it
/// alone; by its id once it has, since another agent may hold its name now, and from a daemon
/// that names none.
fn shown(s: &StateSnapshot, agent: &AgentId) -> String {
    match s.agents.iter().find(|a| a.id == *agent) {
        Some(a) if !a.name.is_empty() && !a.state.ended() => a.name.clone(),
        _ => agent.to_string(),
    }
}

pub(crate) fn list_agents(s: &StateSnapshot, now_ms: i64) -> String {
    let live: Vec<&Agent> = s.agents.iter().filter(|a| !a.state.ended()).collect();
    if live.is_empty() {
        return "no agents".to_owned();
    }
    let mut lines = Vec::new();
    for a in live {
        let signal = a.activity.as_ref().map_or_else(String::new, |activity| {
            let age = ago(age_seconds(&activity.observed_at, now_ms));
            format!("{} {age}", activity.value.as_str())
        });
        let fields = [
            a.name.as_str(),
            a.id.as_str(),
            a.harness.as_str(),
            a.state.as_str(),
            signal.as_str(),
            a.project.as_str(),
            a.cwd.as_str(),
        ];
        let given: Vec<&str> = fields.into_iter().filter(|f| !f.is_empty()).collect();
        lines.push(given.join("  "));
        if let Some(headline) = &a.headline {
            lines.push(format!("  > {}", headline.text));
        }
    }
    lines.join("\n")
}

/// The fleet for a program to read: each agent not ended, with its latest signal and its age,
/// whether mail reaches it now, its headline, its tasks, and the items it has open for the human.
pub(crate) fn fleet(s: &StateSnapshot, now_ms: i64) -> Vec<FleetAgent> {
    s.agents
        .iter()
        .filter(|a| !a.state.ended())
        .map(|a| FleetAgent {
            id: a.id.clone(),
            name: a.name.clone(),
            harness: a.harness,
            state: a.state,
            project: a.project.clone(),
            cwd: a.cwd.clone(),
            launched_by: a.launched_by.clone(),
            signal: a.activity.as_ref().map(|activity| FleetSignal {
                value: activity.value,
                source: activity.source,
                age_seconds: age_seconds(&activity.observed_at, now_ms),
            }),
            listening: a.listening,
            headline: a.headline.as_ref().map(|h| FleetHeadline {
                text: h.text.clone(),
                task_id: h.task_id.clone(),
                age_seconds: age_seconds(&h.at, now_ms),
            }),
            tasks: active_for(s, a.id.as_str())
                .into_iter()
                .map(|t| FleetTask {
                    task_id: t.task_id.clone(),
                    assignment_id: t.id.clone(),
                    role: t.role.clone(),
                })
                .collect(),
            attention: s
                .attention
                .iter()
                .filter(|i| i.agent_id == a.id && i.state == AttentionState::Open)
                .map(|i| FleetAttention {
                    id: i.id.clone(),
                    kind: i.kind.clone(),
                })
                .collect(),
        })
        .collect()
}

/// Each role with what it hands on and limits, then each role file that was skipped and why.
pub(crate) fn list_roles(r: &RolesResponse) -> String {
    let mut lines: Vec<String> = r
        .roles
        .iter()
        .map(|role| {
            let mut parts = vec![format!("{}  {}", role.key, role.title)];
            parts.push(if role.grants.is_empty() {
                "grants nothing".to_owned()
            } else {
                let grants: Vec<&str> = role.grants.iter().map(Role::as_str).collect();
                format!("grants {}", grants.join(", "))
            });
            if role.single_per_task {
                parts.push("one per task".to_owned());
            }
            if let Some(most) = role.max_active_tasks {
                parts.push(format!("at most {most} task(s) at once"));
            }
            if !role.description.is_empty() {
                parts.push(role.description.clone());
            }
            parts.join("  ")
        })
        .collect();
    lines.extend(
        r.problems
            .iter()
            .map(|p| format!("skipped {}: {}", p.file, p.problem)),
    );
    lines.join("\n")
}

/// Why `agents whoami` couldn't say: the daemon knows no such agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoSuchAgent(pub(crate) String);

/// The asking agent: its name and where it runs, each task it is on with its role, and whom it
/// reports to there: the agent holding the assignment it was given under, else the task's owner,
/// else the human.
pub(crate) fn whoami(s: &StateSnapshot, agent: &str) -> Result<String, NoSuchAgent> {
    let me = s
        .agents
        .iter()
        .find(|a| a.id.as_str() == agent)
        .ok_or_else(|| NoSuchAgent(agent.to_owned()))?;
    let launcher = me
        .launched_by
        .as_ref()
        .map_or_else(|| "the human".to_owned(), |by| shown(s, by));
    let role = me
        .role
        .as_ref()
        .map_or_else(String::new, |r| format!(", as a {r}"));
    let tasks: Vec<String> = active_for(s, agent)
        .into_iter()
        .map(|a| {
            let task = s.tasks.iter().find(|t| t.id == a.task_id);
            let giver = s
                .assignments
                .iter()
                .find(|p| Some(&p.id) == a.parent_assignment_id.as_ref())
                .map(|p| p.agent_id.clone())
                .or_else(|| task.and_then(|t| t.owner_agent_id.clone()));
            let to = giver.map_or_else(|| "the human".to_owned(), |g| shown(s, &g));
            let title = task.map_or("", |t| t.title.as_str());
            format!("  {}  {title}  as {}, reporting to {to}", a.task_id, a.role)
        })
        .collect();
    let mut lines = vec![
        format!("{}  {}", me.name, me.id),
        format!(
            "{}  {}  {}  {}",
            me.harness.as_str(),
            me.state.as_str(),
            me.project,
            me.cwd
        ),
        format!("launched by {launcher}{role}"),
    ];
    if tasks.is_empty() {
        lines.push("no tasks".to_owned());
    } else {
        lines.push("tasks:".to_owned());
        lines.extend(tasks);
    }
    Ok(lines.join("\n"))
}

/// Open tasks, each with its assignees. Given an agent, only the tasks it is assigned or owns.
pub(crate) fn list_tasks(s: &StateSnapshot, agent: Option<&str>) -> String {
    let active: Vec<&Assignment> = s
        .assignments
        .iter()
        .filter(|a| a.state == AssignmentState::Active)
        .collect();
    let tasks: Vec<&Task> = s
        .tasks
        .iter()
        .filter(|t| {
            t.state == TaskState::Open
                && agent.is_none_or(|me| {
                    t.owner_agent_id.as_ref().is_some_and(|o| o.as_str() == me)
                        || active
                            .iter()
                            .any(|a| a.task_id == t.id && a.agent_id.as_str() == me)
                })
        })
        .collect();
    if tasks.is_empty() {
        return if agent.is_none() {
            "no open tasks".to_owned()
        } else {
            "you have no open tasks".to_owned()
        };
    }
    let lines: Vec<String> = tasks
        .into_iter()
        .map(|t| {
            let who: Vec<String> = active
                .iter()
                .filter(|a| a.task_id == t.id)
                .map(|a| format!("{} {}", a.role, shown(s, &a.agent_id)))
                .collect();
            let who = if who.is_empty() {
                "unassigned".to_owned()
            } else {
                who.join(", ")
            };
            let parent = t
                .parent_task_id
                .as_ref()
                .map_or_else(String::new, |p| format!("  (part of {p})"));
            format!("{}  {}  [{who}]{parent}", t.id, t.title)
        })
        .collect();
    lines.join("\n")
}

fn note_writer(s: &StateSnapshot, n: &TaskNote) -> String {
    match &n.agent_id {
        None => "the human".to_owned(),
        Some(agent) => {
            let role = n.role.as_ref().map_or("owner", |r| r.as_str());
            format!("{}, its {role}", shown(s, agent))
        }
    }
}

pub(crate) fn show_task(d: &TaskDetail, s: &StateSnapshot) -> String {
    let owner = d
        .owner_agent_id
        .as_ref()
        .map_or_else(|| "the human".to_owned(), |o| shown(s, o));
    let parent = d
        .parent_task_id
        .as_ref()
        .map_or_else(String::new, |p| format!("; part of {p}"));
    let mut lines = vec![
        format!("{}  {}", d.id, d.title),
        format!("state: {}; owner: {owner}{parent}", d.state.as_str()),
    ];
    for a in &d.assignments {
        let state = if a.state == AssignmentState::Active {
            "active".to_owned()
        } else {
            let reason = a.end_reason.map_or("?", |r| r.as_str());
            format!("ended ({reason})")
        };
        lines.push(format!(
            "  {}  {} {}  {state}",
            a.id,
            a.role,
            shown(s, &a.agent_id)
        ));
    }
    for t in &d.subtasks {
        lines.push(format!(
            "  subtask {}  {}  {}",
            t.id,
            t.title,
            t.state.as_str()
        ));
    }
    lines.push(String::new());
    lines.push(d.brief.clone());
    for n in &d.notes {
        lines.push(String::new());
        let kind = if n.handoff { "handoff" } else { "note" };
        lines.push(format!("{kind} from {}, {}:", note_writer(s, n), n.at));
        lines.push(quote_note(&n.text));
    }
    if let Some(note) = &d.note {
        lines.push(String::new());
        lines.push("note:".to_owned());
        lines.push(quote_note(note));
    }
    lines.join("\n")
}
