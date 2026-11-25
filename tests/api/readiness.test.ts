// Claude Code launched in a folder it hasn't been told to trust stops at its trust question, which
// only the human answers: Bazhen waits, says so past its deadline, and types nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol/web";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";

const DEADLINE_S = 2;

let anthropic: FakeModel;
let daemon: Daemon;
beforeAll(async () => {
  anthropic = await startFakeModel();
  daemon = await Daemon.start({
    modelUrl: anthropic.url,
    config: `[agents]\nstart_deadline_seconds = ${DEADLINE_S}\n`,
  });
});
afterAll(async () => {
  await daemon?.stop();
  await anthropic?.close();
});

async function launchIn(dir: string) {
  const res = await daemon.request("/v1/agents", {
    method: "POST",
    body: {
      idempotencyKey: "untrusted-claude-code",
      harness: "claude-code",
      cwd: daemon.untrustedDirectory(dir),
    },
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
    launched = await launchIn("claude-elsewhere");
  });

  it("stays starting at the trust question, and tells the human to look at its terminal", async () => {
    await waitUntil(
      async () => /trust this folder/i.test(await daemon.screen(launched.agentId)),
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
    expect(await daemon.screen(launched.agentId)).toMatch(/trust this folder/i);
  });

  it("runs once the human answers in its terminal, which closes the item as answered there", async () => {
    const view = await daemon.view(String(launched.terminalId), "interactive");
    await view.drive();
    // The question's first answer, the one a bare Enter takes, is "No, exit": a blind Enter, as
    // the fleet's tools once typed, ends the agent. The human moves to trusting the folder first.
    view.type("\x1b[B");
    await waitUntil(
      async () => /❯ Yes, I trust this folder/.test(await daemon.screen(launched.agentId)),
      "the trusting answer chosen",
    );
    view.type("\r");
    await expect
      .poll(() => daemon.agentState(launched.agentId), { timeout: 30_000 })
      .toBe("running");
    const [item] = await stuck(launched.agentId);
    view.close();
    expect([item?.state, item?.closeReason]).toEqual(["closed", "answered_in_tui"]);
  });
});
