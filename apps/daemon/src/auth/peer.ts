import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { AgentSessionId } from "@bazhen/core";
import { heard } from "@bazhen/host-guard";

/** Where `make build` leaves the peer reader, which the daemon installs before running it. */
export const PEER_SOURCE = fileURLToPath(
  new URL("../../../../target/release/bazhen-peer", import.meta.url),
);
/** The installed binary's name in its build's directory. */
export const PEER_COMMAND = "bazhen-peer";

/**
 * A socket peer as `bazhen-peer` names it: its pid, its session (0 for one led from outside the
 * daemon's PID namespace, which no terminal's process leads), the nearest Codex app-server among
 * it and its ancestors, whether the kernel withheld its environment for the group it runs as, and
 * its ancestors to the root.
 */
export interface PeerChain {
  readonly pid: number;
  readonly session: number;
  readonly codexServer: number | undefined;
  readonly environmentWithheld: boolean;
  readonly ancestors: readonly number[];
}

/**
 * The line `bazhen-peer` prints, its Codex app-server 0 for none and its environment 1 for
 * withheld, 0 for read, or undefined for anything else.
 */
export function parsePeer(line: string): PeerChain | undefined {
  const fields = line.trim().split(" ");
  if (fields.length < 4 || !fields.every((f) => /^[0-9]{1,10}$/.test(f))) return undefined;
  const [pid = 0, session = 0, codexServer = 0, withheld = 0, ...ancestors] = fields.map(Number);
  if (withheld > 1) return undefined;
  return {
    pid,
    session,
    codexServer: codexServer === 0 ? undefined : codexServer,
    environmentWithheld: withheld === 1,
    ancestors,
  };
}

/** How long one reading may take: the peer is waiting on its own reply meanwhile. */
const READ_MS = 2000;
/** The most readings at once; more wait their turn rather than each starting a process. */
export const MAX_READING = 8;
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
 * Whether the kernel's name for a socket's peer can be a process other than the one that
 * connected: macOS names the peer socket's last user, which a process the connection is handed to
 * becomes once it touches it. There the one it names as the connection is accepted is pinned
 * (`noteAccepted`) and every reading is of that one, as Linux reads the process that connected.
 */
export const PINS_CONNECTOR = process.platform === "darwin";

/**
 * When each connection to the socket was accepted, in epoch microseconds, which a peer's process
 * must have started by.
 */
const accepted = new WeakMap<Socket, number>();

/** A connector pinned as its connection was accepted: its pid and start, as the reader gave them. */
type Pin =
  | { readonly kind: "pinned"; readonly pid: string; readonly started: string }
  | { readonly kind: "unread"; readonly why: string }
  | { readonly kind: "late" };

/** Each connection's connector, where one is pinned (`PINS_CONNECTOR`). */
const pins = new WeakMap<Socket, Promise<Pin>>();

/**
 * `ms`, an epoch millisecond, as the epoch microsecond a connection accepted then was accepted by:
 * the last of that millisecond, which a process that started before it can't have started after.
 */
export const acceptedBy = (ms: number): number => ms * 1000 + 999;

/**
 * Records that `connection` was accepted at `now` (epoch milliseconds), and, where the kernel's
 * name for its peer can be another process than the connector (`PINS_CONNECTOR`), pins the one it
 * names with the reader at `binary`: call it from the server's `connection` event, before any
 * request on it is read. A connection with none pinned there is refused.
 */
export function noteAccepted(connection: Socket, binary?: string, now = Date.now()): void {
  const since = acceptedBy(now);
  accepted.set(connection, since);
  if (PINS_CONNECTOR && binary !== undefined)
    pins.set(
      connection,
      run(binary, ["connector", String(since)], connection, READ_MS).then((ran): Pin => {
        if (ran.kind !== "ran") return ran;
        const [, pid, started] =
          (ran.code === 0 && /^([0-9]{1,10}) ([0-9]{1,20})\n?$/.exec(ran.out)) || [];
        return pid === undefined || started === undefined
          ? { kind: "unread", why: whyNot(ran, "connector") }
          : { kind: "pinned", pid, started };
      }),
    );
}

/**
 * A reading of a socket's peer: who it is; nobody, and why; or late, when the reader was still
 * running at its deadline, which says nothing about the caller but that it wasn't read in time.
 */
export type PeerRead =
  | { readonly kind: "read"; readonly chain: PeerChain }
  | { readonly kind: "unread"; readonly why: string }
  | { readonly kind: "late" };

/** The most bytes of the reader's stderr kept; its reason is the first line of them. */
const MAX_WHY = 512;

/**
 * Who is at the other end of `connection`, as `bazhen-peer` at `binary` reads it with the
 * connection as its standard input: the connector pinned when it was accepted, where one is
 * (`noteAccepted`).
 */
export async function readPeer(
  binary: string,
  connection: Socket,
  timeoutMs = READ_MS,
): Promise<PeerRead> {
  const since = accepted.get(connection) ?? acceptedBy(Date.now());
  const pin = await pins.get(connection);
  if (pin !== undefined && pin.kind !== "pinned") return pin;
  const args = [String(since), ...(pin === undefined ? [] : [pin.pid, pin.started])];
  const ran = await run(binary, args, connection, timeoutMs);
  if (ran.kind !== "ran") return ran;
  const chain = ran.code === 0 ? parsePeer(ran.out) : undefined;
  return chain === undefined
    ? { kind: "unread", why: whyNot(ran, "peer") }
    : { kind: "read", chain };
}

/**
 * How the reader ended: its exit, what it printed and the first line of what it said why; that it
 * couldn't start; or that it was still running at its deadline.
 */
type Ran =
  | {
      readonly kind: "ran";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly out: string;
      readonly said: string;
    }
  | { readonly kind: "unread"; readonly why: string }
  | { readonly kind: "late" };

/** Why a reader that ran gave no `printed`: what it said, else how it ended. */
function whyNot(ran: Extract<Ran, { kind: "ran" }>, printed: string): string {
  if (ran.said !== "") return ran.said;
  if (ran.code === 0) return `the reader printed no ${printed}`;
  return `the reader ${ran.signal === null ? `exited ${ran.code}` : `was ended by ${ran.signal}`}`;
}

/**
 * The reader at `binary`, run with `args` and `connection` as its standard input, in its turn.
 */
function run(
  binary: string,
  args: readonly string[],
  connection: Socket,
  timeoutMs: number,
): Promise<Ran> {
  return turn(
    () =>
      new Promise((resolve) => {
        // A reading that takes too long is given up on, never stopped: it reads and exits.
        // Node stops reading a socket it hands a child as stdio, and only a read of the request
        // body starts it again: a route that read its body first would hear nothing more on the
        // connection.
        const done = (ran: Ran) => {
          clearTimeout(deadline);
          if (!connection.destroyed) connection.resume();
          resolve(ran);
        };
        const child = heard(spawn(binary, args, { stdio: [connection, "pipe", "pipe"] }));
        // The deadline judges the reader, not this loop: after a stall the timer runs before the
        // exit that came during it is read, so the exit gets one turn to land first.
        const deadline = setTimeout(
          () =>
            setImmediate(() => {
              if (child.exitCode === null && child.signalCode === null) done({ kind: "late" });
            }),
          timeoutMs,
        );
        let out = "";
        let err = Buffer.alloc(0);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => (out += chunk));
        child.stderr?.on("data", (chunk: Buffer) => {
          if (err.length < MAX_WHY) err = Buffer.concat([err, chunk]).subarray(0, MAX_WHY);
        });
        child.on("error", (e) =>
          done({ kind: "unread", why: `the reader can't start: ${e.message}` }),
        );
        child.on("close", (code, signal) => {
          // One line: a reader that panicked says more than a reason, and its first line is why.
          const [said = ""] = err.toString("utf8").trim().split("\n", 1);
          done({ kind: "ran", code, signal, out, said });
        });
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

/**
 * A Codex tool call, known by the app-server among the caller and its ancestors, or only by the
 * `CODEX_THREAD_ID` in the caller's own environment, outside every agent's terminal.
 */
export type CodexReading = { readonly kind: "codex"; readonly via: "server" | "environment" };

/**
 * What a socket peer's process says of the caller. `withheld` is outside every agent's terminal
 * with its environment unread, so only the thread the call presents can say it is a Codex tool
 * call.
 */
export type PeerReading =
  | { readonly kind: "agent"; readonly agentId: AgentSessionId }
  | CodexReading
  | { readonly kind: "outside" }
  | { readonly kind: "withheld" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "late" };

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
 * real Codex command runs under the server, outside every terminal. A caller outside every
 * terminal whose environment the kernel withheld can't be read for that mark, so it is `withheld`.
 */
export function readingOf(chain: PeerChain, terminals: TerminalPids): PeerReading {
  const line = [chain.pid, ...chain.ancestors];
  const agentAt = line.findIndex((pid) => terminals.agents.has(pid));
  const byAncestry = agentAt === -1 ? undefined : terminals.agents.get(line[agentAt] ?? 0);
  const agentId = byAncestry ?? terminals.agents.get(chain.session);
  const markedOnly = chain.codexServer === chain.pid;
  const serverAt =
    chain.codexServer === undefined || markedOnly ? -1 : line.indexOf(chain.codexServer);
  if (serverAt !== -1 && (agentAt === -1 || serverAt < agentAt))
    return { kind: "codex", via: "server" };
  if (agentId !== undefined) return { kind: "agent", agentId };
  if (markedOnly) return { kind: "codex", via: "environment" };
  const outside = chain.environmentWithheld
    ? { kind: "withheld" as const }
    : { kind: "outside" as const };
  if (line.some((pid) => terminals.shells.has(pid))) return outside;
  if (line.some((pid) => terminals.runtimes.has(pid)))
    return { kind: "refused", reason: "the caller runs under Bazhen's runtime, in no terminal" };
  return outside;
}

/**
 * The socket's peer reading, as the daemon runs it: a connection whose process `binary` can't
 * read for sure, gone, replaced or past a process it can't see, is refused, never the human's;
 * one it hasn't read in time is late, and never the human's either.
 */
export function peerReading(
  binary: string,
  terminals: () => TerminalPids,
  timeoutMs = READ_MS,
): (connection: Socket) => Promise<PeerReading> {
  return async (connection) => {
    const read = await readPeer(binary, connection, timeoutMs);
    if (read.kind === "late") return read;
    if (read.kind === "unread")
      return {
        kind: "refused",
        reason: `the caller's process can't be read for sure: ${read.why}`,
      };
    return readingOf(read.chain, terminals());
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
  // The listener is the peer of a connection this process made, as of when it was made.
  noteAccepted(connection, binary);
  try {
    const read = await readPeer(binary, connection, timeoutMs);
    if (read.kind !== "read") return "unread";
    return read.chain.codexServer === read.chain.pid ? "marked" : "unmarked";
  } finally {
    connection.destroy();
  }
}
