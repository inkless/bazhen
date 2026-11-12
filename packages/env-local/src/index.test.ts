import { describe, expect, it } from "vitest";
import {
  newId,
  UnsupportedHarness,
  type HarnessAdapter,
  type RuntimeAdapter,
  type RuntimeHealth,
  type RuntimeInventoryEntry,
  type TerminalSpec,
} from "@bazhen/core";
import { LocalEnvironment } from "./index.ts";

/** An in-memory runtime that records what it was asked to create. */
function fakeRuntime(
  health: RuntimeHealth = { state: "healthy", version: null },
  inventory: RuntimeInventoryEntry[] = [],
) {
  const created: TerminalSpec[] = [];
  const runtime: RuntimeAdapter = {
    kind: "fake",
    health: async () => health,
    inventory: async () => inventory,
    create: async (spec) => {
      created.push(spec);
      return { terminalId: spec.terminalId, runtime: "fake", locator: { session: "s" } };
    },
    attach: () => Promise.reject(new Error("not used")),
    close: () => Promise.reject(new Error("not used")),
    respawn: () => Promise.reject(new Error("not used")),
    signal: () => Promise.reject(new Error("not used")),
    onExit: () => () => {},
  };
  return { runtime, created };
}

const harness: HarnessAdapter = {
  id: "claude-code",
  launchSpec: () => ({
    argv: ["claude", "--session-id", "s-1"],
    env: { HARNESS_OWN: "1" },
    externalRef: { kind: "claude-session", id: "s-1" },
  }),
};

const environment = (runtime: RuntimeAdapter) =>
  new LocalEnvironment({ id: newId("env"), runtime, harnesses: [harness], socket: "/run/b.sock" });

const launch = (harnessId: "claude-code" | "codex" = "claude-code") => ({
  agentId: newId("agent"),
  terminalId: newId("term"),
  request: { harness: harnessId, project: "p", cwd: "/work" },
  size: { cols: 80, rows: 24 },
});

describe("local environment", () => {
  it("runs the harness's TUI in a terminal tagged with its agent, with Bazhen's variables", async () => {
    const { runtime, created } = fakeRuntime();
    const l = launch();
    await environment(runtime).launch(l);
    expect(created).toEqual([
      {
        terminalId: l.terminalId,
        tags: { kind: "agent", agentId: l.agentId },
        argv: ["claude", "--session-id", "s-1"],
        cwd: "/work",
        env: { HARNESS_OWN: "1", BAZHEN_AGENT_ID: l.agentId, BAZHEN_SOCKET: "/run/b.sock" },
        size: { cols: 80, rows: 24 },
      },
    ]);
  });

  it("names the harness session it launched, in this environment", async () => {
    const env = environment(fakeRuntime().runtime);
    const refs = await env.launch(launch());
    expect(refs.externalRef).toEqual({ environmentId: env.id, kind: "claude-session", id: "s-1" });
  });

  it("refuses a harness it has no adapter for, rather than emulating it", async () => {
    const { runtime, created } = fakeRuntime();
    await expect(environment(runtime).launch(launch("codex"))).rejects.toThrow(UnsupportedHarness);
    expect(created).toEqual([]);
  });

  it("is reachable only while its tmux server runs, and unknown while none does", async () => {
    const states = await Promise.all(
      (["healthy", "not-running", "unreachable"] as const).map(
        async (state) =>
          (await environment(fakeRuntime({ state, version: null }).runtime).health()).state,
      ),
    );
    expect(states).toEqual(["reachable", "unknown", "unreachable"]);
  });

  it("lists only agent terminals, by the agent their tags name", async () => {
    const agentId = newId("agent");
    const ref = { terminalId: newId("term"), runtime: "fake", locator: {} };
    const shell = { terminalId: newId("term"), runtime: "fake", locator: {} };
    const { runtime } = fakeRuntime({ state: "healthy", version: null }, [
      { ref, tags: { kind: "agent", agentId }, exit: null },
      { ref: shell, tags: { kind: "shell" }, exit: null },
    ]);
    expect(await environment(runtime).inventory()).toEqual([{ agentId, ref, dead: false }]);
  });
});
