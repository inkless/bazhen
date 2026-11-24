import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SendMessageResponse, type LaunchAgentResponse } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

/** A line of the instructions every agent Bazhen launches is given. */
const FLEET_LINE = "You are an agent in a Bazhen fleet";

let codexModel: FakeModel;
let daemon: Daemon;
let codex: LaunchAgentResponse;
beforeAll(async () => {
  codexModel = await startFakeResponses();
  daemon = await Daemon.start({ responsesUrl: codexModel.url });
  codex = await daemon.launch("codex", "codex");
  await waitUntil(
    async () => (await daemon.screen(codex.agentId)).includes(BANNER.codex),
    "Codex's TUI",
    30_000,
  );
});
afterAll(async () => {
  await daemon?.stop();
  await codexModel?.close();
});

describe("what a launched Codex agent is told about the fleet", () => {
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
