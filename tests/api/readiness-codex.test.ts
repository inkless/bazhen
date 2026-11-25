// Codex launched in a folder it hasn't been told to trust. Started as `codex resume --remote`, it
// asks nothing and comes up, where Claude Code stops at its trust question (readiness.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol/web";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

const DEADLINE_S = 2;

let responses: FakeModel;
let daemon: Daemon;
beforeAll(async () => {
  responses = await startFakeResponses();
  daemon = await Daemon.start({
    responsesUrl: responses.url,
    config: `[agents]\nstart_deadline_seconds = ${DEADLINE_S}\n`,
  });
});
afterAll(async () => {
  await daemon?.stop();
  await responses?.close();
});

async function launchIn(harness: "claude-code" | "codex", dir: string) {
  const res = await daemon.request("/v1/agents", {
    method: "POST",
    body: { idempotencyKey: `untrusted-${harness}`, harness, cwd: daemon.untrustedDirectory(dir) },
  });
  return LaunchAgentResponse.parse(res.body);
}

const stuck = async (agentId: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body).attention.filter(
    (a) => a.agentId === agentId && a.kind === "stuck_starting",
  );

describe("Codex launched in a folder it hasn't been told to trust", () => {
  // Bazhen starts the thread and the TUI joins it on the app-server, where Codex asks nothing.
  it("comes up without a trust question, runs, and tells the human nothing", async () => {
    const { agentId } = await launchIn("codex", "codex-elsewhere");
    await waitUntil(async () => (await daemon.screen(agentId)).includes(BANNER.codex), "Codex");
    await expect.poll(() => daemon.agentState(agentId), { timeout: 30_000 }).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_S * 2000));
    expect([await daemon.screen(agentId), await stuck(agentId)]).toEqual([
      expect.not.stringMatching(/trust/i),
      [],
    ]);
  });
});
