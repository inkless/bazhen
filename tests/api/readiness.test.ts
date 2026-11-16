// An agent launched in a folder its harness hasn't been told to trust: its TUI stops at the trust
// question, and only the human answers it. Bazhen waits, says so past its deadline, and types
// nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LaunchAgentResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, waitUntil } from "./daemon.ts";
import { startFakeModel, type FakeModel } from "./fake-model.ts";
import { startFakeResponses } from "./fake-responses.ts";

/** What each harness's TUI asks before it works in a folder it hasn't been told to trust. */
const ASKS_TRUST = { "claude-code": /trust/i, codex: /trust/i } as const;

let anthropic: FakeModel;
let responses: FakeModel;
beforeAll(async () => {
  [anthropic, responses] = await Promise.all([startFakeModel(), startFakeResponses()]);
});
afterAll(async () => {
  await Promise.all([anthropic?.close(), responses?.close()]);
});

describe.each(["claude-code", "codex"] as const)(
  "%s launched in a folder it hasn't been told to trust",
  (harness) => {
    let daemon: Daemon;
    let launched: LaunchAgentResponse;
    const stuck = async () =>
      StateSnapshot.parse((await daemon.request("/v1/state")).body).attention.filter(
        (a) => a.agentId === launched.agentId && a.kind === "stuck_starting",
      );

    beforeAll(async () => {
      daemon = await Daemon.start({
        modelUrl: anthropic.url,
        responsesUrl: responses.url,
        config: "[agents]\nstart_deadline_seconds = 2\n",
      });
      const elsewhere = daemon.untrustedDirectory("elsewhere");
      const res = await daemon.request("/v1/agents", {
        method: "POST",
        body: { idempotencyKey: `untrusted-${harness}`, harness, cwd: elsewhere },
      });
      launched = LaunchAgentResponse.parse(res.body);
    });
    afterAll(async () => {
      await daemon?.stop();
    });

    it("stays starting at the trust question, and tells the human to look at its terminal", async () => {
      await waitUntil(
        async () => ASKS_TRUST[harness].test(await daemon.shows(launched.agentId)),
        "the trust question",
        30_000,
      );
      await expect.poll(stuck, { timeout: 15_000 }).toHaveLength(1);
      const [item] = await stuck();
      expect([await daemon.agentState(launched.agentId), item?.state, item?.summary]).toEqual([
        "starting",
        "open",
        expect.stringContaining("Look in its terminal for a dialog"),
      ]);
      // Nothing answered it while Bazhen waited.
      expect(await daemon.shows(launched.agentId)).toMatch(ASKS_TRUST[harness]);
    });

    it("runs once the human answers in its terminal, which closes the item as answered there", async () => {
      const view = await daemon.view(String(launched.terminalId), "interactive");
      await view.drive();
      // The human takes the trust question's first answer, which trusts the folder.
      view.type("\r");
      await daemon.running(launched.agentId, 30_000);
      const [item] = await stuck();
      view.close();
      expect([item?.state, item?.closeReason]).toEqual(["closed", "answered_in_tui"]);
    });
  },
);
