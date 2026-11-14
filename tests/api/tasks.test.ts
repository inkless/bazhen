import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateTaskResponse,
  SendMessageResponse,
  StateSnapshot,
  TaskDetail,
  type LaunchAgentResponse,
} from "@bazhen/protocol";
import { BANNER, Daemon, bazhen, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

/** A line of the instructions every agent Bazhen launches is given. */
const FLEET_LINE = "You are an agent in a Bazhen fleet";

let claudeModel: FakeModel;
let codexModel: FakeModel;
let daemon: Daemon;
let coordinator: LaunchAgentResponse;
let worker: LaunchAgentResponse;
let codex: LaunchAgentResponse;
beforeAll(async () => {
  [claudeModel, codexModel] = await Promise.all([startFakeModel(), startFakeResponses()]);
  daemon = await Daemon.start({ modelUrl: claudeModel.url, responsesUrl: codexModel.url });
  [coordinator, worker, codex] = await Promise.all([
    daemon.launch("coordinator"),
    daemon.launch("worker"),
    daemon.launch("codex", "codex"),
  ]);
  await waitUntil(
    () =>
      [coordinator, worker].every((a) => daemon.screen(a.agentId).includes(BANNER["claude-code"])),
    "Claude Code's TUIs",
    30_000,
  );
  await waitUntil(() => daemon.screen(codex.agentId).includes(BANNER.codex), "Codex's TUI", 30_000);
});
afterAll(async () => {
  await daemon?.stop();
  await Promise.all([claudeModel?.close(), codexModel?.close()]);
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
/** `bazhen <args>` as the agent would run it, inside its pane. */
const asAgent = (agentId: string, args: string[]) =>
  bazhen(args, { ...daemon.env, BAZHEN_AGENT_ID: agentId });
/** The subtask `bazhen delegate` reports it made. */
const subtaskOf = (out: string) => String(/delegated (task_\S+)/.exec(out)?.[1]);
const mailTo = async (agentId: string) =>
  (await state()).messages.filter((m) => m.agentId === agentId).length;

describe("tasks and delegation, through the CLI", () => {
  it("delegates from the coordinator to a worker, and tells the coordinator when it is done", async () => {
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
      "delegate",
      worker.agentId,
      "--title",
      "Pin Node",
      "--brief",
      "Pin Node 24 in CI.",
    ]);
    expect(delegated).toMatchObject({ code: 0, out: expect.stringContaining("delegated task_") });
    const subtaskId = subtaskOf(delegated.out);
    expect(await asAgent(worker.agentId, ["task", "list"])).toMatchObject({
      code: 0,
      out: expect.stringContaining(
        `${subtaskId}  Pin Node  [worker ${worker.agentId}]  (part of ${taskId})`,
      ),
    });

    const before = await mailTo(coordinator.agentId);
    expect(await asAgent(worker.agentId, ["task", "done", "--note", "Pinned."])).toMatchObject({
      code: 0,
    });
    await expect.poll(() => mailTo(coordinator.agentId)).toBe(before + 1);
    const detail = TaskDetail.parse((await daemon.request(`/v1/tasks/${subtaskId}`)).body);
    expect(detail.assignments.map((a) => [a.agentId, a.endReason])).toEqual([
      [worker.agentId, "completed"],
    ]);
  });

  it("puts an agent's escalation in the human's inbox", async () => {
    const out = await asAgent(worker.agentId, ["escalate", "Pin", "24", "or", "26?"]);
    expect(out).toMatchObject({ code: 0, out: expect.stringContaining("escalated as attn_") });
    const items = (await state()).attention.filter((a) => a.agentId === worker.agentId);
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "escalation", summary: "Pin 24 or 26?", state: "open" }),
    );
  });

  it("hands one agent's message to another, saying who sent it", async () => {
    const out = await asAgent(worker.agentId, ["send", coordinator.agentId, "Is", "it", "green?"]);
    expect(out).toMatchObject({ code: 0, out: expect.stringContaining("sent msg_") });
    const messageId = /sent (msg_\S+)/.exec(out.out)?.[1];
    const queued = (await state()).messages.find((m) => m.id === messageId);
    expect(queued?.agentId).toBe(coordinator.agentId);
    const header = `From agent ${worker.agentId} (claude-code, `;
    const delivered = () =>
      claudeModel.requests.filter((r) => r.includes(header)).some((r) => r.includes("green?"));
    await expect.poll(delivered, { timeout: 30_000 }).toBe(true);
  });

  it("launches a new agent for a delegated subtask, which knows who launched it and gets the brief", async () => {
    const created = await daemon.request("/v1/tasks", {
      method: "POST",
      body: {
        idempotencyKey: "launch-task",
        title: "Ship it",
        brief: "Cut the release.",
        assign: { agentId: coordinator.agentId, role: "coordinator" },
      },
    });
    const { taskId } = CreateTaskResponse.parse(created.body);
    const out = await asAgent(coordinator.agentId, [
      "delegate",
      "--launch",
      "claude-code",
      "--task",
      taskId,
      "--title",
      "Write the notes",
      "--brief",
      "Draft the release notes.",
    ]);
    expect(out).toMatchObject({
      code: 0,
      out: expect.stringContaining("to a new claude-code agent"),
    });
    const launched = (await state()).agents.filter((a) => a.launchedBy === coordinator.agentId);
    expect(launched).toHaveLength(1);
    await expect.poll(async () => mailTo(String(launched[0]?.id))).toBe(1);
  });

  it("refuses a worker that delegates, and says why", async () => {
    const out = await asAgent(worker.agentId, [
      "delegate",
      coordinator.agentId,
      "--title",
      "t",
      "--brief",
      "b",
    ]);
    expect(out).toMatchObject({
      code: 1,
      out: expect.stringContaining("coordinates or leads no task"),
    });
  });
});

describe("what every launched agent is told about the fleet", () => {
  it("tells Claude Code, in its system prompt", async () => {
    const sent = await daemon.request(`/v1/agents/${coordinator.agentId}/messages`, {
      method: "POST",
      body: { idempotencyKey: "hello-claude", body: "Say hello." },
    });
    SendMessageResponse.parse(sent.body);
    await expect
      .poll(() => claudeModel.requests.some((r) => r.includes(FLEET_LINE)), { timeout: 30_000 })
      .toBe(true);
  });

  it("tells Codex, in its thread's first item", async () => {
    const sent = await daemon.request(`/v1/agents/${codex.agentId}/messages`, {
      method: "POST",
      body: { idempotencyKey: "hello", body: "Say hello." },
    });
    SendMessageResponse.parse(sent.body);
    await expect
      .poll(() => codexModel.requests.some((r) => r.includes(FLEET_LINE)), { timeout: 30_000 })
      .toBe(true);
  });
});
