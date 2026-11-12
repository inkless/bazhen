// Shared fixtures for the daemon's medium tests: a store on a temporary file and a fake local
// environment, so each test states only what it changes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isId, type AgentLaunch, type AgentRefs, type EnvironmentAdapter } from "@bazhen/core";
import { launchAgent, localEnvironmentId } from "../agents/launch.ts";
import { Store } from "../store/store.ts";

export const tempDb = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");

/** A local environment that runs Claude Code only, launching however `launch` says. */
export function fakeEnvironment(
  store: Store,
  launch: (l: AgentLaunch) => Promise<AgentRefs> = async (l) => ({
    runtime: { terminalId: l.terminalId, runtime: "tmux", locator: {} },
    externalRef: null,
  }),
): EnvironmentAdapter {
  return {
    id: localEnvironmentId(store),
    kind: "local",
    harnesses: ["claude-code"],
    launch,
  };
}

/** A store with one running Claude Code agent and its terminal. */
export async function withAgent() {
  const path = tempDb();
  const store = Store.open(path);
  const launched = await launchAgent(
    { store, environment: fakeEnvironment(store), size: { cols: 80, rows: 24 } },
    { idempotencyKey: "launch", harness: "claude-code", cwd: "/w" },
  );
  const { agentId, terminalId } = launched;
  if (!isId("agent", agentId) || terminalId === null || !isId("term", terminalId)) {
    throw new Error("launched no agent");
  }
  return { path, store, agentId, terminalId };
}
