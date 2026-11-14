import {
  checkDelegate,
  checkFinish,
  checkGrant,
  checkUnassign,
  isId,
  newId,
  TaskRefused,
  type AgentSessionId,
  type AssignmentId,
  type Caller,
} from "@bazhen/core";
import {
  AssignTaskResponse,
  CreateTaskResponse,
  EscalateResponse,
  TaskCommandResponse,
  type AgentState,
  type AssignTaskRequest,
  type CreateTaskRequest,
  type DelegateTaskRequest,
  type LaunchAgentRequest,
  type LaunchAgentResponse,
  type EscalateRequest,
  type FinishTaskRequest,
  type Role,
  type TaskOutcome,
  type UnassignTaskRequest,
} from "@bazhen/protocol";
import type { Raised } from "../attention/inbox.ts";
import { failureDetail } from "../commands.ts";
import type { Mailbox } from "../mailbox/mailbox.ts";
import { UnknownAgent, type Store } from "../store/store.ts";
import {
  assignedMail,
  CANCELLED_WITH_PARENT,
  cancelledMail,
  completedMail,
  finishedMail,
  lineEndedMail,
  ownedMail,
  MAIL_LIMIT,
  unassignedMail,
  type Named,
} from "./mail.ts";

/** What starts an agent for a delegation, and how far an agent may launch others. */
export interface Launcher {
  /**
   * Records the agent before it first yields, so the cap counts a launch on its way, and answers
   * once the launch has settled, a repeat's included, so a delegation never goes to an agent
   * whose launch then fails.
   */
  launch(req: LaunchAgentRequest, launchedBy: AgentSessionId): Promise<LaunchAgentResponse>;
  /** How many agents one agent may have launched and still open at once. */
  readonly maxLaunched: number;
  /** How many launches down an agent may still launch another. */
  readonly maxDepth: number;
}

export class UnknownTask extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`no task ${taskId}`);
    this.taskId = taskId;
  }
}

/** An agent in one of these states will never read what it is sent, so it can't take a task. */
const GONE: ReadonlySet<AgentState> = new Set<AgentState>(["closing", "closed", "failed"]);

const actor = (caller: Caller) => caller ?? "human";

/** How many of an agent's escalations may wait for the human at once. */
const OPEN_ESCALATIONS = 5;

/** The longest summary an inbox item carries; the rest is in the task. */
const SUMMARY_MAX = 500;

/** Text an agent wrote, made safe to show: no control or escape characters, and bounded. */
const printable = (text: string) => {
  const clean = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
};

/** What the human's inbox says of a task an agent finished. */
const doneSummary = (task: Named, note: string | null) =>
  printable(`Task ${task.id} (${task.title}) is done${note === null ? "." : `: ${note}`}`);

/** An agent in one of these states can't act: it is gone, or was never there. */
const CLOSED_CALLER: ReadonlySet<AgentState> = new Set<AgentState>([
  "closing",
  "closed",
  "failed",
  "lost",
]);

/** A composed message longer than the mailbox takes: the brief, or the note, is too long. */
export class MailTooLong extends Error {
  readonly length: number;

  constructor(length: number) {
    super(
      `the message to the agent would be ${length} characters, over the ${MAIL_LIMIT} a message may be: shorten the brief or note`,
    );
    this.length = length;
  }
}

function checkLength(body: string): string {
  if (body.length > MAIL_LIMIT) throw new MailTooLong(body.length);
  return body;
}

/**
 * Tasks and their assignments. Every command that gives an agent work, or takes it away, mails
 * that agent in the same transaction, so a task is never assigned to an agent that won't hear of
 * it: a target that takes no mail refuses the whole command.
 */
export class Tasks {
  private readonly store: Store;
  private readonly mailbox: Pick<Mailbox, "send">;
  /** The last event whose orphaned assignments have been told; none at start, so all are. */
  private closesSeen = 0;

  private readonly raise: (raised: Raised) => string;

  private readonly launcher: Launcher;

  /**
   * `raise` puts an item in the human's inbox, and answers with its id; `launcher` starts the
   * agent a delegation launches.
   */
  constructor(
    store: Store,
    mailbox: Pick<Mailbox, "send">,
    raise: (raised: Raised) => string,
    launcher: Launcher,
  ) {
    this.store = store;
    this.mailbox = mailbox;
    this.raise = raise;
    this.launcher = launcher;
  }

  create(caller: Caller, req: CreateTaskRequest): CreateTaskResponse {
    const { idempotencyKey, ...request } = req;
    return this.store.once(
      idempotencyKey,
      { caller, ...request },
      (r) => CreateTaskResponse.parse(r),
      () => {
        this.checkCaller(caller);
        const parentTaskId = req.parentTaskId ?? null;
        let delegatedFrom: AssignmentId | null = null;
        if (parentTaskId !== null) {
          const parent = this.view(parentTaskId);
          if (parent.state !== "open") {
            throw new TaskRefused("conflict", `the parent task is ${parent.state}`);
          }
          // An agent's subtask is a delegation: it needs the authority delegating would.
          if (caller !== null) delegatedFrom = checkDelegate(parent, caller, "worker");
        }
        const taskId = newId("task");
        const created = this.store.append({
          type: "task.created",
          entityId: taskId,
          actor: actor(caller),
          payload: {
            title: req.title,
            brief: req.brief,
            ownerAgentId: caller,
            parentTaskId,
            delegatedFrom,
          },
        });
        if (req.assign === undefined) return { taskId, assignmentId: null, eventIds: [created] };
        const from = parentTaskId === null || caller === null ? undefined : delegatedFrom;
        const granted = this.grant(caller, taskId, req.assign, idempotencyKey, from);
        return { taskId, ...granted, eventIds: [created, ...granted.eventIds] };
      },
    );
  }

  assign(caller: Caller, taskId: string, req: AssignTaskRequest): AssignTaskResponse {
    const { idempotencyKey, ...request } = req;
    return this.store.once(
      idempotencyKey,
      { caller, taskId, ...request },
      (r) => AssignTaskResponse.parse(r),
      () => {
        this.checkCaller(caller);
        return this.grant(caller, taskId, req, idempotencyKey);
      },
    );
  }

  /** Takes an assignment away, and with it every one granted under it, mailing each agent. */
  unassign(caller: Caller, taskId: string, req: UnassignTaskRequest): TaskCommandResponse {
    const { idempotencyKey, assignmentId } = req;
    return this.store.once(
      idempotencyKey,
      { caller, taskId, assignmentId },
      (r) => TaskCommandResponse.parse(r),
      () => {
        this.checkCaller(caller);
        const view = this.view(taskId);
        checkUnassign(view, caller, assignmentId, this.store.granters(assignmentId));
        const target = view.active.find((a) => a.id === assignmentId);
        const under = this.store.activeUnder([assignmentId]);
        const ended = this.store.append({
          type: "assignment.ended",
          entityId: assignmentId,
          actor: actor(caller),
          payload: { reason: "unassigned" },
        });
        const task = this.named(taskId);
        const mail = [
          ...this.tell(
            target === undefined ? [] : [target.agentId],
            unassignedMail(task, caller),
            caller,
            idempotencyKey,
          ),
          ...this.tellEach(
            under,
            (a) => lineEndedMail(this.named(a.taskId)),
            caller,
            idempotencyKey,
          ),
        ];
        return { eventIds: [ended, ...mail, ...this.liftStranded(idempotencyKey)] };
      },
    );
  }

  /**
   * Marks a task done or cancelled, cancelling its open subtasks first when asked to. Whoever
   * gave it out hears how it ended, and so does everyone still working on it, but nobody about
   * what they did themselves. From a worker, `done` completes only its own assignment, and tells
   * whoever gave it the work.
   */
  finish(caller: Caller, taskId: string, req: FinishTaskRequest): TaskCommandResponse {
    const { idempotencyKey, outcome } = req;
    const note = req.note ?? null;
    const cascade = req.cascade === true;
    return this.store.once(
      idempotencyKey,
      { caller, taskId, outcome, note, cascade },
      (r) => TaskCommandResponse.parse(r),
      () => {
        this.checkCaller(caller);
        const view = this.view(taskId);
        const finish = checkFinish(view, caller, outcome, cascade);
        const task = this.named(taskId);
        checkLength(finishedMail(task, outcome, caller, note));
        if (finish.kind === "assignment") {
          const own = finish.assignment;
          const ended = this.store.append({
            type: "assignment.ended",
            entityId: own.id,
            actor: actor(caller),
            payload: { reason: "completed" },
          });
          const giver = this.store.granters(own.id)[0] ?? view.ownerAgentId;
          const body = completedMail(task, own.agentId, note);
          // The human gave it this part; with no agent to tell, the human hears instead.
          if (giver === null) {
            const summary = printable(body);
            this.raise({ agentId: own.agentId, kind: "task_done", summary, taskId });
          }
          return {
            eventIds: [
              ended,
              ...this.tell(giver === null ? [] : [giver], body, caller, idempotencyKey),
              ...this.liftStranded(idempotencyKey),
            ],
          };
        }
        const subtasks = cascade ? this.store.openSubtasksUnder(taskId) : [];
        // Cancelling them with it is cancelling each, which no agent may do to the human's.
        const human = subtasks.filter((id) => this.view(id).ownerAgentId === null);
        if (caller !== null && human.length > 0) {
          throw new TaskRefused(
            "forbidden",
            `subtasks ${human.join(", ")} are the human's: only the human cancels them`,
          );
        }
        const cancelled = subtasks.flatMap((id) =>
          this.end(caller, id, "cancelled", CANCELLED_WITH_PARENT, `${idempotencyKey}:${id}`),
        );
        return {
          eventIds: [
            ...cancelled,
            ...this.end(caller, taskId, outcome, note, idempotencyKey),
            ...this.liftStranded(idempotencyKey),
          ],
        };
      },
    );
  }

  /** Records one task finished, and mails who gave it out and who was still on it. */
  private end(
    caller: Caller,
    taskId: string,
    outcome: TaskOutcome,
    note: string | null,
    key: string,
  ): number[] {
    const view = this.view(taskId);
    const task = this.named(taskId);
    const givers = new Set([
      ...(view.ownerAgentId === null ? [] : [view.ownerAgentId]),
      ...view.active.flatMap((a) => this.store.granters(a.id).slice(0, 1)),
    ]);
    const workers = view.active.map((a) => a.agentId).filter((id) => !givers.has(id));
    const finished = this.store.append({
      type: "task.finished",
      entityId: taskId,
      actor: actor(caller),
      payload: { outcome, note },
    });
    const told =
      outcome === "cancelled"
        ? cancelledMail(task, caller)
        : finishedMail(task, outcome, caller, note);
    // The human's task, done by an agent: the human hears through the inbox, not mail.
    if (outcome === "done" && view.ownerAgentId === null && caller !== null) {
      this.raise({ agentId: caller, kind: "task_done", summary: doneSummary(task, note), taskId });
    }
    return [
      finished,
      ...this.tell([...givers], finishedMail(task, outcome, caller, note), caller, `${key}:givers`),
      ...this.tell(workers, told, caller, `${key}:workers`),
    ];
  }

  /**
   * Puts an agent's question or problem in the human's inbox, about one of its own tasks when it
   * names one. Only an agent escalates; the human has nobody to escalate to.
   */
  escalate(caller: Caller, req: EscalateRequest): EscalateResponse {
    const { idempotencyKey, ...request } = req;
    return this.store.once(
      idempotencyKey,
      { caller, ...request },
      (r) => EscalateResponse.parse(r),
      () => {
        if (caller === null) throw new TaskRefused("forbidden", "only an agent escalates");
        this.checkCaller(caller);
        const taskId = req.taskId ?? null;
        if (taskId !== null) {
          const view = this.view(taskId);
          if (view.state !== "open")
            throw new TaskRefused("conflict", `${taskId} is ${view.state}`);
          const owned = view.ownerHolds && view.ownerAgentId === caller;
          if (!owned && !view.active.some((a) => a.agentId === caller)) {
            throw new TaskRefused("forbidden", `${taskId} is not one of your tasks`);
          }
        }
        const open = this.store.openAttention(caller).filter((i) => i.kind === "escalation");
        const same = open.find((i) => i.taskId === taskId);
        if (same !== undefined) {
          throw new TaskRefused(
            "conflict",
            `${same.id} already asks the human this; wait for its answer`,
          );
        }
        if (open.length >= OPEN_ESCALATIONS) {
          throw new TaskRefused(
            "conflict",
            `${open.length} of your escalations wait for answers already`,
          );
        }
        const about = taskId === null ? {} : { taskId };
        const summary = printable(req.summary);
        return {
          attentionId: this.raise({ agentId: caller, kind: "escalation", summary, ...about }),
        };
      },
    );
  }

  /**
   * Hands part of a task the caller coordinates or leads to another agent, as a subtask the
   * caller owns; with `launch`, to a new agent it launches for it. Whoever finishes it tells the
   * caller.
   */
  delegate(caller: Caller, req: DelegateTaskRequest): CreateTaskResponse {
    const { idempotencyKey: _key, ...request } = req;
    if (req.agentId === undefined)
      throw new TaskRefused("conflict", "name the agent, or launch one");
    return this.delegateTo(caller, req, req.agentId, { caller, ...request });
  }

  /** `delegate` to a new agent, started for the subtask as `req.launch` asks. */
  async launchAndDelegate(caller: Caller, req: DelegateTaskRequest): Promise<CreateTaskResponse> {
    const { idempotencyKey, ...request } = req;
    const asked = { caller, ...request };
    if (req.launch === undefined) return this.delegate(caller, req);
    const prior = this.store.replay(idempotencyKey, asked, (r) => CreateTaskResponse.parse(r));
    if (prior !== undefined) return prior;
    // Everything that would refuse the delegation is checked before an agent is started for it.
    const { parentTaskId } = this.checkDelegation(caller, req);
    const by = this.agentCaller(caller);
    const task = { id: newId("task"), title: req.title, brief: req.brief, parentTaskId };
    checkLength(assignedMail(task, req.role, by));
    const key = `${idempotencyKey}:launch:${by}`;
    // A launch this command already made is replayed, not counted again against the limits.
    const fresh = this.store.recall(key) === undefined;
    if (fresh) this.checkLaunchLimits(by);
    const cwd = req.launch.cwd ?? this.store.agentLaunch(by)?.launch.cwd;
    if (cwd === undefined) throw new UnknownAgent(by);
    const launch = { idempotencyKey: key, harness: req.launch.harness, cwd };
    const { agentId } = await this.launcher.launch(launch, by);
    try {
      return this.delegateTo(caller, req, agentId, asked);
    } catch (err) {
      // The agent runs, but the work it was started for was refused while it started: the
      // human decides what becomes of it, rather than it running on unseen.
      if (fresh && err instanceof Error) {
        this.raise({
          agentId,
          kind: "escalation",
          summary: printable(
            `${by} launched this agent to delegate "${req.title}" to it, but the delegation was then refused (${failureDetail(err)}). Close it if it isn't needed.`,
          ),
        });
      }
      throw err;
    }
  }

  /** The subtask, given to `agentId`, in one transaction under the command's key. */
  private delegateTo(
    caller: Caller,
    req: DelegateTaskRequest,
    agentId: string,
    asked: object,
  ): CreateTaskResponse {
    return this.store.once(
      req.idempotencyKey,
      asked,
      (r) => CreateTaskResponse.parse(r),
      () => {
        const { parentTaskId, from } = this.checkDelegation(caller, req);
        if (agentId === caller) {
          throw new TaskRefused("forbidden", "an agent can't delegate to itself");
        }
        const above = [
          ...(from === null ? [] : this.store.granters(from)),
          ...this.store.aboveOnTree(parentTaskId),
        ];
        if (above.some((agent) => agent === agentId)) {
          throw new TaskRefused(
            "forbidden",
            `${agentId} gave you this work: delegate down, to an agent below you`,
          );
        }
        const taskId = newId("task");
        const created = this.store.append({
          type: "task.created",
          entityId: taskId,
          actor: String(caller),
          payload: {
            title: req.title,
            brief: req.brief,
            ownerAgentId: caller,
            parentTaskId,
            delegatedFrom: from,
          },
        });
        const grant = { agentId, role: req.role };
        const granted = this.grant(caller, taskId, grant, req.idempotencyKey, from);
        return { taskId, ...granted, eventIds: [created, ...granted.eventIds] };
      },
    );
  }

  /** The parent a delegation is part of, and the assignment it hands on from, or a refusal. */
  private checkDelegation(caller: Caller, req: DelegateTaskRequest) {
    if (caller === null) throw new TaskRefused("forbidden", "only an agent delegates");
    this.checkCaller(caller);
    const parentTaskId = req.fromTaskId ?? this.delegatingTask(caller);
    return { parentTaskId, from: checkDelegate(this.view(parentTaskId), caller, req.role) };
  }

  /** The caller, as an agent: only an agent delegates. */
  private agentCaller(caller: Caller): AgentSessionId {
    if (caller === null) throw new TaskRefused("forbidden", "only an agent delegates");
    return caller;
  }

  /**
   * Checks the agent may launch another now: under its cap of open agents it launched, those
   * still starting included, and not itself so far down a chain of launches that another would
   * run away.
   */
  private checkLaunchLimits(by: AgentSessionId): void {
    const { maxLaunched, maxDepth } = this.launcher;
    const open = this.store.liveLaunchedBy(by);
    if (open >= maxLaunched) {
      throw new TaskRefused(
        "conflict",
        `${open} agents you launched are still open, the most at once (${maxLaunched}): close one you no longer need to launch another`,
      );
    }
    if (this.store.launchDepth(by) >= maxDepth) {
      throw new TaskRefused(
        "conflict",
        `you were launched ${maxDepth} launches down, the deepest that may launch: delegate to an agent that is already running`,
      );
    }
  }

  /** The one task the agent coordinates or leads, which an unqualified delegate is part of. */
  private delegatingTask(agentId: string): string {
    const held = this.store
      .assignments({ agentId }, "active")
      .filter((a) => a.role !== "worker")
      .map((a) => a.taskId);
    const [only, ...more] = [...new Set(held)];
    if (only !== undefined && more.length === 0) return only;
    const which =
      only === undefined
        ? "it coordinates or leads no task"
        : `name one of ${[only, ...more].join(", ")}`;
    throw new TaskRefused("conflict", `say which task to delegate from: ${which}`);
  }

  /** Grants the role, then mails the brief, last, so a refused send leaves nothing recorded. */
  private grant(
    caller: Caller,
    taskId: string,
    req: { readonly agentId: string; readonly role: Role },
    key: string,
    delegatedFrom?: AssignmentId | null,
  ): AssignTaskResponse {
    const agentId = req.agentId;
    if (!this.reachable(agentId)) throw new UnknownAgent(agentId, "that can take a task");
    const view = this.view(taskId);
    const detail = this.store.taskDetail(taskId);
    if (detail === undefined) throw new UnknownTask(taskId);
    const body = checkLength(assignedMail(detail, req.role, caller));
    const checked = checkGrant(view, caller, { agentId, role: req.role });
    const parentAssignmentId = delegatedFrom === undefined ? checked : delegatedFrom;
    const assignmentId = newId("asgn");
    const granted = this.store.append({
      type: "assignment.granted",
      entityId: assignmentId,
      actor: actor(caller),
      payload: { taskId, agentId, role: req.role, parentAssignmentId },
    });
    const sent = this.mailbox.send(agentId, { idempotencyKey: `${key}:assigned`, body });
    return { assignmentId, eventIds: [granted, ...sent.eventIds] };
  }

  /**
   * Mails each agent but the caller, under keys derived from the command's, so a retry mails no
   * one twice. An agent that can't take mail now, gone or a Codex agent with no thread, goes
   * untold: the command already happened, and the dashboard shows it.
   */
  private tell(agents: readonly string[], body: string, caller: Caller, key: string): number[] {
    return this.tellEach(
      [...new Set(agents)].map((agentId) => ({ agentId, id: agentId })),
      () => body,
      caller,
      key,
    );
  }

  /** Mails each one its own body, keyed by the command's key and its `id`. */
  private tellEach<T extends { readonly agentId: string; readonly id: string }>(
    to: readonly T[],
    mail: (t: T) => string,
    caller: Caller,
    key: string,
  ): number[] {
    return to.flatMap((t) => {
      if (t.agentId === caller || !this.reachable(t.agentId)) return [];
      const body = mail(t);
      try {
        return this.mailbox.send(t.agentId, { idempotencyKey: `${key}:${t.id}`, body }).eventIds;
      } catch (err) {
        if (err instanceof UnknownAgent) return [];
        throw err;
      }
    });
  }

  /**
   * Moves each subtask whose owner no longer holds it up to its parent's owner, and tells the new
   * owner. A move can strand the next level down, so it repeats until none is left; each pass
   * lifts a subtask one level, so it ends within the tree's depth.
   */
  private liftStranded(key: string): number[] {
    const events: number[] = [];
    for (
      let stranded = this.store.stranded();
      stranded.length > 0;
      stranded = this.store.stranded()
    ) {
      for (const lifted of stranded) {
        const { taskId } = lifted;
        const previous = this.view(taskId).ownerAgentId;
        // An owner that is gone can't take the task; it falls to the human rather than up a tree
        // whose other owners' standing nothing has checked.
        const live = lifted.ownerAgentId !== null && this.reachable(lifted.ownerAgentId);
        const ownerAgentId = live ? lifted.ownerAgentId : null;
        const from = lifted.delegatedFrom;
        const delegatedFrom = live && from !== null && isId("asgn", from) ? from : null;
        events.push(
          this.store.append({
            type: "task.owner_changed",
            entityId: taskId,
            actor: "system",
            payload: { ownerAgentId, delegatedFrom },
          }),
        );
        if (ownerAgentId === null) {
          const task = this.named(taskId);
          if (previous !== null) {
            this.raise({
              agentId: previous,
              kind: "escalation",
              summary: `Task ${task.id} (${task.title}) is yours now: ${previous}, who delegated it, no longer holds the work it is part of.`,
              taskId,
            });
          }
          continue;
        }
        const to = [{ agentId: ownerAgentId, id: `owner:${taskId}:${ownerAgentId}` }];
        events.push(...this.tellEach(to, () => ownedMail(this.named(taskId)), null, key));
      }
    }
    return events;
  }

  /**
   * Mails the agents whose assignments ended because an agent they were granted under closed.
   * Run after each commit; the mail's key is the assignment's, so a scan after a restart that
   * finds them again mails no one twice.
   */
  private tellOrphans(): void {
    this.store.transaction(() => this.liftStranded("lifted"));
    for (const a of this.store.endedByClose(this.closesSeen)) {
      this.closesSeen = Math.max(this.closesSeen, a.eventId);
      this.tellEach([a], () => lineEndedMail(this.named(a.taskId)), null, "closed");
    }
  }

  /** Starts telling agents whose granter closed; returns the stop function. */
  watch(): () => void {
    this.tellOrphans();
    return this.store.onCommit(() => this.tellOrphans());
  }

  /** Whether the agent runs here and will read what it is sent. */
  private reachable(agentId: string): agentId is AgentSessionId {
    const state = this.store.agentTerminal({ agentId })?.state;
    return state !== undefined && !GONE.has(state);
  }

  /**
   * The caller says which agent it is, which is trusted as any local process of the user is
   * (foundation-design §9.4); it must at least be an agent this daemon runs and that is still
   * open, so a stale `BAZHEN_AGENT_ID` can't act.
   */
  private checkCaller(caller: Caller): void {
    if (caller === null) return;
    const state = this.store.agentTerminal({ agentId: caller })?.state;
    if (state === undefined || CLOSED_CALLER.has(state))
      throw new UnknownAgent(caller, "that is open");
  }

  private view(taskId: string) {
    const view = this.store.taskView(taskId);
    if (view === undefined) throw new UnknownTask(taskId);
    return view;
  }

  private named(taskId: string): Named {
    const detail = this.store.taskDetail(taskId);
    if (detail === undefined) throw new UnknownTask(taskId);
    return detail;
  }
}
