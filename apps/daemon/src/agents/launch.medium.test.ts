import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_INSTRUCTIONS } from "../tasks/mail.ts";
import { describe, expect, it } from "vitest";
import { LaunchFailed, UnsupportedHarness, type AgentLaunch } from "@bazhen/core";
import { Store } from "../store/store.ts";
import { fakeEnvironment, tempDb, testView } from "../testing/fixtures.ts";
import { IdempotencyConflict } from "../store/store.ts";
import { InvalidDirectory } from "./cwd.ts";
import { launchAgent, launchSettled, localEnvironmentId } from "./launch.ts";
import { AgentQueue } from "./queue.ts";

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
      ...(l.options.theme && { theme: l.options.theme }),
    };
  });
  const deps = { store, environment, size: { cols: 120, rows: 40 }, home, queue: new AgentQueue() };
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

  it("hands the environment the theme the request names, and shows the one its TUI started in", async () => {
    const { store, deps, launches } = setup();
    await launchAgent(deps, { ...request, theme: "light" });
    await launchAgent(deps, { ...request, idempotencyKey: "k-2" });
    expect(launches.map((l) => l.options)).toEqual([
      { theme: "light", instructions: FLEET_INSTRUCTIONS },
      { instructions: FLEET_INSTRUCTIONS },
    ]);
    expect(store.snapshot(testView).agents.map((a) => a.theme)).toEqual(["light", "dark"]);
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

  it("launches once for a key repeated in the same tick, and answers the repeat so far", async () => {
    const { store, deps, launches } = setup();
    const [first, again] = await Promise.all([
      launchAgent(deps, request),
      launchAgent(deps, request),
    ]);
    expect([launches.length, store.snapshot(testView).agents.length]).toEqual([1, 1]);
    expect(again).toEqual({ ...first, eventIds: first.eventIds.slice(0, 1) });
  });

  it("holds its agent's slot from the moment the agent is recorded", async () => {
    const { store, deps } = setup();
    const launching = launchAgent(deps, request);
    const recorded = store.snapshot(testView).agents.map((a) => [a.state, deps.queue.busy(a.id)]);
    await launching;
    expect(recorded).toEqual([["starting", true]]);
  });

  it("refuses a key reused in the same tick for a different launch, launching once", async () => {
    const { deps, launches } = setup();
    const first = launchAgent(deps, request);
    const other = launchAgent(deps, { ...request, cwd: "~" });
    await expect(other).rejects.toThrow(IdempotencyConflict);
    expect([(await first).agentId, launches.length]).toEqual([expect.any(String), 1]);
  });

  it("answers a repeat with the settled launch once settling is asked for", async () => {
    const { deps, launches } = setup();
    const [first, again] = await Promise.all([
      launchSettled(deps, request),
      launchSettled(deps, request),
    ]);
    expect([launches.length, first.eventIds.length, again]).toEqual([1, 2, first]);
  });

  it("fails a repeat with its launch's failure once settling is asked for", async () => {
    const { deps, launches } = setup(true);
    const both = await Promise.allSettled([
      launchSettled(deps, request),
      launchSettled(deps, request),
    ]);
    expect([both.map((r) => r.status), launches.length]).toEqual([["rejected", "rejected"], 1]);
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

  it("says why a launch failed, to the caller and in the record", async () => {
    const { store, deps } = setup(true);
    await expect(launchAgent(deps, request)).rejects.toThrow("failed to launch: tmux refused");
    const failed = store.events(0).find((e) => e.type === "agent.failed")?.payload;
    expect(failed).toEqual({ reason: "launch_rejected", detail: "tmux refused" });
  });

  it("answers a repeat of a failed launch with why it failed", async () => {
    const { deps } = setup(true);
    await launchAgent(deps, request).catch(() => {});
    await expect(launchAgent(deps, request)).rejects.toThrow(
      "failed to launch: an earlier attempt failed: tmux refused",
    );
  });

  it("refuses a key reused for a different launch, rather than answering for the first", async () => {
    const { deps, launches } = setup();
    await launchAgent(deps, request);
    await expect(launchAgent(deps, { ...request, cwd: "~" })).rejects.toThrow(IdempotencyConflict);
    expect(launches.length).toBe(1);
  });
});
