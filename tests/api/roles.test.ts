import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateSnapshot, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

let messages: FakeModel;
let daemon: Daemon;
let claude: LaunchAgentResponse;
beforeAll(async () => {
  messages = await startFakeModel();
  daemon = await Daemon.start({ modelUrl: messages.url });
  claude = await daemon.launch("claude-reviewer", "claude-code", "reviewer");
});
afterAll(async () => {
  await daemon?.stop();
  await messages?.close();
});

const state = async () => StateSnapshot.parse((await daemon.request("/v1/state")).body);
const agent = async (agentId: string) => (await state()).agents.find((a) => a.id === agentId);

/** A turn, once the agent's TUI is up, so the model is sent its system prompt. */
async function turn(launched: LaunchAgentResponse, harness: keyof typeof BANNER, text: string) {
  await waitUntil(
    async () => (await daemon.screen(launched.agentId)).includes(BANNER[harness]),
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
});
