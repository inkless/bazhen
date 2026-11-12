import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

let model: FakeModel;
let responses: FakeModel;
let daemon: Daemon;
let survivor: LaunchAgentResponse;
let victim: LaunchAgentResponse;
let codex: LaunchAgentResponse;
let held = "";

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const messageState = async (id: string) => (await state()).messages.find((m) => m.id === id)?.state;
const launch = async (key: string, harness: "claude-code" | "codex" = "claude-code") => {
  const launched = await daemon.launch(key, harness);
  await waitUntil(
    () => daemon.screen(launched.agentId).includes(BANNER[harness]),
    BANNER[harness],
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
  [model, responses] = await Promise.all([startFakeModel(), startFakeResponses()]);
  daemon = await Daemon.start({ modelUrl: model.url, responsesUrl: responses.url });
  [survivor, victim, codex] = await Promise.all([
    launch("survivor"),
    launch("victim"),
    launch("codex", "codex"),
  ]);
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
  await Promise.all([model?.close(), responses?.close()]);
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
    await expect.poll(() => view.text(), { timeout: 10_000 }).toContain(BANNER["claude-code"]);
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

  it("still runs the Codex agent, whose TUI takes turns on the same thread", async () => {
    expect((await state()).agents.find((a) => a.id === codex.agentId)).toMatchObject({
      state: "running",
      externalRef: { kind: "codex-thread" },
    });
    await daemon.prompt(codex, "still there, codex?");
    await expect
      .poll(() => daemon.screen(codex.agentId), { timeout: 30_000 })
      .toContain("echo: still there, codex?");
  });

  it("launches a new Codex agent through a new connection to the app-server", async () => {
    const again = await launch("codex-after-restart", "codex");
    expect((await state()).agents.find((a) => a.id === again.agentId)?.state).toBe("running");
  });
});
