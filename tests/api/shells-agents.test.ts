import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon, waitUntil } from "./daemon.ts";
import { open, shellOf } from "./shell-calls.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

/** Idempotency keys for the calls the tests make themselves. */
let keys = 0;

describe("shells beside an agent", () => {
  it("close with it, except the one kept, which runs on standalone", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const [closing, kept] = [
      await open(daemon, { cwd: undefined, linkedAgentId: agentId }),
      await open(daemon, { cwd: undefined, linkedAgentId: agentId }),
    ];
    await waitUntil(() => daemon.terminalOpen(kept), "the kept shell's terminal");
    expect(await daemon.linkedAgentOf(kept)).toBe(agentId);
    const closed = await daemon.request(`/v1/agents/${agentId}/close`, {
      method: "POST",
      body: { idempotencyKey: `close-agent-${++keys}`, generation: 0, keepShells: [kept] },
    });
    expect(closed.status).toBe(200);
    expect([await daemon.terminalOpen(closing), await daemon.terminalOpen(kept)]).toEqual([
      false,
      true,
    ]);
    expect(await daemon.linkedAgentOf(kept)).toBeUndefined();
    expect((await shellOf(daemon, kept))?.linkedAgentId).toBeNull();
  });
});
