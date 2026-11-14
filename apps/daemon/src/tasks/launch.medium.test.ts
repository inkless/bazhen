import { describe, expect, it } from "vitest";
import { isId, LaunchFailed, newId, TaskRefused, type AgentSessionId } from "@bazhen/core";
import { inbox, taskFleet, testView } from "../testing/fixtures.ts";
import type { Raised } from "../attention/inbox.ts";
import { MailTooLong, Tasks } from "./tasks.ts";

const brief = { title: "Fix the build", brief: "It fails on Node 26." };
const sub = { title: "Pin Node", brief: "Pin Node 24 in CI." };
const launch = { harness: "claude-code" as const };
const work = { role: "worker" as const, ...sub };
const launchRequest = (key: string) => ({ idempotencyKey: key, launch, ...work });

/**
 * A task the human gave `coordinator` to coordinate, on a fleet with these launch limits, whose
 * delegations launch their agents with `delegated`.
 */
async function coordinated(
  limits = { maxLaunched: 5, maxDepth: 3 },
  delegated?: Parameters<typeof taskFleet>[1],
) {
  const f = await taskFleet(limits, delegated);
  const { taskId } = f.tasks.create(null, {
    idempotencyKey: "c",
    ...brief,
    assign: { agentId: f.coordinator, role: "coordinator" },
  });
  const agents = () => f.store.snapshot(testView).agents;
  return { ...f, parentId: taskId, agents };
}

/** The id as an agent's, or a failure to say the test's setup went wrong. */
function agentOf(id: string | undefined): AgentSessionId {
  if (id === undefined || !isId("agent", id)) throw new Error(`not an agent: ${id}`);
  return id;
}

/** The code a refused command threw, or "allowed". */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TaskRefused) return `${err.code}: ${err.message}`;
    throw err;
  }
  return "allowed";
}

/** An environment that refuses a launch once the work already under way has run. */
const tmuxRefuses = () =>
  new Promise<never>((_, reject) => setImmediate(() => reject(new Error("no tmux"))));

/** What a settled promise was rejected with, as text; nothing for one that was fulfilled. */
const reasons = (r: PromiseSettledResult<unknown>): string[] =>
  r.status === "rejected" ? [String(r.reason)] : [];

describe("delegating to a new agent", () => {
  it("launches one in the delegator's directory, records who launched it, and mails it the brief", async () => {
    const { store, tasks, coordinator, agents } = await coordinated();
    const req = { idempotencyKey: "d", launch, role: "worker" as const, ...sub };
    const { taskId } = await tasks.launchAndDelegate(coordinator, req);
    const worker = agentOf(store.taskDetail(taskId)?.assignments[0]?.agentId);
    const launched = agents().find((a) => a.id === worker);
    const own = agents().find((a) => a.id === coordinator);
    expect([launched?.launchedBy, launched?.cwd]).toEqual([coordinator, own?.cwd]);
    expect(inbox(store, worker).at(-1)).toContain("Pin Node 24 in CI.");
  });

  it("launches and delegates once for a repeated request, the cap notwithstanding", async () => {
    const { tasks, coordinator, agents } = await coordinated({ maxLaunched: 1, maxDepth: 3 });
    const req = { idempotencyKey: "d", launch, role: "worker" as const, ...sub };
    const first = await tasks.launchAndDelegate(coordinator, req);
    const count = agents().length;
    expect([await tasks.launchAndDelegate(coordinator, req), agents().length]).toEqual([
      first,
      count,
    ]);
  });

  it("refuses past the cap of open agents it launched, launching nothing more", async () => {
    const { tasks, coordinator, agents } = await coordinated({ maxLaunched: 1, maxDepth: 3 });
    await tasks.launchAndDelegate(coordinator, launchRequest("d1"));
    const count = agents().length;
    expect([
      await refusal(() => tasks.launchAndDelegate(coordinator, launchRequest("d2"))),
      agents().length,
    ]).toEqual([
      "conflict: 1 agents you launched are still open, the most at once (1): close one you no longer need to launch another",
      count,
    ]);
  });

  it("refuses an agent that was itself launched as deep as launches may go", async () => {
    const { store, tasks, coordinator } = await coordinated({ maxLaunched: 5, maxDepth: 1 });
    const lead = { idempotencyKey: "d1", launch, role: "lead" as const, ...sub };
    const { taskId } = await tasks.launchAndDelegate(coordinator, lead);
    const launched = agentOf(store.taskDetail(taskId)?.assignments[0]?.agentId);
    const deeper = { idempotencyKey: "d2", fromTaskId: taskId, launch, ...work };
    expect(await refusal(() => tasks.launchAndDelegate(launched, deeper))).toMatch(
      /^conflict: you were launched 1 launches down/,
    );
  });

  it("launches nothing for a delegation it would refuse anyway", async () => {
    const { tasks, worker, agents } = await coordinated();
    const count = agents().length;
    const req = { idempotencyKey: "d", launch, role: "worker" as const, ...sub };
    expect([await refusal(() => tasks.launchAndDelegate(worker, req)), agents().length]).toEqual([
      expect.stringMatching(/^conflict: say which task/),
      count,
    ]);
  });

  it("delegates nothing when the launch fails", async () => {
    const { store, mailbox, coordinator } = await coordinated();
    const failing = {
      launch: () => Promise.reject(new LaunchFailed(newId("agent"), "no tmux")),
      maxLaunched: 5,
      maxDepth: 3,
    };
    const tasks = new Tasks(store, mailbox, () => newId("attn"), failing);
    const req = { idempotencyKey: "d", launch, role: "worker" as const, ...sub };
    await expect(tasks.launchAndDelegate(coordinator, req)).rejects.toThrow(LaunchFailed);
    expect(store.snapshot(testView).tasks.map((t) => t.title)).toEqual(["Fix the build"]);
  });

  it("launches and delegates once for a request repeated in the same tick", async () => {
    const { store, tasks, coordinator, agents } = await coordinated();
    const count = agents().length;
    const [first, again] = await Promise.all([
      tasks.launchAndDelegate(coordinator, launchRequest("d")),
      tasks.launchAndDelegate(coordinator, launchRequest("d")),
    ]);
    const subtasks = store.snapshot(testView).tasks.filter((t) => t.title === sub.title);
    expect([again, agents().length, subtasks.length]).toEqual([first, count + 1, 1]);
  });

  it("delegates nothing for a request repeated while its launch fails", async () => {
    const { store, tasks, coordinator, agents } = await coordinated(undefined, tmuxRefuses);
    const count = agents().length;
    const both = await Promise.allSettled([
      tasks.launchAndDelegate(coordinator, launchRequest("d")),
      tasks.launchAndDelegate(coordinator, launchRequest("d")),
    ]);
    const failed = expect.stringMatching(/^Error: agent \S+ failed to launch: /);
    expect([
      both.flatMap(reasons),
      store.snapshot(testView).tasks.map((t) => t.title),
      agents().length,
    ]).toEqual([[failed, failed], [brief.title], count + 1]);
  });

  it("launches nothing for a brief whose message to the new agent would be too long", async () => {
    const { tasks, coordinator, agents } = await coordinated();
    const count = agents().length;
    const req = { ...launchRequest("d"), brief: "x".repeat(19_950) };
    await expect(tasks.launchAndDelegate(coordinator, req)).rejects.toThrow(MailTooLong);
    expect(agents().length).toBe(count);
  });

  it("holds the cap for launches still on their way, so two at once can't both pass it", async () => {
    const { tasks, coordinator, agents } = await coordinated({ maxLaunched: 1, maxDepth: 3 });
    const count = agents().length;
    const both = await Promise.allSettled([
      tasks.launchAndDelegate(coordinator, launchRequest("d1")),
      tasks.launchAndDelegate(coordinator, launchRequest("d2")),
    ]);
    const refused = both.flatMap(reasons);
    expect([refused, agents().length]).toEqual([
      [expect.stringContaining("the most at once (1)")],
      count + 1,
    ]);
  });

  it("counts a launch on its way as the one agent it records, not twice", async () => {
    const held = Promise.withResolvers<void>();
    const { tasks, coordinator, agents } = await coordinated(
      { maxLaunched: 2, maxDepth: 3 },
      async (l) => {
        await held.promise;
        return {
          runtime: { terminalId: l.terminalId, runtime: "tmux", locator: {} },
          externalRef: null,
        };
      },
    );
    const first = tasks.launchAndDelegate(coordinator, launchRequest("d1"));
    const starting = agents().filter((a) => a.state === "starting").length;
    const second = tasks.launchAndDelegate(coordinator, launchRequest("d2"));
    held.resolve();
    const both = await Promise.allSettled([first, second]);
    expect([starting, both.map((r) => r.status)]).toEqual([1, ["fulfilled", "fulfilled"]]);
  });

  it("replays a launch a crash left undelegated, rather than counting it against the cap", async () => {
    const { store, tasks, launcher, coordinator, agents } = await coordinated({
      maxLaunched: 1,
      maxDepth: 3,
    });
    const req = launchRequest("d");
    const cwd = String(store.agentLaunch(coordinator)?.launch.cwd);
    await launcher.launch(
      { idempotencyKey: `d:launch:${coordinator}`, ...launch, cwd },
      coordinator,
    );
    const count = agents().length;
    const { assignmentId } = await tasks.launchAndDelegate(coordinator, req);
    expect([assignmentId !== null, agents().length]).toEqual([true, count]);
  });

  it("tells the human of an agent launched for a delegation refused while it started", async () => {
    const f = await coordinated();
    const { store, mailbox, coordinator, parentId } = f;
    const raised: Raised[] = [];
    const launchedIds: string[] = [];
    const tasks: Tasks = new Tasks(store, mailbox, (r) => (raised.push(r), newId("attn")), {
      ...f.launcher,
      launch: async (req, by) => {
        const launched = await f.launcher.launch(req, by);
        launchedIds.push(launched.agentId);
        tasks.finish(null, parentId, { idempotencyKey: "x", outcome: "cancelled" });
        return launched;
      },
    });
    await expect(tasks.launchAndDelegate(coordinator, launchRequest("d"))).rejects.toThrow(
      TaskRefused,
    );
    expect(raised).toEqual([
      expect.objectContaining({
        agentId: launchedIds[0],
        kind: "escalation",
        summary: expect.stringContaining("Close it"),
      }),
    ]);
  });
});
