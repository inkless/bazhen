import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

let messages: FakeModel;
let responses: FakeModel;
let daemon: Daemon;
let claude: LaunchAgentResponse;
let codex: LaunchAgentResponse;
beforeAll(async () => {
  [messages, responses] = await Promise.all([startFakeModel(), startFakeResponses()]);
  daemon = await Daemon.start({
    runtime: "tmux",
    modelUrl: messages.url,
    responsesUrl: responses.url,
  });
  [claude, codex] = await Promise.all([
    daemon.launch("claude-reviewer", "claude-code", "reviewer"),
    daemon.launch("codex-reviewer", "codex", "reviewer"),
  ]);
});
afterAll(async () => {
  await daemon?.stop();
  await Promise.all([messages?.close(), responses?.close()]);
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const agent = async (agentId: string) => (await state()).agents.find((a) => a.id === agentId);

/** A turn, once the agent's TUI is up, so the model is sent its system prompt. */
async function turn(launched: LaunchAgentResponse, harness: keyof typeof BANNER, text: string) {
  await waitUntil(
    () => daemon.screen(launched.agentId).includes(BANNER[harness]),
    `${harness}'s TUI`,
    30_000,
  );
  await daemon.prompt(launched, text);
}

describe("an agent launched in a role", () => {
  it("is sent its role's prompt by Claude Code, which read it from its file", async () => {
    await turn(claude, "claude-code", "hello reviewer");
    await expect
      .poll(() => messages.requests.some((r) => r.includes("## Your role: Reviewer")), {
        timeout: 30_000,
      })
      .toBe(true);
    expect(await agent(claude.agentId)).toMatchObject({ role: "reviewer", promptChanged: false });
  });

  it("is sent its role's prompt by Codex, from its thread's first item", async () => {
    await turn(codex, "codex", "hello reviewer");
    await expect
      .poll(() => responses.requests.some((r) => r.includes("## Your role: Reviewer")), {
        timeout: 30_000,
      })
      .toBe(true);
  });

  it("is shown its prompt changed after an edit, and a Codex respawn tells its thread the new one", async () => {
    daemon.writeRole(
      "reviewer",
      "---\ntitle: Reviewer\n---\nReview it twice, and change nothing.\n",
    );
    expect((await agent(codex.agentId))?.promptChanged).toBe(true);
    await daemon.signalAgent(codex.agentId, "SIGKILL");
    await expect
      .poll(async () => (await agent(codex.agentId))?.state, { timeout: 10_000 })
      .toBe("exited");
    const respawned = await daemon.request(`/v1/agents/${codex.agentId}/respawn`, {
      method: "POST",
      body: {
        idempotencyKey: "respawn",
        generation: Number((await agent(codex.agentId))?.generation),
      },
    });
    expect(respawned.status).toBe(200);
    await turn(codex, "codex", "hello again");
    await expect
      .poll(
        () =>
          responses.requests.some((r) => /These replace the ones[\s\S]*Review it twice/.test(r)),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect((await agent(codex.agentId))?.promptChanged).toBe(false);
  });
});
