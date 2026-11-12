import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCommandResponse, ErrorResponse, StateSnapshot } from "@bazhen/protocol";
import { isAlive } from "@bazhen/host-guard";
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

/** Waits until the daemon shows the agent in `state`. */
async function becomes(agentId: string, state: string): Promise<void> {
  await expect.poll(async () => (await agentOf(agentId))?.state, { timeout: 10_000 }).toBe(state);
}

const command = (name: string, agentId: string, body: Record<string, unknown>) =>
  daemon.request(`/v1/agents/${agentId}/${name}`, { method: "POST", body });
const close = (agentId: string, key: string, generation = 0) =>
  command("close", agentId, { idempotencyKey: key, generation });
const respawn = (agentId: string, key: string, generation = 0) =>
  command("respawn", agentId, { idempotencyKey: key, generation });
const signal = (agentId: string, key: string, sig: string, generation = 0) =>
  command("signal", agentId, { idempotencyKey: key, generation, signal: sig });

/** An agent whose process has exited, as the daemon has seen. */
async function exitedAgent(): Promise<string> {
  const { agentId } = await daemon.program(["sleep", "300"]);
  await daemon.signalAgent(agentId, "SIGKILL");
  await becomes(agentId, "exited");
  return agentId;
}

describe("an agent's lifecycle after launch", () => {
  it("shows an agent whose process was killed from outside as exited, with how it ended", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    await daemon.signalAgent(agentId, "SIGKILL");
    await becomes(agentId, "exited");
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

  it("respawns an exited agent under the same id, at the next generation, on its session", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const before = daemon.panePid(agentId);
    await daemon.signalAgent(agentId, "SIGKILL");
    await becomes(agentId, "exited");
    const session = (await agentOf(agentId))?.externalRef;
    const res = await respawn(agentId, "respawn");
    expect([res.status, AgentCommandResponse.parse(res.body).eventIds.length]).toEqual([200, 2]);
    expect(await agentOf(agentId)).toMatchObject({
      id: agentId,
      generation: 1,
      externalRef: session,
    });
    const after = daemon.panePid(agentId);
    expect([after !== before, isAlive(after)]).toEqual([true, true]);
  });

  it("refuses to respawn an agent that is running, or one named at a stale generation", async () => {
    const { agentId } = await daemon.program(["sleep", "300"]);
    const running = await respawn(agentId, "respawn-running");
    await daemon.signalAgent(agentId, "SIGKILL");
    await becomes(agentId, "exited");
    const stale = await respawn(agentId, "respawn-stale", 4);
    expect([running.status, stale.status, ErrorResponse.parse(stale.body).error]).toEqual([
      409,
      409,
      "stale_generation",
    ]);
  });

  it("leaves an agent exited and closable when its terminal vanished before a respawn", async () => {
    const agentId = await exitedAgent();
    daemon.endTerminal(agentId);
    const refused = await respawn(agentId, "respawn-gone");
    const state = (await agentOf(agentId))?.state;
    const closed = await close(agentId, "close-after-reject");
    expect([refused.status, state, closed.status]).toEqual([409, "exited", 200]);
  });

  // A process the daemon started: the runtime signals only the process it recorded, so a
  // program swapped in behind its back is refused, as it should be.
  it("signals a running agent's own process through the daemon, which then shows exited", async () => {
    const { agentId } = await daemon.launch("signal-me");
    await becomes(agentId, "running");
    const stale = await signal(agentId, "signal-stale", "SIGKILL", 3);
    const sent = await signal(agentId, "signal", "SIGKILL");
    expect([stale.status, sent.status]).toEqual([409, 200]);
    await becomes(agentId, "exited");
    expect((await agentOf(agentId))?.exit).toBeOneOf([
      { type: "signalled", signal: "SIGKILL" },
      { type: "unknown" },
    ]);
  });
});
