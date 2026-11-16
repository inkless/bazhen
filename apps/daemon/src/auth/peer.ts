import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { AgentSessionId } from "@bazhen/core";

/** Where `pnpm build` leaves the peer reader, which the daemon installs before running it. */
export const PEER_SOURCE = fileURLToPath(
  new URL("../../../../target/release/bazhen-peer", import.meta.url),
);
/** The installed binary's name in its build's directory. */
export const PEER_COMMAND = "bazhen-peer";

/**
 * A socket peer as `bazhen-peer` names it: its pid, its session, the nearest Codex app-server
 * among it and its ancestors, and its ancestors to the root.
 */
export interface PeerChain {
  readonly pid: number;
  readonly session: number;
  readonly codexServer: number | undefined;
  readonly ancestors: readonly number[];
}

/** The line `bazhen-peer` prints, its Codex app-server 0 for none, or undefined for anything else. */
export function parsePeer(line: string): PeerChain | undefined {
  const fields = line.trim().split(" ");
  if (fields.length < 3 || !fields.every((f) => /^[0-9]{1,10}$/.test(f))) return undefined;
  const [pid = 0, session = 0, codexServer = 0, ...ancestors] = fields.map(Number);
  return { pid, session, codexServer: codexServer === 0 ? undefined : codexServer, ancestors };
}

/** When each connection to the socket was accepted, which a peer's process must have started by. */
const accepted = new WeakMap<Socket, number>();

/** Records that `connection` was accepted now: call it from the server's `connection` event. */
export function noteAccepted(connection: Socket, now = Date.now()): void {
  accepted.set(connection, now);
}

/** How long one reading may take: the peer is waiting on its own reply meanwhile. */
const READ_MS = 2000;
/** The most readings at once; more wait their turn rather than each starting a process. */
const MAX_READING = 8;
let reading = 0;
const queued: (() => void)[] = [];

async function turn<T>(read: () => Promise<T>): Promise<T> {
  if (reading >= MAX_READING) await new Promise<void>((resolve) => queued.push(resolve));
  reading += 1;
  try {
    return await read();
  } finally {
    reading -= 1;
    queued.shift()?.();
  }
}

/**
 * Who is at the other end of `connection`, as `bazhen-peer` at `binary` reads it with the
 * connection as its standard input; undefined when it can't say for sure, whatever the reason.
 */
export function readPeer(
  binary: string,
  connection: Socket,
  timeoutMs = READ_MS,
): Promise<PeerChain | undefined> {
  const since = Math.ceil((accepted.get(connection) ?? Date.now()) / 1000);
  return turn(
    () =>
      new Promise((resolve) => {
        // A reading that takes too long is given up on, never stopped: it reads and exits.
        // Node stops reading a socket it hands a child as stdio, and only a read of the request
        // body starts it again: a route that read its body first would hear nothing more on the
        // connection.
        const done = (chain: PeerChain | undefined) => {
          clearTimeout(late);
          if (!connection.destroyed) connection.resume();
          resolve(chain);
        };
        const late = setTimeout(() => done(undefined), timeoutMs);
        const child = spawn(binary, [String(since)], { stdio: [connection, "pipe", "ignore"] });
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => (out += chunk));
        child.on("error", () => done(undefined));
        child.on("close", (code) => done(code === 0 ? parsePeer(out) : undefined));
      }),
  );
}

/** The processes the daemon's terminals run, as their refs record them. */
export interface TerminalPids {
  /** Each live agent terminal's root process: a tmux pane's, or a holder's child. */
  readonly agents: ReadonlyMap<number, AgentSessionId>;
  /** Each live shell terminal's root process. */
  readonly shells: ReadonlySet<number>;
  /** The processes that run terminals: tmux servers and holders. */
  readonly runtimes: ReadonlySet<number>;
}

/** What a socket peer's process says of the caller. */
export type PeerReading =
  | { readonly kind: "agent"; readonly agentId: AgentSessionId }
  | { readonly kind: "codex" }
  | { readonly kind: "outside" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Whose process `chain` is (foundation-design §9.1): an agent's, when the agent's root process is
 * its own or an ancestor, or leads its session, which a child orphaned to a subreaper still
 * keeps; nobody's, from a shell's, or from outside every terminal. A process under a runtime
 * that is in no terminal at all, as `tmux run-shell` starts one, is refused rather than taken
 * for the human.
 *
 * A process under a Codex app-server is a Codex tool call, whichever terminals are above the
 * server: Codex runs every agent's tool commands there, out of their terminals. Only an agent's
 * root nearer the caller than the server, as when Bazhen itself runs under one, still names it.
 * A caller marked only by its own environment (`bazhen-peer` names the caller itself) is a Codex
 * tool call only where no agent's terminal places it: any agent can set `CODEX_THREAD_ID`, and a
 * real Codex command runs under the server, outside every terminal.
 */
export function readingOf(chain: PeerChain, terminals: TerminalPids): PeerReading {
  const line = [chain.pid, ...chain.ancestors];
  const agentAt = line.findIndex((pid) => terminals.agents.has(pid));
  const byAncestry = agentAt === -1 ? undefined : terminals.agents.get(line[agentAt] ?? 0);
  const agentId = byAncestry ?? terminals.agents.get(chain.session);
  const markedOnly = chain.codexServer === chain.pid;
  const serverAt =
    chain.codexServer === undefined || markedOnly ? -1 : line.indexOf(chain.codexServer);
  if (serverAt !== -1 && (agentAt === -1 || serverAt < agentAt)) return { kind: "codex" };
  if (agentId !== undefined) return { kind: "agent", agentId };
  if (markedOnly) return { kind: "codex" };
  if (line.some((pid) => terminals.shells.has(pid))) return { kind: "outside" };
  if (line.some((pid) => terminals.runtimes.has(pid)))
    return { kind: "refused", reason: "the caller runs under Bazhen's runtime, in no terminal" };
  return { kind: "outside" };
}

/**
 * The socket's peer reading, as the daemon runs it: a connection whose process `binary` can't
 * read for sure, gone, replaced or past a process it can't see, is refused, never the human's.
 */
export function peerReading(
  binary: string,
  terminals: () => TerminalPids,
  timeoutMs = READ_MS,
): (connection: Socket) => Promise<PeerReading> {
  return async (connection) => {
    const chain = await readPeer(binary, connection, timeoutMs);
    return chain === undefined
      ? { kind: "refused", reason: "the caller's process can't be read for sure" }
      : readingOf(chain, terminals());
  };
}

/**
 * Whether `bazhen-peer` at `binary` reads the process listening on `socket` as a Codex app-server,
 * as it must to tell a Codex agent's commands from the human's: a Codex that renamed its binary or
 * that subcommand would read as no server. On a connection this process made, the peer is the
 * listener.
 */
export async function codexServerMarked(
  binary: string,
  socket: string,
  timeoutMs = READ_MS,
): Promise<"marked" | "unmarked" | "unread"> {
  const connection = await new Promise<Socket | undefined>((resolve) => {
    const made = connect(socket, () => resolve(made));
    made.on("error", () => resolve(undefined));
  });
  if (connection === undefined) return "unread";
  try {
    const chain = await readPeer(binary, connection, timeoutMs);
    if (chain === undefined) return "unread";
    return chain.codexServer === chain.pid ? "marked" : "unmarked";
  } finally {
    connection.destroy();
  }
}
