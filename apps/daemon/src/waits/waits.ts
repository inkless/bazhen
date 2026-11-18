import type {
  Agent,
  AgentCondition,
  Shell,
  ShellCondition,
  StateSnapshot,
  Task,
  WaitCondition,
  WaitRequest,
  WaitResponse,
} from "@bazhen/protocol";
import type { Caller } from "@bazhen/core";
import { UnknownMessage } from "../mailbox/wait.ts";
import { UnknownShell } from "../shells/lifecycle.ts";
import { UnknownAgent, type Store } from "../store/store.ts";
import { UnknownTask } from "../tasks/tasks.ts";
import { realAfter, until, type After, type Judged } from "./until.ts";

/** A wait the caller may not make: a reply to a message it didn't send. */
export class WaitRefused extends Error {}

export interface WaitDeps {
  readonly store: Pick<Store, "onCommit" | "replyTo" | "turnAfterMail">;
  /**
   * What the caller's `/v1/state` shows now. Every judge reads its target here, so a wait tells
   * no one more than they can already read.
   */
  readonly view: () => StateSnapshot;
}

type Judge = (view: StateSnapshot, first: boolean) => Judged<WaitResponse>;

const ended = (state: string) => state === "closed" || state === "failed";

const named = (name: string | null | undefined, id: string) =>
  name === null || name === undefined || name === "" ? id : `${name} (${id})`;

const met = (said: string, on: Partial<WaitResponse> = {}): Judged<WaitResponse> => ({
  final: true,
  value: { verdict: "met", said, ...on },
});
const never = (said: string, on: Partial<WaitResponse> = {}): Judged<WaitResponse> => ({
  final: true,
  value: { verdict: "never", said, ...on },
});
const pending = (said: string, on: Partial<WaitResponse> = {}): Judged<WaitResponse> => ({
  final: false,
  value: { verdict: "pending", said, ...on },
});

/** What was there when the wait began is gone now: a closed shell leaves `/v1/state`. */
const gone = (id: string, want: string) =>
  want === "ended" ? met(`${id} is gone`) : never(`${id} is gone, and can't be ${want} now`);

/**
 * Idle: its harness said itself that a turn ended, nothing sent to it is still on the way, and
 * that turn ended after the last message reached it. Otherwise, why not, for a person.
 */
function idleness(store: WaitDeps["store"], agent: Agent): string | null {
  const turn = store.turnAfterMail(agent.id);
  if (turn.inFlight > 0) {
    return turn.inFlight === 1
      ? "1 message to it on the way"
      : `${turn.inFlight} messages on the way`;
  }
  const activity = turn.activity;
  if (activity === undefined || activity.source !== "native") return "no turn reported";
  if (activity.value !== "idle") return activity.value;
  const after = turn.lastSettled === null || (turn.activityAt ?? 0) > turn.lastSettled;
  return after ? null : "no turn since its last message";
}

function onAgent(store: WaitDeps["store"], agentId: string, want: AgentCondition): Judge {
  return (view, first) => {
    const agent = view.agents.find((a) => a.id === agentId);
    if (agent === undefined) {
      if (first) throw new UnknownAgent(agentId);
      return gone(agentId, want);
    }
    const label = named(agent.name, agent.id);
    const on = { agent };
    const now = agent.state;
    if (want === "ended")
      return ended(now) ? met(`${label} is ${now}`, on) : pending(`${label} is ${now}`, on);
    if (want === "ready" && now === "running") return met(`${label} is ready`, on);
    if (want === "idle" && now === "running") {
      const why = idleness(store, agent);
      return why === null
        ? met(`${label} is idle`, on)
        : pending(`${label} is running: ${why}`, on);
    }
    if (want === now) return met(`${label} is ${now}`, on);
    if (ended(now)) return never(`${label} is ${now}, and can't be ${want} now`, on);
    return pending(`${label} is ${now}`, on);
  };
}

function onShell(shellId: string, want: ShellCondition): Judge {
  return (view, first) => {
    const shell: Shell | undefined = view.shells.find((s) => s.id === shellId);
    if (shell === undefined) {
      if (first) throw new UnknownShell(shellId);
      return gone(shellId, want);
    }
    const label = named(shell.name, shell.id);
    const now = shell.state;
    const on = { shell };
    if (want === "ended" ? ended(now) : want === now) return met(`${label} is ${now}`, on);
    if (ended(now)) return never(`${label} is ${now}, and can't be ${want} now`, on);
    return pending(`${label} is ${now}`, on);
  };
}

/**
 * Done once the task is, or once nobody is still on it and someone completed their part: a
 * worker's own done ends only its assignment, and leaves the task for whoever gave it out.
 */
function onTask(taskId: string): Judge {
  return (view, first) => {
    const task: Task | undefined = view.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      if (first) throw new UnknownTask(taskId);
      return never(`${taskId} is gone`);
    }
    const label = named(task.title, task.id);
    const on = { task };
    if (task.state === "done") return met(`${label} is done`, on);
    if (task.state === "cancelled")
      return never(`${label} is cancelled, and can't be done now`, on);
    const its = view.assignments.filter((a) => a.taskId === taskId);
    const active = its.filter((a) => a.state === "active").length;
    if (active > 0) return pending(`${label} is open, with ${active} on it`, on);
    if (its.some((a) => a.endReason === "completed")) {
      return met(`${label} is open, and the work on it is done`, on);
    }
    return pending(`${label} is open, with no one on it`, on);
  };
}

/** The first message the recipient queued back to the sender after `messageId`. */
function onReply(store: WaitDeps["store"], messageId: string): Judge {
  return (view) => {
    const sent = store.replyTo(messageId);
    if (sent === undefined) throw new UnknownMessage(messageId);
    const agent = view.agents.find((a) => a.id === sent.to);
    const label = agent === undefined ? sent.to : named(agent.name, agent.id);
    const on = agent === undefined ? {} : { agent };
    if (sent.replyId !== null) return met(`${label} replied`, { ...on, replyId: sent.replyId });
    if (sent.state === "undeliverable") {
      return {
        final: true,
        value: { verdict: "bounced", said: `the message to ${label} bounced`, ...on },
      };
    }
    if (agent === undefined) return never(`${label} is gone`);
    if (ended(agent.state)) return never(`${label} is ${agent.state}, and can't reply now`, on);
    return pending(`${label} hasn't replied`, on);
  };
}

function judgeOf(store: WaitDeps["store"], condition: WaitCondition): Judge {
  if (condition.on === "agent") return onAgent(store, condition.agentId, condition.until);
  if (condition.on === "shell") return onShell(condition.shellId, condition.until);
  if (condition.on === "task") return onTask(condition.taskId);
  return onReply(store, condition.messageId);
}

/**
 * Answers once `req.condition` is met or can't be, judged now and again after each commit, or
 * at the timeout or when `signal` aborts, with where it stands then. A target the caller can't
 * read is refused at once, as is a reply wait by anyone but the message's sender: who mailed whom
 * isn't in `/v1/state`.
 */
export async function waitFor(
  deps: WaitDeps,
  caller: Caller,
  req: WaitRequest,
  signal: AbortSignal,
  after: After = realAfter,
): Promise<WaitResponse> {
  const { condition } = req;
  if (condition.on === "reply") {
    const sent = deps.store.replyTo(condition.messageId);
    if (sent === undefined) throw new UnknownMessage(condition.messageId);
    if (sent.from === null || sent.from !== caller) {
      throw new WaitRefused(
        `only the agent that sent ${condition.messageId} may wait for its reply`,
      );
    }
  }
  const judge = judgeOf(deps.store, condition);
  let first = true;
  return until(
    deps.store,
    () => {
      const judged = judge(deps.view(), first);
      first = false;
      return judged;
    },
    req.timeoutMs,
    signal,
    after,
  );
}
