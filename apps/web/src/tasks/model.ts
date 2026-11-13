import type { Agent, Assignment, Role, StateSnapshot, Task } from "@bazhen/protocol";

/** Who holds a role on a task, as a row names them: the agent's project and its short id. */
export interface Holder {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly role: Role;
  readonly project: string | null;
}

/** One task in the tree, with who is on it now and its subtasks beneath it. */
export interface TaskNode {
  readonly task: Task;
  readonly holders: readonly Holder[];
  readonly children: readonly TaskNode[];
}

const ROLE_ORDER: Readonly<Record<Role, number>> = { coordinator: 0, lead: 1, worker: 2 };

/** A task's active assignments, coordinator first, each with its agent's project. */
export function holdersOf(state: StateSnapshot, taskId: string): Holder[] {
  const projects = new Map(state.agents.map((a) => [a.id, a.project]));
  return state.assignments
    .filter((a) => a.taskId === taskId && a.state === "active")
    .toSorted((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
    .map((a: Assignment) => ({
      assignmentId: a.id,
      agentId: a.agentId,
      role: a.role,
      project: projects.get(a.agentId) ?? null,
    }));
}

/**
 * The tasks as a tree: each under its parent, the oldest first. Finished tasks are left out
 * unless `finished` asks for them, and a subtask whose parent is left out stands at the top.
 */
export function taskTree(state: StateSnapshot, finished = false): TaskNode[] {
  const shown = state.tasks.filter((t) => finished || t.state === "open");
  const ids = new Set(shown.map((t) => t.id));
  const children = Map.groupBy(shown, (t) =>
    t.parentTaskId !== null && ids.has(t.parentTaskId) ? t.parentTaskId : null,
  );
  const nodes = (parent: string | null): TaskNode[] =>
    (children.get(parent) ?? []).map((task) => ({
      task,
      holders: holdersOf(state, task.id),
      children: nodes(task.id),
    }));
  return nodes(null);
}

/**
 * Every open task below this one, however deep and under any parent, as cancelling it with its
 * subtasks cancels them in the daemon.
 */
export function openSubtasksUnder(state: StateSnapshot, taskId: string): Task[] {
  const below = Map.groupBy(state.tasks, (t) => t.parentTaskId);
  const under = (id: string): Task[] => (below.get(id) ?? []).flatMap((t) => [t, ...under(t.id)]);
  return under(taskId).filter((t) => t.state === "open");
}

/** The agent that launched this one, by id and project, or null when the human did. */
export function launcherOf(
  state: { readonly agents: readonly Pick<Agent, "id" | "project" | "launchedBy">[] },
  agentId: string,
): { id: string; project: string | null } | null {
  const by = state.agents.find((a) => a.id === agentId)?.launchedBy ?? null;
  if (by === null) return null;
  return { id: by, project: state.agents.find((a) => a.id === by)?.project ?? null };
}

/** The open tasks an agent is on now, with its role on each. */
export function agentTasks(state: StateSnapshot, agentId: string): { task: Task; role: Role }[] {
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  return state.assignments.flatMap((a) => {
    const task = tasks.get(a.taskId);
    if (a.agentId !== agentId || a.state !== "active" || task?.state !== "open") return [];
    return [{ task, role: a.role }];
  });
}
