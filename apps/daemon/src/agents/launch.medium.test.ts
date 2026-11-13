import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LaunchFailed, UnsupportedHarness, type AgentLaunch } from "@bazhen/core";
import { Store } from "../store/store.ts";
import { fakeEnvironment, tempDb, testView } from "../testing/fixtures.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { InvalidDirectory } from "./cwd.ts";
import { launchAgent, localEnvironmentId } from "./launch.ts";

function setup(fail = false) {
  // The daemon user's home, with the project a launch names as ~/repo.
  const home = mkdtempSync(join(tmpdir(), "bz-launch-"));
  mkdirSync(join(home, "repo"));
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
  const deps = { store, environment, size: { cols: 120, rows: 40 }, home };
  return { store, deps, launches, home };
}

const request = { idempotencyKey: "k-1", harness: "claude-code" as const, cwd: "~/repo" };

describe("localEnvironmentId", () => {
  it("registers the local environment once, and finds it again after a restart", () => {
    const path = tempDb();
    const first = Store.open(path);
    const id = localEnvironmentId(first);
    first.close();
    const again = Store.open(path);
    expect([localEnvironmentId(again), again.snapshot(testView).environments]).toEqual([
      id,
      [{ id, kind: "local", host: "test-host" }],
    ]);
    again.close();
  });
});

describe("launchAgent", () => {
  it("records the agent before starting it, then running with its harness session", async () => {
    const { store, deps } = setup();
    const answer = await launchAgent(deps, request);
    expect(store.events(0).map((e) => e.type)).toEqual([
      "environment.registered",
      "agent.launched",
      "agent.running",
    ]);
    expect(store.snapshot(testView).agents).toEqual([
      expect.objectContaining({
        id: answer.agentId,
        terminalId: answer.terminalId,
        project: "repo",
        state: "running",
        externalRef: { environmentId: deps.environment.id, kind: "claude-session", id: "s-1" },
      }),
    ]);
  });

  it("launches in the daemon user's home for a ~/ directory", async () => {
    const { store, deps, launches, home } = setup();
    await launchAgent(deps, request);
    expect([launches[0]?.request.cwd, store.snapshot(testView).agents[0]?.cwd]).toEqual([
      join(home, "repo"),
      join(home, "repo"),
    ]);
  });

  it("hands the environment the theme the request names, or none, and stores neither", async () => {
    const { store, deps, launches } = setup();
    await launchAgent(deps, { ...request, theme: "light" });
    await launchAgent(deps, { ...request, idempotencyKey: "k-2" });
    expect(launches.map((l) => l.options)).toEqual([{ theme: "light" }, {}]);
    expect(JSON.stringify(store.snapshot(testView))).not.toContain("light");
  });

  it("answers a repeated key from the first answer, though its directory has gone since", async () => {
    const { deps, launches, home } = setup();
    const first = await launchAgent(deps, request);
    rmSync(join(home, "repo"), { recursive: true });
    expect([await launchAgent(deps, request), launches.length]).toEqual([first, 1]);
    // A new launch there is refused: only the retry is answered without looking.
    await expect(launchAgent(deps, { ...request, idempotencyKey: "k-2" })).rejects.toThrow(
      InvalidDirectory,
    );
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
    expect([store.snapshot(testView).agents, launches]).toEqual([[], []]);
  });

  it("records a rejected launch as failed, and answers a repeat with the same failure", async () => {
    const { store, deps, launches } = setup(true);
    await expect(launchAgent(deps, request)).rejects.toThrow(LaunchFailed);
    await expect(launchAgent(deps, request)).rejects.toThrow(LaunchFailed);
    expect([store.snapshot(testView).agents.map((a) => a.state), launches.length]).toEqual([
      ["failed"],
      1,
    ]);
  });

  it("refuses a key reused for a different launch, rather than answering for the first", async () => {
    const { deps, launches } = setup();
    await launchAgent(deps, request);
    await expect(launchAgent(deps, { ...request, cwd: "~" })).rejects.toThrow(IdempotencyConflict);
    expect(launches.length).toBe(1);
  });
});
