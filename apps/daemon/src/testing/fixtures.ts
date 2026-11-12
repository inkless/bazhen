// Shared fixtures for the daemon's medium tests: a store on a temporary file and a fake local
// environment, so each test states only what it changes.

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import {
  isId,
  newId,
  NoTerminal,
  type AgentInventoryEntry,
  type AgentLaunch,
  type AgentRefs,
  type EnvironmentAdapter,
} from "@bazhen/core";
import { launchAgent, localEnvironmentId } from "../agents/launch.ts";
import { upgrades, type UpgradeRoute } from "../http/upgrades.ts";
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
    resumable: ["claude-code"],
    health: async () => ({ state: "reachable", version: null }),
    inventory: async () => present(),
    launch,
    respawn: async ({ refs, generation }) => {
      if (refs.runtime === null) throw new NoTerminal();
      const locator = { ...refs.runtime.locator, generation: String(generation) };
      return { runtime: { ...refs.runtime, locator }, externalRef: refs.externalRef };
    },
    signal: async () => {},
    close: async () => {},
    onExit: () => () => {},
  };
}

/** A store with one running Claude Code agent and its terminal, in `environment`. */
export async function withAgent(
  environment: (store: Store) => EnvironmentAdapter = (store) => fakeEnvironment(store),
) {
  const path = tempDb();
  const store = Store.open(path);
  const env = environment(store);
  const launched = await launchAgent(
    { store, environment: env, size: { cols: 80, rows: 24 } },
    { idempotencyKey: "launch", harness: "claude-code", cwd: "/w" },
  );
  const { agentId, terminalId } = launched;
  if (!isId("agent", agentId) || terminalId === null || !isId("term", terminalId)) {
    throw new Error("launched no agent");
  }
  return { path, store, agentId, terminalId, environment: env };
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

/** Registers a local environment, answering its id and the event that recorded it. */
export function register(store: Store) {
  const environmentId = newId("env");
  const eventId = store.append({
    type: "environment.registered",
    entityId: environmentId,
    actor: "system",
    payload: { kind: "local" },
  });
  return { environmentId, eventId };
}

/** Resolves once the listeners a commit queued have run. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A server on a free port whose upgrades go through the daemon's guard to `routes`. */
export async function serveUpgrades(
  routes: readonly UpgradeRoute[],
): Promise<{ server: Server; host: string }> {
  const server = createServer();
  const allow = { hosts: [] as string[], origins: [] as string[] };
  server.on("upgrade", upgrades(allow, routes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const host = `127.0.0.1:${address.port}`;
  allow.hosts.push(host);
  allow.origins.push(`http://${host}`);
  return { server, host };
}

/** The status an upgrade was refused with, "open" if it was let through, or why it failed. */
export const upgradeOutcome = (ws: WebSocket) =>
  new Promise((resolve) => {
    ws.once("unexpected-response", (_q, res) => resolve(res.statusCode));
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("error", (err) => resolve(err.message));
  });
