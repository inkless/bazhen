import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let model: FakeModel;
let daemon: Daemon;
let survivor: LaunchAgentResponse;
let victim: LaunchAgentResponse;
let quiet: LaunchAgentResponse;
let held = "";

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const activityOf = async (agent: LaunchAgentResponse) =>
  (await state()).agents.find((a) => a.id === agent.agentId)?.activity?.value;
const messageState = async (id: string) => (await state()).messages.find((m) => m.id === id)?.state;
const launch = async (key: string) => {
  const launched = await daemon.launch(key);
  await waitUntil(
    async () => (await daemon.screen(launched.agentId)).includes(BANNER["claude-code"]),
    BANNER["claude-code"],
    30_000,
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
  daemon = await Daemon.start({ modelUrl: model.url, claudeDebugLog: true });
  await daemon.explained(async () => {
    [survivor, victim, quiet] = await Promise.all([
      launch("survivor"),
      launch("victim"),
      launch("quiet"),
    ]);
    // Started, with no mail: idle, its SessionStart waiter held open across the kill.
    await waitUntil(async () => (await activityOf(quiet)) === "idle", "the quiet agent idle");
    // A message mid-turn when the daemon dies: seen, with the turn that would deliver it still
    // running.
    held = await send(survivor.agentId, "held", "[[fake:slow:8000]] Hold on to this.");
    await waitUntil(async () => (await messageState(held)) === "seen", "the held message seen");
  });
  await daemon.crash();
  // While the daemon is down, one agent's terminal ends; the other's runs on.
  await daemon.endTerminal(victim.agentId);
  await daemon.restart();
  // Taken at once, while the held message's slow turn still runs.
  afterRestart = (await state()).agents.find((a) => a.id === survivor.agentId)?.activity;
});
afterAll(async () => {
  await daemon?.stop();
  await model?.close();
});

let afterRestart: StateSnapshot["agents"][number]["activity"];

describe("after the daemon is killed with -9 and started again", () => {
  it("never reads an idle agent idle on the word of a waiter that reconnected after the restart", async () => {
    // The waiter retries each second; give it time to post its SessionStart again.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await activityOf(quiet)).toBe("unknown");
  });

  it("reads a Claude Code agent as unknown, not idle, until its turn says what it is doing", async () => {
    expect(afterRestart).toMatchObject({ value: "unknown", detail: "daemon restarted" });
    await waitUntil(async () => (await messageState(held)) === "delivered", "the held message");
    await expect
      .poll(
        async () => (await state()).agents.find((a) => a.id === survivor.agentId)?.activity?.value,
      )
      .toBe("idle");
  });

  it("still runs the agent whose terminal outlived it, under the same ids, and has lost the other", async () => {
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
    await expect.poll(() => view.text(), { timeout: 10_000 }).toContain(BANNER["claude-code"]);
    view.close();
  });

  it("delivers the message held across the kill, labelled as a possible re-delivery", async () => {
    // Within the test's own timeout, so a message given up on fails here, by its state.
    await expect.poll(() => messageState(held), { timeout: 30_000 }).toBe("delivered");
    expect(model.requests.join()).toContain(`possible re-delivery of ${held}`);
  });

  it("delivers new mail", async () => {
    const id = await send(survivor.agentId, "after-restart", "Still there?");
    await expect.poll(() => messageState(id), { timeout: 30_000 }).toBe("delivered");
  });
});
