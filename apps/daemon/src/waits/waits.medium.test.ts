import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Caller } from "@bazhen/core";
import type { StateSnapshot, WaitCondition } from "@bazhen/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RESTARTED } from "../mailbox/activity.ts";
import { UnknownMessage } from "../mailbox/wait.ts";
import { UnknownShell } from "../shells/lifecycle.ts";
import { Store, UnknownAgent } from "../store/store.ts";
import { UnknownTask } from "../tasks/tasks.ts";
import { handTimer, register, settled, testView } from "../testing/fixtures.ts";
import {
  SharedViews,
  TooManyWaits,
  WaitLimit,
  WaitRefused,
  waitFor,
  type WaitDeps,
} from "./waits.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fresh() {
  const store = Store.open(join(mkdtempSync(join(tmpdir(), "bz-waits-")), "bazhen.db"));
  stores.push(store);
  return { store, environmentId: register(store).environmentId };
}

const system = (store: Store, type: string, entityId: string, payload: object = {}) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the event names are the protocol's, checked as they append
  store.append({ type, entityId, actor: "system", payload } as Parameters<Store["append"]>[0]);

function launch(store: Store, environmentId: string, run = true) {
  const agentId = newId("agent");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: {
      environmentId,
      harness: "claude-code",
      project: "p",
      cwd: "/w",
      terminalId: newId("term"),
    },
  });
  if (run) running(store, agentId);
  return agentId;
}

/** Its terminal up, then its harness's first sign of life: what makes it `running`. */
const running = (store: Store, agentId: string) => {
  system(store, "agent.running", agentId, {
    externalRef: null,
    runtimeRef: { runtime: "tmux", locator: { session: "bz-1" } },
  });
  system(store, "agent.ready", agentId, { sign: "claude_hook" });
};

const close = (store: Store, agentId: string) => {
  system(store, "agent.closing", agentId);
  system(store, "agent.closed", agentId);
};

const reportIdle = (store: Store, agentId: string, value = "idle", source = "native") =>
  system(store, "agent.activity", agentId, {
    value,
    source,
    confidence: 1,
    observedAt: "2026-11-18T00:00:00Z",
  });

const mail = (store: Store, to: string, from?: string) => {
  const id = newId("msg");
  store.append({
    type: "mailbox.queued",
    entityId: id,
    actor: from ?? "system",
    payload: { agentId: to, body: "hi", ...(from === undefined ? {} : { from }) },
  });
  return id;
};

const see = (store: Store, id: string) => {
  system(store, "mailbox.offered", id);
  system(store, "mailbox.seen", id, { promptId: "p" });
};

function task(store: Store, worker?: string) {
  const taskId = newId("task");
  store.append({
    type: "task.created",
    entityId: taskId,
    actor: "user",
    payload: { title: "ship it", brief: "do it", ownerAgentId: null, parentTaskId: null },
  });
  if (worker === undefined) return { taskId, assignmentId: undefined };
  const assignmentId = newId("asgn");
  store.append({
    type: "assignment.granted",
    entityId: assignmentId,
    actor: "user",
    payload: { taskId, agentId: worker, role: "worker", parentAssignmentId: null },
  });
  return { taskId, assignmentId };
}

const deps = (store: Store, view?: () => StateSnapshot): WaitDeps => ({
  store,
  view: view ?? (() => store.snapshot(testView)),
});

/** A wait, with a timer the test fires: `now` judges once and answers whatever it finds. */
function waiting(store: Store, condition: WaitCondition, caller: Caller = null) {
  const timer = handTimer();
  const answer = waitFor(
    deps(store),
    caller,
    { condition, timeoutMs: 60_000 },
    new AbortController().signal,
    timer.after,
  );
  return { answer, timer };
}

const now = (store: Store, condition: WaitCondition, caller: Caller = null) =>
  waitFor(deps(store), caller, { condition, timeoutMs: 0 }, new AbortController().signal);

describe("a wait on an agent", () => {
  it("answers on the commit that meets it, and holds nothing after", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId, false);
    const { answer, timer } = waiting(store, { on: "agent", agentId, until: "ready" });
    await settled();
    running(store, agentId);
    const got = await answer;
    expect([got.verdict, got.said, got.agent?.id, timer.pending.size]).toEqual([
      "met",
      `${agentId} is ready`,
      agentId,
      0,
    ]);
  });

  it("misses no commit made in the same turn it was asked", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId, false);
    const { answer } = waiting(store, { on: "agent", agentId, until: "running" });
    running(store, agentId);
    expect((await answer).verdict).toBe("met");
  });

  it("answers never once the agent ends otherwise, and met for ended", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId);
    const { answer } = waiting(store, { on: "agent", agentId, until: "exited" });
    close(store, agentId);
    const got = await answer;
    expect([got.verdict, got.said]).toEqual([
      "never",
      `${agentId} is closed, and can't be exited now`,
    ]);
    expect((await now(store, { on: "agent", agentId, until: "ended" })).verdict).toBe("met");
  });

  it("answers pending at the timeout, with where the agent stands then", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId, false);
    const { answer, timer } = waiting(store, { on: "agent", agentId, until: "ready" });
    timer.fire();
    expect(await answer).toMatchObject({ verdict: "pending", said: `${agentId} is starting` });
  });

  it("refuses an agent the caller can't see as not found", async () => {
    const { store } = fresh();
    await expect(
      now(store, { on: "agent", agentId: newId("agent"), until: "idle" }),
    ).rejects.toBeInstanceOf(UnknownAgent);
  });
});

describe("a wait for an agent to be idle", () => {
  it("is met only by an idle its harness reported after every message reached it", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId);
    const idle = { on: "agent", agentId, until: "idle" } as const;
    const said = async () => (await now(store, idle)).said;
    const seen: string[] = [await said()];
    reportIdle(store, agentId);
    const message = mail(store, agentId);
    seen.push(await said());
    see(store, message);
    seen.push(await said());
    reportIdle(store, agentId, "working");
    seen.push(await said());
    const { answer } = waiting(store, idle);
    reportIdle(store, agentId);
    seen.push((await answer).said);
    expect(seen).toEqual([
      `${agentId} is running: no turn reported`,
      `${agentId} is running: 1 message to it on the way`,
      `${agentId} is running: no turn since its last message`,
      `${agentId} is running: working`,
      `${agentId} is idle`,
    ]);
  });

  it("isn't held back by a message that bounced while the agent sat idle", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId);
    reportIdle(store, agentId);
    const lost = mail(store, agentId);
    system(store, "mailbox.undeliverable", lost, { reason: "gave_up" });
    expect((await now(store, { on: "agent", agentId, until: "idle" })).said).toBe(
      `${agentId} is idle`,
    );
  });

  it("takes an idle reported before a daemon restart, and says why it can't when it was busy", async () => {
    const { store, environmentId } = fresh();
    const restarted = (agentId: string) =>
      system(store, "agent.activity", agentId, {
        value: "unknown",
        detail: RESTARTED,
        source: "heuristic",
        confidence: 1,
        observedAt: "2026-11-18T00:00:00Z",
      });
    const parked = launch(store, environmentId);
    reportIdle(store, parked);
    restarted(parked);
    const busy = launch(store, environmentId);
    reportIdle(store, busy, "working");
    restarted(busy);
    const mailed = launch(store, environmentId);
    reportIdle(store, mailed);
    see(store, mail(store, mailed));
    restarted(mailed);
    const said = async (agentId: string) =>
      (await now(store, { on: "agent", agentId, until: "idle" })).said;
    expect([await said(parked), await said(busy), await said(mailed)]).toEqual([
      `${parked} is idle, as it was when the daemon restarted`,
      `${busy} is running: the daemon restarted while it was working; idle once it reports a turn ended`,
      `${mailed} is running: the daemon restarted before it reported a turn after its last message`,
    ]);
  });

  it("doesn't take an idle Bazhen inferred for one its harness reported", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId);
    reportIdle(store, agentId, "idle", "heuristic");
    expect((await now(store, { on: "agent", agentId, until: "idle" })).said).toBe(
      `${agentId} is running: no turn reported`,
    );
  });
});

describe("a wait on a shell", () => {
  it("is met once the shell ends, gone from the state, and never for a state it can't reach now", async () => {
    const { store, environmentId } = fresh();
    const shellId = newId("term");
    store.append({
      type: "terminal.opened",
      entityId: shellId,
      actor: "user",
      payload: { environmentId, cwd: "/w", linkedAgentId: null },
    });
    system(store, "terminal.running", shellId, {
      runtimeRef: { runtime: "tmux", locator: { generation: "0" } },
    });
    const ended = waiting(store, { on: "shell", shellId, until: "ended" });
    const exited = waiting(store, { on: "shell", shellId, until: "exited" });
    system(store, "terminal.closing", shellId);
    system(store, "terminal.closed", shellId, { reason: "user" });
    expect([await ended.answer, await exited.answer]).toEqual([
      { verdict: "met", said: `${shellId} is gone` },
      { verdict: "never", said: `${shellId} is gone, and can't be exited now` },
    ]);
    await expect(
      now(store, { on: "shell", shellId: newId("term"), until: "ended" }),
    ).rejects.toBeInstanceOf(UnknownShell);
  });
});

describe("a wait for a task to be done", () => {
  it("is met by a worker's own done, though the task stays open", async () => {
    const { store, environmentId } = fresh();
    const worker = launch(store, environmentId);
    const { taskId, assignmentId = "" } = task(store, worker);
    const { answer } = waiting(store, { on: "task", taskId, until: "done" });
    system(store, "assignment.ended", assignmentId, { reason: "completed" });
    const got = await answer;
    expect([got.verdict, got.task?.state]).toEqual(["met", "open"]);
  });

  it("is not met by work taken away, and is met by the task finished done", async () => {
    const { store, environmentId } = fresh();
    const worker = launch(store, environmentId);
    const { taskId, assignmentId = "" } = task(store, worker);
    system(store, "assignment.ended", assignmentId, { reason: "unassigned" });
    const done = { on: "task", taskId, until: "done" } as const;
    const before = await now(store, done);
    system(store, "task.finished", taskId, { outcome: "done", note: null });
    expect([before.verdict, (await now(store, done)).verdict]).toEqual(["pending", "met"]);
  });

  it("waits on whoever is still on it, though another completed their part", async () => {
    const { store, environmentId } = fresh();
    const first = launch(store, environmentId);
    const { taskId, assignmentId: done = "" } = task(store, first);
    const still = newId("asgn");
    store.append({
      type: "assignment.granted",
      entityId: still,
      actor: "user",
      payload: {
        taskId,
        agentId: launch(store, environmentId),
        role: "worker",
        parentAssignmentId: null,
      },
    });
    system(store, "assignment.ended", done, { reason: "completed" });
    const { answer } = waiting(store, { on: "task", taskId, until: "done" });
    const before = await now(store, { on: "task", taskId, until: "done" });
    system(store, "assignment.ended", still, { reason: "unassigned" });
    expect([before.said, (await answer).verdict]).toEqual([
      `ship it (${taskId}) is open, with 1 on it`,
      "met",
    ]);
  });

  it("answers never for a cancelled task, and not found for one there isn't", async () => {
    const { store } = fresh();
    const { taskId } = task(store);
    system(store, "task.finished", taskId, { outcome: "cancelled", note: null });
    expect((await now(store, { on: "task", taskId, until: "done" })).verdict).toBe("never");
    await expect(
      now(store, { on: "task", taskId: newId("task"), until: "done" }),
    ).rejects.toBeInstanceOf(UnknownTask);
  });
});

describe("a wait for a reply", () => {
  it("is met by mail the recipient sent back once it had the message, and by no one else's", async () => {
    const { store, environmentId } = fresh();
    const sender = launch(store, environmentId);
    const recipient = launch(store, environmentId);
    const other = launch(store, environmentId);
    const sent = mail(store, recipient, sender);
    const { answer } = waiting(store, { on: "reply", messageId: sent }, sender);
    mail(store, sender, recipient);
    see(store, sent);
    mail(store, sender, other);
    mail(store, sender);
    await settled();
    const reply = mail(store, sender, recipient);
    expect(await answer).toMatchObject({
      verdict: "met",
      replyId: reply,
      agent: { id: recipient },
    });
  });

  it("answers bounced for a message that can't arrive, and never once the recipient ends", async () => {
    const { store, environmentId } = fresh();
    const sender = launch(store, environmentId);
    const recipient = launch(store, environmentId);
    const reply = { on: "reply", messageId: mail(store, recipient, sender) } as const;
    const lost = mail(store, recipient, sender);
    system(store, "mailbox.undeliverable", lost, { reason: "gave_up" });
    const bounced = await now(store, { on: "reply", messageId: lost }, sender);
    close(store, recipient);
    const ended = await now(store, reply, sender);
    expect([bounced.verdict, ended.verdict]).toEqual(["bounced", "never"]);
  });
});

/** What a wait came to: answered, or the class of the error that refused it. */
const outcome = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" && r.reason instanceof Error ? r.reason.constructor : r.status;

describe("who may wait on what", () => {
  it("lets only a message's sender wait for its reply", async () => {
    const { store, environmentId } = fresh();
    const sender = launch(store, environmentId);
    const recipient = launch(store, environmentId);
    const other = launch(store, environmentId);
    const messageId = mail(store, recipient, sender);
    const fromHuman = mail(store, recipient);
    const tried = await Promise.allSettled([
      now(store, { on: "reply", messageId }, other),
      now(store, { on: "reply", messageId }, null),
      now(store, { on: "reply", messageId: fromHuman }, null),
      now(store, { on: "reply", messageId: newId("msg") }, sender),
      now(store, { on: "reply", messageId }, sender),
    ]);
    expect(tried.map(outcome)).toEqual([
      WaitRefused,
      WaitRefused,
      WaitRefused,
      UnknownMessage,
      "fulfilled",
    ]);
  });

  it("tells a caller no more than its /v1/state shows", async () => {
    const { store, environmentId } = fresh();
    const shown = launch(store, environmentId);
    const hidden = launch(store, environmentId);
    const view = () => {
      const all = store.snapshot(testView);
      return {
        ...all,
        agents: all.agents.filter((a) => a.id !== hidden).map((a) => ({ ...a, name: "seen" })),
      };
    };
    const ask = (agentId: string) =>
      waitFor(
        deps(store, view),
        null,
        { condition: { on: "agent", agentId, until: "running" }, timeoutMs: 0 },
        new AbortController().signal,
      );
    const got = await ask(shown);
    expect(got.agent).toEqual(view().agents[0]);
    await expect(ask(hidden)).rejects.toBeInstanceOf(UnknownAgent);
  });
});

describe("a wait resumed", () => {
  it("judges a target gone since the caller last waited as gone, not unknown", async () => {
    const { store } = fresh();
    const shellId = newId("term");
    const resumed = (until: "ended" | "running") =>
      waitFor(
        deps(store),
        null,
        { condition: { on: "shell", shellId, until }, timeoutMs: 0, resumed: true },
        new AbortController().signal,
      );
    const first = now(store, { on: "shell", shellId, until: "ended" });
    await expect(first).rejects.toThrow(UnknownShell);
    expect([(await resumed("ended")).verdict, (await resumed("running")).verdict]).toEqual([
      "met",
      "never",
    ]);
  });
});

describe("the waits a caller holds", () => {
  it("are held to the most one caller may hold at once, and an ended one makes room", async () => {
    const { store, environmentId } = fresh();
    const agentId = launch(store, environmentId);
    const limit = new WaitLimit(1);
    const wait = (caller: Caller, until: "ended" | "ready", signal: AbortSignal) =>
      waitFor(
        { ...deps(store), limit },
        caller,
        { condition: { on: "agent", agentId, until }, timeoutMs: 60_000 },
        signal,
        handTimer().after,
      );
    const stop = new AbortController();
    const held = wait(agentId, "ended", stop.signal);
    const refused = wait(agentId, "ready", new AbortController().signal);
    const human = await wait(null, "ready", new AbortController().signal);
    await expect(refused).rejects.toThrow(TooManyWaits);
    stop.abort();
    await held;
    const again = await wait(agentId, "ready", new AbortController().signal);
    expect([human.verdict, again.verdict]).toEqual(["met", "met"]);
  });
});

describe("the snapshots waits judge through", () => {
  it("are made once per viewer per commit, however many waits read them, and kept no longer", () => {
    const { store, environmentId } = fresh();
    const made: string[] = [];
    const views = new SharedViews(
      () => store.latestEventId(),
      (viewer: string) => {
        made.push(viewer);
        return store.snapshot(testView);
      },
    );
    const owner = views.hold("owner");
    const again = views.hold("owner");
    owner.view();
    again.view();
    launch(store, environmentId, false);
    owner.view();
    owner.release();
    again.view();
    // A viewer no wait holds any more, as a revoked device's, keeps nothing: on the same
    // commit, the next wait's view is made anew.
    const device = views.hold("device");
    device.view();
    device.release();
    views.hold("device").view();
    expect(made).toEqual(["owner", "owner", "device", "device"]);
  });
});
