import { describe, expect, it } from "vitest";
import type { AgentRefs, RuntimeRef } from "@bazhen/core";
import type { ExitStatus } from "@bazhen/protocol";
import { fakeEnvironment, withAgent } from "../testing/fixtures.ts";
import { launchAgent } from "./launch.ts";
import {
  AgentStateConflict,
  EnvironmentUnavailable,
  Lifecycle,
  StaleGeneration,
} from "./lifecycle.ts";

/** A running agent whose environment records closes, fails them on demand, and reports exits. */
async function running() {
  const closed: AgentRefs[] = [];
  let failClose = false;
  let report: ((ref: RuntimeRef, status: ExitStatus) => void) | undefined;
  const { store, agentId, terminalId, environment } = await withAgent((s) => ({
    ...fakeEnvironment(s, async (l) => ({
      runtime: { terminalId: l.terminalId, runtime: "tmux", locator: { generation: "0" } },
      externalRef: null,
    })),
    close: async (refs) => {
      if (failClose) throw new Error("tmux unreachable");
      closed.push(refs);
    },
    onExit: (cb) => {
      report = cb;
      return () => (report = undefined);
    },
  }));
  const lifecycle = new Lifecycle(store, environment);
  lifecycle.watch();
  const exit = (generation: string, status: ExitStatus = { type: "exited", code: 1 }) =>
    report?.({ terminalId, runtime: "tmux", locator: { generation } }, status);
  const agent = () => store.snapshot().agents[0];
  const events = () => store.snapshot().eventId;
  const failCloses = (on: boolean) => (failClose = on);
  return { store, lifecycle, agentId, closed, exit, agent, events, failCloses };
}

describe("agent lifecycle", () => {
  it("records the exit of the agent's current generation, with how it ended", async () => {
    const { exit, agent } = await running();
    exit("0", { type: "signalled", signal: "SIGKILL" });
    expect(agent()).toMatchObject({
      state: "exited",
      exit: { type: "signalled", signal: "SIGKILL" },
    });
  });

  it("drops a report about an earlier generation of the terminal", async () => {
    const { exit, agent } = await running();
    exit("7");
    expect(agent()).toMatchObject({ state: "running", exit: null });
  });

  it("records an exit once, though the environment reports it on every check", async () => {
    const { exit, events } = await running();
    exit("0");
    const after = events();
    exit("0");
    expect(events()).toBe(after);
  });

  it("closes an agent: closing first, then its terminal, then closed", async () => {
    const { lifecycle, agentId, closed, agent } = await running();
    const res = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([res.eventIds.length, closed.length, agent()?.state]).toEqual([2, 1, "closed"]);
  });

  it("leaves the agent closing when the environment can't be reached, and finishes on a retry", async () => {
    const { lifecycle, agentId, agent, failCloses } = await running();
    failCloses(true);
    await expect(lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 })).rejects.toThrow(
      EnvironmentUnavailable,
    );
    expect(agent()?.state).toBe("closing");
    failCloses(false);
    const res = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([res.eventIds.length, agent()?.state]).toEqual([1, "closed"]);
  });

  it("closes a lost agent without asking the environment, whose terminal is already gone", async () => {
    const { store, lifecycle, agentId, closed, agent } = await running();
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    expect([closed.length, agent()?.state]).toEqual([0, "closed"]);
  });

  it("refuses a close naming a generation the terminal has moved past, with the current one", async () => {
    const { lifecycle, agentId, agent } = await running();
    const refused = lifecycle.close(agentId, { idempotencyKey: "c", generation: 3 });
    await expect(refused).rejects.toThrow(StaleGeneration);
    await expect(refused).rejects.toThrow("generation 0");
    expect(agent()?.state).toBe("running");
  });

  it("answers a repeated close with the first answer, and a close of a closed agent with nothing", async () => {
    const { lifecycle, agentId } = await running();
    const first = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    const again = await lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 });
    const later = await lifecycle.close(agentId, { idempotencyKey: "d", generation: 0 });
    expect([again, later.eventIds]).toEqual([first, []]);
  });

  it("refuses to close an agent whose launch failed, which holds nothing to close", async () => {
    const { store, lifecycle } = await running();
    const failed = await launchAgent(
      {
        store,
        environment: fakeEnvironment(store, () => Promise.reject(new Error("no tmux"))),
        size: { cols: 80, rows: 24 },
      },
      { idempotencyKey: "launch-2", harness: "claude-code", cwd: "/w" },
    ).catch((e: unknown) => e);
    const agentId = String(Reflect.get(Object(failed), "agentId"));
    await expect(lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 })).rejects.toThrow(
      AgentStateConflict,
    );
  });

  it("runs two closes of one agent one after the other, so the second finds it closed", async () => {
    const { lifecycle, agentId, closed } = await running();
    const [a, b] = await Promise.all([
      lifecycle.close(agentId, { idempotencyKey: "c", generation: 0 }),
      lifecycle.close(agentId, { idempotencyKey: "d", generation: 0 }),
    ]);
    expect([a.eventIds.length, b.eventIds.length, closed.length]).toEqual([2, 0, 1]);
  });
});
