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
import { AgentQueue } from "../agents/queue.ts";
import { upgrades, type UpgradeRoute } from "../http/upgrades.ts";
import { Store, type SnapshotView } from "../store/store.ts";

/** What a test's state snapshot shows beyond the store: a fixed host, and Claude Code resumable. */
export const testView: SnapshotView = {
  host: () => "test-host",
  attachCommand: (ref) => `attach ${ref.terminalId}`,
  resumable: ["claude-code"],
  themes: () => ["light", "dark"],
  attentionActions: (item) => {
    if (item.kind === "approval") return ["allow", "deny"];
    return item.kind === "question" ? [] : ["reply", "dismiss"];
  },
};

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
    themes: { "claude-code": ["light", "dark"] },
    health: async () => ({ state: "reachable", version: null }),
    inventory: async () => present(),
    launch,
    respawn: async ({ refs, generation, options }) => {
      if (refs.runtime === null) throw new NoTerminal();
      const locator = { ...refs.runtime.locator, generation: String(generation) };
      const runtime = { ...refs.runtime, locator };
      return {
        runtime,
        externalRef: refs.externalRef,
        ...(options.theme && { theme: options.theme }),
      };
    },
    signal: async () => {},
    close: async () => {},
    gone: async ({ runtime }) => !present().some((e) => e.ref.terminalId === runtime?.terminalId),
    shells: async () => [],
    openShell: async ({ terminalId }) => ({ terminalId, runtime: "tmux", locator: {} }),
    shellBusy: async () => null,
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
    {
      store,
      environment: env,
      size: { cols: 80, rows: 24 },
      home: tmpdir(),
      queue: new AgentQueue(),
    },
    { idempotencyKey: "launch", harness: "claude-code", cwd: "~" },
  );
  const { agentId, terminalId } = launched;
  if (!isId("agent", agentId) || terminalId === null || !isId("term", terminalId)) {
    throw new Error("launched no agent");
  }
  return { path, store, agentId, terminalId, environment: env };
}

/** The Claude Code session `claudeAgent` launches on, and its pane's process. */
export const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
export const PANE_PID = 4242;

/** A store with one running Claude Code agent bound to `CLAUDE_SESSION` in pane `PANE_PID`. */
export const claudeAgent = () =>
  withAgent((store) =>
    fakeEnvironment(store, async (l) => ({
      runtime: {
        terminalId: l.terminalId,
        runtime: "tmux",
        locator: { panePid: String(PANE_PID) },
      },
      externalRef: {
        environmentId: localEnvironmentId(store),
        kind: "claude-session",
        id: CLAUDE_SESSION,
      },
    })),
  );

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

/** The tmux server the Codex fixtures' agents run on. */
export const FIXTURE_TMUX_SOCKET = "/run/bazhen/tmux.sock";

/**
 * A store with a running Codex agent bound to each of `threads`, by thread; a null thread gives
 * an agent bound to none. The nth agent's terminal is in pane `%n` on FIXTURE_TMUX_SOCKET.
 */
export async function withCodexAgents(...threads: (string | null)[]) {
  const store = Store.open(tempDb());
  const agents = new Map<string | null, string>();
  for (const [i, threadId] of threads.entries()) {
    const locator = { socket: FIXTURE_TMUX_SOCKET, paneId: `%${i}` };
    const environment: EnvironmentAdapter = {
      ...fakeEnvironment(store, async (l) => ({
        runtime: { terminalId: l.terminalId, runtime: "tmux", locator },
        externalRef:
          threadId === null
            ? null
            : { environmentId: localEnvironmentId(store), kind: "codex-thread", id: threadId },
      })),
      harnesses: ["codex"],
    };
    const { agentId } = await launchAgent(
      { store, environment, size: { cols: 80, rows: 24 }, home: tmpdir(), queue: new AgentQueue() },
      { idempotencyKey: `codex-${String(threadId)}`, harness: "codex", cwd: "~" },
    );
    agents.set(threadId, agentId);
  }
  /** The agent on `threadId`; a thread the fixture didn't make fails the test outright. */
  const agentOn = (threadId: string | null) => {
    const agentId = agents.get(threadId);
    if (agentId === undefined) throw new Error(`no agent on thread ${String(threadId)}`);
    return agentId;
  };
  return { store, agentOn };
}

/** A store with one running Codex agent, bound to `threadId`. */
export async function withCodexAgent(threadId = "thr-1") {
  const { store, agentOn } = await withCodexAgents(threadId);
  return { store, agentId: agentOn(threadId) };
}
