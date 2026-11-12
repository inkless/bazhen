import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCommandResponse, ErrorResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon } from "./daemon.ts";

let daemon: Daemon;
beforeAll(async () => {
  daemon = await Daemon.start();
});
afterAll(async () => {
  await daemon?.stop();
});

const agentOf = async (agentId: string) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body).agents.find(
    (a) => a.id === agentId,
  );

const close = (agentId: string, key: string, generation = 0) =>
  daemon.request(`/v1/agents/${agentId}/close`, {
    method: "POST",
    body: { idempotencyKey: key, generation },
  });

describe("an agent's lifecycle after launch", () => {
  it("shows an agent whose process was killed from outside as exited, with how it ended", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    process.kill(daemon.panePid(agentId), "SIGKILL");
    await expect
      .poll(async () => (await agentOf(agentId))?.state, { timeout: 10_000 })
      .toBe("exited");
    expect((await agentOf(agentId))?.exit).toBeOneOf([
      { type: "signalled", signal: "SIGKILL" },
      { type: "unknown" },
    ]);
  });

  it("closes an agent, ending its tmux session, and answers a repeat the same way", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const first = await close(agentId, "close-once");
    const again = await close(agentId, "close-once");
    expect([first.status, AgentCommandResponse.parse(first.body).eventIds.length]).toEqual([
      200, 2,
    ]);
    expect(again.body).toEqual(first.body);
    expect([(await agentOf(agentId))?.state, daemon.hasTerminal(agentId)]).toEqual([
      "closed",
      false,
    ]);
  });

  it("refuses a close naming a generation the agent has moved past, and leaves it running", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const { status, body } = await close(agentId, "stale", 5);
    expect([status, ErrorResponse.parse(body).error]).toEqual([409, "stale_generation"]);
    expect((await agentOf(agentId))?.state).toBe("running");
  });

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
