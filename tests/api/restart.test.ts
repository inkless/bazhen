import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, SendMessageResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let survivor: LaunchAgentResponse;
let victim: LaunchAgentResponse;
let held = "";

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const messageState = async (id: string) => (await state()).messages.find((m) => m.id === id)?.state;
const launch = async (key: string) => {
  const launched = LaunchAgentResponse.parse(
    (
      await daemon.request("/v1/agents", {
        method: "POST",
        body: { idempotencyKey: key, harness: "claude-code", cwd: daemon.work },
      })
    ).body,
  );
  await waitUntil(
    () => daemon.screen(launched.agentId).includes("Claude Code"),
    "Claude Code's TUI",
  );
  return launched;
};
const send = async (agentId: string, key: string, body: string) =>
  SendMessageResponse.parse(
    (
      await daemon.request(`/v1/agents/${agentId}/messages`, {
        method: "POST",
        body: { idempotencyKey: key, body },
      })
    ).body,
  ).messageId;

beforeAll(async () => {
  model = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: model.url });
  [survivor, victim] = await Promise.all([launch("survivor"), launch("victim")]);
  // A message mid-turn when the daemon dies: seen, with the turn that would deliver it still running.
  held = await send(survivor.agentId, "held", "[[fake:slow:8000]] Hold on to this.");
  await waitUntil(async () => (await messageState(held)) === "seen", "the held message seen");
  await daemon.kill();
  // While the daemon is down, one agent's terminal ends; the other keeps the tmux server up.
  daemon.endTerminal(victim.agentId);
  await daemon.restart();
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

describe("after the daemon is killed with -9 and started again", () => {
  it("still runs the agent tmux kept, under the same ids, and has lost the one it didn't", async () => {
    const agents = (await state()).agents;
    expect([
      agents.find((a) => a.id === survivor.agentId),
      agents.find((a) => a.id === victim.agentId)?.state,
    ]).toEqual([
      expect.objectContaining({ state: "running", terminalId: survivor.terminalId }),
      "lost",
    ]);
  });

  it("shows the agent's terminal to a new view", async () => {
    const view = await daemon.view(String(survivor.terminalId), "observe");
    await expect.poll(() => view.output(), { timeout: 10_000 }).toMatch(/Claude Code/);
    view.close();
  });

  it("delivers the message held across the kill, labelled as a possible re-delivery", async () => {
    await expect.poll(() => messageState(held), { timeout: 60_000 }).toBe("delivered");
    expect(model.requests.join()).toContain(`possible re-delivery of ${held}`);
  });

  it("delivers new mail", async () => {
    const id = await send(survivor.agentId, "after-restart", "Still there?");
    await expect.poll(() => messageState(id), { timeout: 30_000 }).toBe("delivered");
  });
});
