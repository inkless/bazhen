import { useEffect, useEffectEvent, useRef, useState, type SubmitEvent } from "react";
import {
  Role,
  TaskBrief,
  TaskTitle,
  type StateSnapshot,
  type TaskDetail,
  type TaskOutcome,
} from "@bazhen/protocol";
import { Refused, assignTask, createTask, fetchTask, finishTask, unassignTask } from "../api.ts";
import { shortId } from "../fleet/model.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import {
  agentTasks,
  holdersOf,
  openSubtasksUnder,
  taskTree,
  type Holder,
  type TaskNode,
} from "./model.ts";

interface Opening {
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenAgent: (agentId: string) => void;
  readonly failed: (e: unknown) => void;
}

const ROLES = Role.options;
const BRIEF_MAX = TaskBrief.maxLength ?? undefined;
const TITLE_MAX = TaskTitle.maxLength ?? undefined;

/** One request at a time from a form or row: a second press sends nothing while one is out. */
function useOnce(failed: (e: unknown) => void) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = (request: () => Promise<unknown>, done?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    request()
      .then(done, failed)
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };
  return { busy, run };
}

/** Picks an agent and the role it is given, as the assign and create forms both do. */
function AssigneeFields({
  state,
  agentId,
  role,
  onAgent,
  onRole,
  optional,
}: {
  state: StateSnapshot;
  agentId: string;
  role: Role;
  onAgent: (agentId: string) => void;
  onRole: (role: Role) => void;
  optional: boolean;
}) {
  return (
    <>
      <label>
        Agent{" "}
        <select value={agentId} onChange={(e) => onAgent(e.target.value)}>
          {optional && <option value="">No one yet</option>}
          {state.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.project} ({shortId(a.id)})
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Role{" "}
        <select value={role} onChange={(e) => onRole(Role.parse(e.target.value))}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** Who is on a task, each naming the agent it opens. */
function Holders({
  holders,
  onOpenAgent,
}: { holders: readonly Holder[] } & Pick<Opening, "onOpenAgent">) {
  if (holders.length === 0) return <span className="note">No one is on it.</span>;
  return (
    <>
      {holders.map((h) => (
        <span key={h.assignmentId} className="task-holder">
          {h.role}{" "}
          <Button variant="link" onPress={() => onOpenAgent(h.agentId)}>
            {h.project ?? "an agent"}
          </Button>{" "}
          <span className="id">{shortId(h.agentId)}</span>
        </span>
      ))}
    </>
  );
}

/** A new task: a title, its brief, and, if the human picks one, the agent to give it to. */
function NewTask({
  state,
  onOpenTask,
  failed,
}: { state: StateSnapshot } & Pick<Opening, "onOpenTask" | "failed">) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [agentId, setAgentId] = useState("");
  const [role, setRole] = useState<Role>("coordinator");
  const { busy, run } = useOnce(failed);
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const assign = agentId === "" ? undefined : { agentId, role };
    run(
      () => createTask(title.trim(), brief, assign).then((r) => onOpenTask(r.taskId)),
      () => {
        setTitle("");
        setBrief("");
      },
    );
  };
  return (
    <form className="task-form" aria-label="new task" onSubmit={submit}>
      <label>
        Title{" "}
        <input
          value={title}
          maxLength={TITLE_MAX}
          required
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Brief
        <textarea
          value={brief}
          maxLength={BRIEF_MAX}
          required
          rows={4}
          onChange={(e) => setBrief(e.target.value)}
        />
      </label>
      <div>
        <AssigneeFields
          state={state}
          agentId={agentId}
          role={role}
          onAgent={setAgentId}
          onRole={setRole}
          optional
        />
      </div>
      <Button type="submit" variant="primary" isDisabled={busy}>
        Create task
      </Button>
    </form>
  );
}

/** Tasks and, nested beneath each, its subtasks, so a screen reader says how deep each is. */
function TaskList({
  nodes,
  label,
  ...opening
}: Opening & { nodes: readonly TaskNode[]; label: string }) {
  return (
    <ul className="inbox-list task-list" aria-label={label}>
      {nodes.map(({ task, holders, children }) => (
        <li key={task.id} className="task-row">
          <div className="inbox-item">
            <Button variant="link" onPress={() => opening.onOpenTask(task.id)}>
              {task.title}
            </Button>{" "}
            {task.state !== "open" && <span className="badge badge-plain">{task.state}</span>}{" "}
            <Holders holders={holders} onOpenAgent={opening.onOpenAgent} />
          </div>
          {children.length > 0 && (
            <TaskList nodes={children} label={`subtasks of ${task.title}`} {...opening} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Every open task, each under its parent, with who is on it, and the form for a new one. */
export function TasksView({ state, ...opening }: Opening & { state: StateSnapshot }) {
  const [finished, setFinished] = useState(false);
  const nodes = taskTree(state, finished);
  return (
    <section className="tasks" aria-label="tasks">
      <header className="inbox-head">
        <h2>Tasks</h2>
      </header>
      {nodes.length === 0 && <p className="empty">No open tasks.</p>}
      <TaskList nodes={nodes} label="task list" {...opening} />
      <Button variant="link" onPress={() => setFinished(!finished)}>
        {finished ? "Hide finished tasks" : "Show finished tasks"}
      </Button>
      <NewTask state={state} onOpenTask={opening.onOpenTask} failed={opening.failed} />
    </section>
  );
}

/**
 * The task in full, read again whenever its own part of the state moves, with what the human can
 * do to it.
 */
export function TaskPage({
  state,
  taskId,
  ...opening
}: Opening & { state: StateSnapshot; taskId: string }) {
  const [read, setRead] = useState<{ detail: TaskDetail | "missing"; at: string } | null>(null);
  const [agentId, setAgentId] = useState("");
  const [role, setRole] = useState<Role>("worker");
  const { busy, run } = useOnce(opening.failed);
  const onFailed = useEffectEvent((e: unknown) => opening.failed(e));
  // What the snapshot shows of this task; the brief and note change only with it.
  const shown = JSON.stringify([
    state.tasks.filter((t) => t.id === taskId || t.parentTaskId === taskId),
    state.assignments.filter((a) => a.taskId === taskId),
  ]);
  useEffect(() => {
    let current = true;
    fetchTask(taskId).then(
      (detail) => current && setRead({ detail, at: shown }),
      (e: unknown) => {
        if (!current) return;
        if (e instanceof Refused && e.code === "not_found")
          setRead({ detail: "missing", at: shown });
        else onFailed(e);
      },
    );
    return () => {
      current = false;
    };
  }, [taskId, shown]);
  if (read === null) return <p role="status">Reading the task…</p>;
  const { detail } = read;
  if (detail === "missing") return <p role="status">No such task.</p>;
  const open = detail.state === "open";
  const below = openSubtasksUnder(state, taskId);
  const pick = agentId || (state.agents[0]?.id ?? "");
  const finish = (outcome: TaskOutcome) =>
    run(() => finishTask(taskId, outcome, outcome === "cancelled" && below.length > 0));
  const cancelling =
    below.length === 0
      ? `Cancel ${detail.title}? Everyone on it is told to stop.`
      : `Cancel ${detail.title} and its ${below.length} open subtasks (${below.map((t) => t.title).join(", ")})? Everyone on them is told to stop.`;
  const ended = detail.assignments.filter((a) => a.state === "ended");
  return (
    <article className="task" aria-label="task">
      <header className="inbox-head">
        <h2>{detail.title}</h2>
        <span className="badge badge-plain">{detail.state}</span>
        <span className="id">{shortId(detail.id)}</span>
      </header>
      <p className="note">
        {detail.ownerAgentId === null ? "Yours" : `Owned by ${shortId(detail.ownerAgentId)}`}
        {detail.parentTaskId !== null && (
          <>
            {", part of "}
            <Button variant="link" onPress={() => opening.onOpenTask(String(detail.parentTaskId))}>
              its parent task
            </Button>
          </>
        )}
      </p>
      <p className="task-brief">{detail.brief}</p>
      {detail.note !== null && <p className="task-brief">Note: {detail.note}</p>}
      <h3>On it</h3>
      <ul className="inbox-list" aria-label="assignments">
        {holdersOf(state, taskId).map((h) => (
          <li key={h.assignmentId} className="inbox-item">
            <Holders holders={[h]} onOpenAgent={opening.onOpenAgent} />{" "}
            {open && (
              <Button
                isDisabled={busy}
                onPress={() => run(() => unassignTask(taskId, h.assignmentId))}
              >
                Unassign
              </Button>
            )}
          </li>
        ))}
      </ul>
      {ended.length > 0 && (
        <p className="note">
          Before:{" "}
          {ended
            .map((a) => `${a.role} ${shortId(a.agentId)} (${a.endReason ?? "ended"})`)
            .join(", ")}
        </p>
      )}
      {open && (
        <form
          className="task-form"
          aria-label="assign"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick !== "") run(() => assignTask(taskId, pick, role));
          }}
        >
          <AssigneeFields
            state={state}
            agentId={pick}
            role={role}
            onAgent={setAgentId}
            onRole={setRole}
            optional={false}
          />{" "}
          <Button type="submit" isDisabled={busy || pick === ""}>
            Assign
          </Button>
        </form>
      )}
      {detail.subtasks.length > 0 && (
        <>
          <h3>Subtasks</h3>
          <ul className="inbox-list" aria-label="subtasks">
            {detail.subtasks.map((t) => (
              <li key={t.id} className="inbox-item">
                <Button variant="link" onPress={() => opening.onOpenTask(t.id)}>
                  {t.title}
                </Button>{" "}
                <span className="badge badge-plain">{t.state}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <div className="task-actions">
          <Button
            variant="primary"
            isDisabled={busy || below.length > 0}
            onPress={() => finish("done")}
          >
            Mark done
          </Button>
          <ConfirmDialog
            isDisabled={busy}
            trigger="Cancel task…"
            title="Cancel task"
            message={cancelling}
            confirm={
              below.length === 0 ? "Cancel task" : `Cancel task and ${below.length} subtasks`
            }
            onConfirm={() => finish("cancelled")}
          />
          {below.length > 0 && (
            <span className="note">
              Its open subtasks must finish before it can be marked done.
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** The open tasks an agent is on, shown above its terminal. */
export function AgentTasks({
  state,
  agentId,
  onOpenTask,
}: { state: StateSnapshot; agentId: string } & Pick<Opening, "onOpenTask">) {
  const tasks = agentTasks(state, agentId);
  if (tasks.length === 0) return null;
  return (
    <ul className="inbox-list agent-tasks" aria-label="assigned tasks">
      {tasks.map(({ task, role }) => (
        <li key={task.id}>
          {role} on{" "}
          <Button variant="link" onPress={() => onOpenTask(task.id)}>
            {task.title}
          </Button>
        </li>
      ))}
    </ul>
  );
}
