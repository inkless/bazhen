// Shared fixtures for the daemon's medium tests: a store on a temporary file and a fake local
// environment, so each test states only what it changes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isId,
  newId,
  type AgentInventoryEntry,
  type AgentLaunch,
  type AgentRefs,
  type EnvironmentAdapter,
} from "@bazhen/core";
import { launchAgent, localEnvironmentId } from "../agents/launch.ts";
import { Store } from "../store/store.ts";

export const tempDb = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");

/** Dates every event the database at `path` holds to `ts`, as if they had been there a while. */
export function age(path: string, ts = "2026-01-01T00:00:00.000Z"): void {
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE events SET ts = ?").run(ts);
  raw.close();
}

/** A local environment that runs Claude Code only, launching however `launch` says. */
export function fakeEnvironment(
  store: Store,
  launch: (l: AgentLaunch) => Promise<AgentRefs> = async (l) => ({
    runtime: { terminalId: l.terminalId, runtime: "tmux", locator: {} },
    externalRef: null,
  }),
  present: () => AgentInventoryEntry[] = () => [],
): EnvironmentAdapter {
  return {
    id: localEnvironmentId(store),
    kind: "local",
    harnesses: ["claude-code"],
    health: async () => ({ state: "reachable", version: null }),
    inventory: async () => present(),
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

/** A view that came and went: two events no projection points at once it has ended. */
export function visit(store: Store, terminalId: string) {
  const attachmentId = newId("att");
  const started = store.append({
    type: "attachment.started",
    entityId: attachmentId,
    actor: "system",
    payload: { terminalId, mode: "observe" },
  });
  const ended = store.append({
    type: "attachment.ended",
    entityId: attachmentId,
    actor: "system",
    payload: { reason: "client_closed" },
  });
  return [started, ended] as const;
}
