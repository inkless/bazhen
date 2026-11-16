// Agents launched in a folder their harness hasn't been told to trust. Claude Code stops at its
// trust question, which only the human answers: Bazhen waits, says so past its deadline, and types
// nothing. Codex, started as `codex resume --remote`, asks nothing and comes up.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol";
import { BANNER, Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

const DEADLINE_S = 2;

let anthropic: FakeModel;
let responses: FakeModel;
let daemon: Daemon;
beforeAll(async () => {
  [anthropic, responses] = await Promise.all([startFakeModel(), startFakeResponses()]);
  daemon = await Daemon.start({
    modelUrl: anthropic.url,
    responsesUrl: responses.url,
    config: `[agents]\nstart_deadline_seconds = ${DEADLINE_S}\n`,
  });
});
afterAll(async () => {
  await daemon?.stop();
  await Promise.all([anthropic?.close(), responses?.close()]);
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

describe("Claude Code launched in a folder it hasn't been told to trust", () => {
  let launched: LaunchAgentResponse;
  beforeAll(async () => {
    launched = await launchIn("claude-code", "claude-elsewhere");
  });

  it("stays starting at the trust question, and tells the human to look at its terminal", async () => {
    await waitUntil(
      async () => /trust this folder/i.test(await daemon.shows(launched.agentId)),
      "the trust question",
      30_000,
    );
    await expect.poll(() => stuck(launched.agentId), { timeout: 15_000 }).toHaveLength(1);
    const [item] = await stuck(launched.agentId);
    expect([await daemon.agentState(launched.agentId), item?.state, item?.summary]).toEqual([
      "starting",
      "open",
      expect.stringContaining("Look in its terminal for a dialog"),
    ]);
    // Nothing answered it while Bazhen waited.
    expect(await daemon.shows(launched.agentId)).toMatch(/trust this folder/i);
  });

  it("runs once the human answers in its terminal, which closes the item as answered there", async () => {
    const view = await daemon.view(String(launched.terminalId), "interactive");
    await view.drive();
    // The question's first answer, the one a bare Enter takes, is "No, exit": a blind Enter, as
    // the fleet's tools once typed, ends the agent. The human moves to trusting the folder first.
    view.type("\x1b[B");
    await waitUntil(
      async () => /❯ Yes, I trust this folder/.test(await daemon.shows(launched.agentId)),
      "the trusting answer chosen",
    );
    view.type("\r");
    await daemon.running(launched.agentId);
    const [item] = await stuck(launched.agentId);
    view.close();
    expect([item?.state, item?.closeReason]).toEqual(["closed", "answered_in_tui"]);
  });
});

describe("Codex launched in a folder it hasn't been told to trust", () => {
  // Bazhen starts the thread and the TUI joins it on the app-server, where Codex asks nothing.
  it("comes up without a trust question, runs, and tells the human nothing", async () => {
    const { agentId } = await launchIn("codex", "codex-elsewhere");
    await waitUntil(async () => (await daemon.shows(agentId)).includes(BANNER.codex), "Codex");
    await daemon.running(agentId);
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_S * 2000));
    expect([await daemon.shows(agentId), await stuck(agentId)]).toEqual([
      expect.not.stringMatching(/trust/i),
      [],
    ]);
  });
});
