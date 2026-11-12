import { describe, expect, it } from "vitest";
import { LaunchFailed, UnsupportedHarness, type AgentLaunch } from "@bazhen/core";
import { Store } from "../store/store.ts";
import { fakeEnvironment, tempDb } from "../testing/fixtures.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { launchAgent, localEnvironmentId } from "./launch.ts";

function setup(fail = false) {
  const store = Store.open(tempDb());
  const launches: AgentLaunch[] = [];
  const environment = fakeEnvironment(store, async (l) => {
    launches.push(l);
    if (fail) throw new Error("tmux refused");
    return {
      runtime: { terminalId: l.terminalId, runtime: "tmux", locator: { session: "bz-1" } },
      externalRef: { environmentId: environment.id, kind: "claude-session", id: "s-1" },
    };
  });
  const deps = { store, environment, size: { cols: 120, rows: 40 } };
  return { store, deps, launches };
}

const request = { idempotencyKey: "k-1", harness: "claude-code" as const, cwd: "/work/repo" };

describe("localEnvironmentId", () => {
  it("registers the local environment once, and finds it again after a restart", () => {
    const path = tempDb();
    const first = Store.open(path);
    const id = localEnvironmentId(first);
    first.close();
    const again = Store.open(path);
    expect([localEnvironmentId(again), again.snapshot().environments]).toEqual([
      id,
      [{ id, kind: "local" }],
    ]);
    again.close();
  });
});

describe("launchAgent", () => {
  it("records the agent before starting it, then running with its harness session", async () => {
    const { store, deps } = setup();
    const answer = await launchAgent(deps, request);
    expect(store.eventsAfter(0).map((e) => e.type)).toEqual([
      "environment.registered",
      "agent.launched",
      "agent.running",
    ]);
    expect(store.snapshot().agents).toEqual([
      expect.objectContaining({
        id: answer.agentId,
        terminalId: answer.terminalId,
        project: "repo",
        state: "running",
        externalRef: { environmentId: deps.environment.id, kind: "claude-session", id: "s-1" },
      }),
    ]);
  });

  it("launches once for a repeated key, and answers the repeat with the first answer", async () => {
    const { deps, launches } = setup();
    const first = await launchAgent(deps, request);
    const again = await launchAgent(deps, request);
    expect([launches.length, again]).toEqual([1, first]);
  });

  it("refuses a harness the environment can't run before recording anything", async () => {
    const { store, deps, launches } = setup();
    await expect(launchAgent(deps, { ...request, harness: "codex" })).rejects.toThrow(
      UnsupportedHarness,
    );
    expect([store.snapshot().agents, launches]).toEqual([[], []]);
  });

  it("records a rejected launch as failed, and answers a repeat with the same failure", async () => {
    const { store, deps, launches } = setup(true);
    await expect(launchAgent(deps, request)).rejects.toThrow(LaunchFailed);
    await expect(launchAgent(deps, request)).rejects.toThrow(LaunchFailed);
    expect([store.snapshot().agents.map((a) => a.state), launches.length]).toEqual([["failed"], 1]);
  });

  it("refuses a key reused for a different launch, rather than answering for the first", async () => {
    const { deps, launches } = setup();
    await launchAgent(deps, request);
    await expect(launchAgent(deps, { ...request, cwd: "/elsewhere" })).rejects.toThrow(
      IdempotencyConflict,
    );
    expect(launches.length).toBe(1);
  });
});
