import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start({ runtime: "tmux" });
});
afterAll(async () => {
  await daemon?.stop();
});

const agentOf = async (agentId: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find(
    (a) => a.id === agentId,
  );
const close = (agentId: string, key: string) =>
  daemon.request(`/v1/agents/${agentId}/close`, {
    method: "POST",
    body: { idempotencyKey: key, generation: 0 },
  });

describe("a tmux agent's lifecycle", () => {
  it("keeps an agent closing while tmux can't be reached, and closes it once it can", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const unblock = daemon.blockTmux();
    const refused = await close(agentId, "unreachable");
    const whileUnreachable = (await agentOf(agentId))?.state;
    unblock();
    expect([refused.status, ErrorResponse.parse(refused.body).error, whileUnreachable]).toEqual([
      503,
      "unavailable",
      "closing",
    ]);
    expect((await close(agentId, "unreachable")).status).toBe(200);
    expect((await agentOf(agentId))?.state).toBe("closed");
  });
});
