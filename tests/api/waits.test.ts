import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateTaskResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, bazhen, overSocket, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let coordinator: LaunchAgentResponse;
let worker: LaunchAgentResponse;
beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  [coordinator, worker] = await Promise.all([
    daemon.launch("coordinator"),
    daemon.launch("worker"),
  ]);
  await waitUntil(
    async () =>
      (await Promise.all([coordinator, worker].map((a) => daemon.shows(a.agentId)))).every((s) =>
        s.includes(BANNER["claude-code"]),
      ),
    "Claude Code's TUIs",
    30_000,
  );
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
/** `bazhen <args>` as the agent would run it, inside its pane. */
const asAgent = (agentId: string, args: string[]) =>
  bazhen(args, {
    ...daemon.env,
    BAZHEN_AGENT_ID: agentId,
    BAZHEN_AGENT_AUTH_FILE: daemon.tokenFile(agentId),
  });
const sentId = (out: string) => String(/sent (msg_\S+)/.exec(out)?.[1]);
const messageState = async (messageId: string) =>
  (await state()).messages.find((m) => m.id === messageId)?.state;

describe("an agent waiting on another, through the CLI", () => {
  it("wakes once the agent it sent work to has taken it up and gone idle, not before", async () => {
    const sent = await asAgent(coordinator.agentId, ["agents", "send", worker.agentId, "Rebase."]);
    expect(sent.code).toBe(0);
    const messageId = sentId(sent.out);
    const waited = await asAgent(coordinator.agentId, [
      "agents",
      "wait",
      worker.agentId,
      "idle",
      "--timeout",
      "25",
    ]);
    // Idle before the message arrived would be the turn before it: the wait must outlast delivery.
    expect([waited, await messageState(messageId)]).toEqual([
      { code: 0, out: expect.stringContaining(`(${worker.agentId}) is idle`) },
      "delivered",
    ]);
  });

  it("wakes once a delegated task is done, and not while it is open", async () => {
    const created = await daemon.request("/v1/tasks", {
      method: "POST",
      body: {
        idempotencyKey: "task",
        title: "Fix the build",
        brief: "It fails on Node 26.",
        assign: { agentId: coordinator.agentId, role: "coordinator" },
      },
    });
    const { taskId } = CreateTaskResponse.parse(created.body);
    const delegated = await asAgent(coordinator.agentId, [
      "tasks",
      "delegate",
      worker.agentId,
      "--task",
      taskId,
      "--title",
      "Pin Node",
      "--brief",
      "Pin Node 24 in CI.",
    ]);
    const subtaskId = String(/delegated (task_\S+)/.exec(delegated.out)?.[1]);
    const open = await asAgent(coordinator.agentId, [
      "tasks",
      "wait",
      subtaskId,
      "done",
      "--timeout",
      "1",
    ]);
    const waiting = asAgent(coordinator.agentId, [
      "tasks",
      "wait",
      subtaskId,
      "done",
      "--timeout",
      "25",
    ]);
    const done = await asAgent(worker.agentId, ["tasks", "done", subtaskId, "--note", "Pinned."]);
    expect([open.code, done.code, await waiting]).toEqual([
      5,
      0,
      { code: 0, out: expect.stringContaining("is done") },
    ]);
  });

  it("sends with --reply, and wakes on the answer the other agent sends back", async () => {
    const answer = `[[fake:bash:bazhen agents send ${coordinator.agentId} Rebased]]`;
    const asked = await asAgent(coordinator.agentId, [
      "agents",
      "send",
      worker.agentId,
      answer,
      "--reply",
      "--timeout",
      "25",
    ]);
    const replyId = /replied: (msg_\S+)/.exec(asked.out)?.[1];
    const reply = (await state()).messages.find((m) => m.id === replyId);
    expect([asked.code, reply?.agentId]).toEqual([0, coordinator.agentId]);
  });

  it("refuses a wait on a reply to anyone but the message's sender, the human included", async () => {
    const sent = await asAgent(coordinator.agentId, ["agents", "send", worker.agentId, "Thanks."]);
    const body = { condition: { on: "reply", messageId: sentId(sent.out) }, timeoutMs: 1000 };
    const asWorker = await overSocket(daemon.socket, "POST", "/v1/waits", {
      headers: { "bazhen-agent-token": daemon.tokenOf(worker.agentId) },
      body,
    });
    const asHuman = await daemon.request("/v1/waits", { method: "POST", body });
    expect([asWorker.status, asHuman.status]).toEqual([403, 403]);
  });
});
