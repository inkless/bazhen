// An in-memory RuntimeAdapter, for tests that must not run tmux. It keeps TmuxRuntime's contract:
// runtime-contract.ts runs one suite against both, so what a test proves against this runtime
// holds against tmux. A program's argv decides what it does: `sh -c '… exit N'` exits with N at
// once, `cat` echoes what it is sent, and anything else runs until it is signalled. Output that
// switches screens puts the program on its alternate screen or takes it off. As with tmux,
// no server runs until the first terminal is created or after the last one goes, and while none
// runs nothing can be read. It attaches as tmux does, with the history beside a stream that
// redraws, or, in snapshot mode, as a holder does, with one snapshot the stream carries on from:
// everything the terminal printed, replayed, with the queries in it taken out.

import type { ExitStatus, Signal } from "@bazhen/protocol";
import type { TerminalId } from "../ids.ts";
import {
  assertSameGeneration,
  ProcessState,
  RESPAWN_RESET,
  StaleIncarnation,
  type Attached,
  type Snapshot,
  type SnapshotAttached,
  type SnapshotStream,
  type StreamEnd,
  type StreamFailure,
  type Foreground,
  type RuntimeAdapter,
  type TerminalForeground,
  type RuntimeHealth,
  type RuntimeInventoryEntry,
  type RuntimeRef,
  type RuntimeStream,
  type Size,
  type ProcessSpec,
  type TerminalSpec,
} from "../runtime.ts";
import { concat, decode, encode } from "./platform.ts";
import type { ContractHarness } from "./runtime-contract.ts";

/** What reached one terminal from its clients, for a test to assert on. */
export interface ClientRecord {
  /** The size each client asked for, or null for whatever the terminal had. */
  readonly attaches: (Size | null)[];
  readonly written: string[];
  readonly resizes: Size[];
  closes: number;
}

interface Pane {
  readonly id: string;
  readonly pid: number;
  readonly generation: number;
  readonly echo: boolean;
  exit: ExitStatus | null;
  /** A program it started in the foreground, by name; none while it is at its prompt. */
  child?: string;
}

interface Terminal {
  spec: TerminalSpec;
  readonly sessionId: string;
  pane: Pane;
  size: Size;
  history: string;
  /** Everything the terminal has printed, which a snapshot replays. */
  printed: Uint8Array;
  /** How much of it the current process printed: a snapshot's offset. */
  offset: number;
  /** Whether the program is on its alternate screen, as its last switch in its output says. */
  alternate: boolean;
  readonly streams: Set<Client>;
  readonly clients: ClientRecord;
  /** Snapshots a test is holding back, while it holds them. */
  held?: HeldSnapshots;
}

/** Snapshots asked for and not yet taken, and those taken and not yet resolved. */
interface HeldSnapshots {
  asked: ((snapshot: Snapshot) => void)[];
  taken: (() => void)[];
}

/** A test's hold on a terminal's stream snapshots, so it can put output on either side of each. */
export interface SnapshotHold {
  /** How many snapshots have been asked for and not yet taken. */
  asked(): number;
  /** Takes every snapshot asked for so far, as of now; none of them resolves yet. */
  take(): void;
  /** Resolves every snapshot taken, and stops holding them. */
  release(): void;
}

interface Client {
  emit(bytes: Uint8Array): void;
  switched(alternate: boolean): void;
  respawned(generation: number): void;
  fail(failure: StreamFailure): void;
  end(why?: StreamEnd): void;
}

type ExitListener = (ref: RuntimeRef, status: ExitStatus) => void;

export interface FakeRuntimeOptions {
  /** Which `Attached` it returns: tmux's, by default, or a holder's. */
  readonly attach?: Attached["kind"];
}

const EXIT = /(?:^|;)\s*exit (\d+)\s*$/;
const ESC = "\\x1b";
/** Status and device reports, window-size and mode requests, and colour queries. */
const QUERY = new RegExp(
  [
    `${ESC}\\[[?>=]?[0-9;]*[cn]`,
    `${ESC}\\[>[0-9;]*q`,
    `${ESC}\\[\\??[0-9;]*\\$p`,
    `${ESC}\\[1[4-9]t`,
    `${ESC}\\][0-9]+;\\?(?:\\x07|${ESC}\\\\)`,
  ].join("|"),
  "g",
);

/** Where the program is after `text`: on its alternate screen if its last switch went there. */
function screenAfter(text: string, alternate: boolean): boolean {
  let last = -1;
  let on = alternate;
  for (const mode of ["47", "1047", "1049"]) {
    for (const [end, value] of [
      ["h", true],
      ["l", false],
    ] as const) {
      const at = text.lastIndexOf(`\x1b[?${mode}${end}`);
      if (at > last) [last, on] = [at, value];
    }
  }
  return on;
}

export class FakeRuntime implements RuntimeAdapter {
  readonly kind = "fake";
  private readonly terminals = new Map<TerminalId, Terminal>();
  private readonly listeners = new Set<ExitListener>();
  private reachable = true;
  /** The server's start time, as TmuxRuntime records it; empty while no server runs. */
  private serverStart = "";
  private serial = 0;
  private readonly attachKind: Attached["kind"];

  constructor(opts: FakeRuntimeOptions = {}) {
    this.attachKind = opts.attach ?? "history";
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.reachable) return { state: "unreachable", version: null };
    return { state: this.serverStart === "" ? "not-running" : "healthy", version: "fake" };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    this.read();
    // As tmux: with no server running, the socket holds nothing.
    if (this.serverStart === "") return [];
    return [...this.terminals.values()].map((t) => ({
      ref: this.refOf(t),
      tags: t.spec.tags,
      exit: t.pane.exit,
    }));
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    this.read();
    if (this.serverStart === "") this.serverStart = String(1_800_000_000 + ++this.serial);
    const t: Terminal = {
      spec,
      sessionId: `$${++this.serial}`,
      pane: this.pane(spec),
      size: spec.size,
      history: "",
      printed: new Uint8Array(),
      offset: 0,
      alternate: false,
      streams: new Set(),
      clients: { attaches: [], written: [], resizes: [], closes: 0 },
    };
    this.terminals.set(spec.terminalId, t);
    this.reportIfExited(t);
    return this.refOf(t);
  }

  async attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<Attached> {
    const t = this.onServer(ref);
    if (t === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    t.clients.attaches.push(size);
    if (size !== null) t.size = size;
    const data: ((bytes: Uint8Array) => void)[] = [];
    const switches: ((alternate: boolean) => void)[] = [];
    const respawns: ((generation: number) => void)[] = [];
    const failures: ((failure: StreamFailure) => void)[] = [];
    const closed: ((why: StreamEnd) => void)[] = [];
    const snapshots = new Set<(err: Error) => void>();
    let ended: StreamEnd | null = null;
    const end = (why: StreamEnd = "ended") => {
      if (ended !== null) return;
      ended = why;
      t.streams.delete(client);
      for (const reject of snapshots) reject(new Error("the stream closed"));
      snapshots.clear();
      for (const cb of closed) cb(why);
    };
    const client: Client = {
      emit: (bytes) => data.forEach((cb) => cb(bytes)),
      switched: (alternate) => switches.forEach((cb) => cb(alternate)),
      respawned: (generation) => respawns.forEach((cb) => cb(generation)),
      fail: (failure) => failures.forEach((cb) => cb(failure)),
      end,
    };
    t.streams.add(client);
    const stream: RuntimeStream = {
      size: t.size,
      onData: (cb) => void data.push(cb),
      onClose: (cb) => (ended !== null ? cb(ended) : void closed.push(cb)),
      write: (bytes) => {
        t.clients.written.push(decode(bytes));
        if (t.pane.echo && t.pane.exit === null) this.emit(t, bytes);
      },
      resize: async (next) => {
        if (!this.terminals.has(t.spec.terminalId)) throw new Error("the terminal is gone");
        t.clients.resizes.push(next);
        t.size = next;
      },
      onAlternate: (cb) => void switches.push(cb),
      onFailure: (cb) => void failures.push(cb),
      onRespawn: (cb) => void respawns.push(cb),
      close: () => {
        t.clients.closes++;
        end();
      },
    };
    if (this.attachKind === "snapshot") {
      const snapshot = () =>
        new Promise<Snapshot>((resolve, reject) => {
          if (ended !== null) throw new Error("the stream closed");
          snapshots.add(reject);
          const settle = (taken: Snapshot) => {
            if (!snapshots.delete(reject)) return;
            resolve(taken);
          };
          if (t.held === undefined) {
            const taken = this.snapshotOf(t);
            void Promise.resolve().then(() => settle(taken));
          } else t.held.asked.push(settle);
        });
      const snapshotStream: SnapshotStream = { ...stream, snapshot };
      return { ...this.snapshotOf(t), stream: snapshotStream, alternate: t.alternate };
    }
    const lines =
      historyLines > 0 && !t.alternate ? t.history.split("\n").slice(-historyLines).join("\n") : "";
    return { kind: "history", stream, history: lines, alternate: t.alternate };
  }

  /** A fake server that is replaced is gone, so a terminal no server carries is closed. */
  async close(ref: RuntimeRef): Promise<void> {
    this.read();
    if (!this.terminals.has(ref.terminalId)) return;
    const t = this.onServer(ref);
    if (t !== undefined) this.remove(t);
  }

  /** A fake server that is replaced is gone, so only a terminal it carries is not. */
  async gone(ref: RuntimeRef): Promise<boolean> {
    this.read();
    return !this.terminals.has(ref.terminalId);
  }

  /** Ends the server and every terminal on it, as a reboot would; the next create starts another. */
  reboot(): void {
    this.terminals.clear();
    this.serverStart = "";
  }

  async respawn(ref: RuntimeRef, spec: ProcessSpec): Promise<RuntimeRef> {
    const t = this.paneOf(ref);
    if (t.pane.exit === null) throw new ProcessState(ref.terminalId, "exited");
    assertSameGeneration(ref, String(t.pane.generation));
    // A respawn replaces the process; the terminal, its id and tags, stays.
    t.spec = { ...t.spec, ...spec };
    t.pane = { ...this.pane(t.spec), id: t.pane.id };
    t.printed = concat(t.printed, encode(RESPAWN_RESET));
    t.offset = 0;
    if (this.attachKind === "snapshot") {
      for (const client of t.streams) client.respawned(spec.generation);
    }
    if (t.alternate) {
      t.alternate = false;
      for (const client of t.streams) client.switched(false);
    }
    this.reportIfExited(t);
    return this.refOf(t);
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    const t = this.paneOf(ref);
    if (t.pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    assertSameGeneration(ref, String(t.pane.generation));
    t.pane.exit = { type: "signalled", signal };
    this.reportIfExited(t);
  }

  async foreground(ref: RuntimeRef): Promise<Foreground> {
    const t = this.paneOf(ref);
    if (t.pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    const own = t.spec.argv[0].split("/").at(-1) ?? "";
    return { command: t.pane.child ?? own, own: t.pane.child === undefined };
  }

  async unlink(ref: RuntimeRef): Promise<void> {
    const t = this.paneOf(ref);
    if (t.spec.tags.kind === "shell") t.spec = { ...t.spec, tags: { kind: "shell" } };
  }

  /** Reports every terminal already dead on the next turn, as a poll would, then each exit. */
  onExit(cb: ExitListener): () => void {
    this.listeners.add(cb);
    void Promise.resolve().then(() => {
      if (!this.listeners.has(cb) || !this.reachable) return;
      for (const t of this.terminals.values())
        if (t.pane.exit !== null) cb(this.refOf(t), t.pane.exit);
    });
    return () => void this.listeners.delete(cb);
  }

  attachCommand(ref: RuntimeRef): string {
    return `fake-attach ${ref.terminalId}`;
  }

  /** What the terminal was created or last respawned with. */
  specOf(ref: RuntimeRef): TerminalSpec {
    return this.terminalOf(ref).spec;
  }

  /** What reached the terminal from its clients. */
  clients(ref: RuntimeRef): ClientRecord {
    return this.terminalOf(ref).clients;
  }

  /** The terminal's program prints `text`. */
  output(ref: RuntimeRef, text: string): void {
    this.emit(this.terminalOf(ref), encode(text));
  }

  /** The runtime tells the terminal's clients that something failed, as a screen check can. */
  fail(ref: RuntimeRef, failure: StreamFailure): void {
    for (const client of this.terminalOf(ref).streams) client.fail(failure);
  }

  /** Lines that have scrolled off the terminal's screen, oldest first, which attach returns. */
  scroll(ref: RuntimeRef, history: string): void {
    this.terminalOf(ref).history = history;
  }

  async foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]> {
    this.read();
    return [...this.terminals.values()].flatMap((t) => {
      if (t.pane.exit !== null || !terminalIds.has(t.spec.terminalId)) return [];
      const own = t.pane.child === undefined;
      return [
        {
          ref: this.refOf(t),
          command: t.pane.child ?? t.spec.argv[0].split("/").at(-1) ?? "",
          own,
          cwd: t.spec.cwd,
        },
      ];
    });
  }

  /** The terminal's process starts `command` in the foreground, or, given null, gets it back. */
  runInForeground(ref: RuntimeRef, command: string | null): void {
    const { pane } = this.terminalOf(ref);
    if (command === null) delete pane.child;
    else pane.child = command;
  }

  /** The pane's process exits, as a shell does on `exit`. */
  exitProcess(ref: RuntimeRef, status: ExitStatus = { type: "exited", code: 0 }): void {
    const t = this.terminalOf(ref);
    t.pane.exit = status;
    this.reportIfExited(t);
  }

  /** The process is replaced outside Bazhen, as a split and a kill by hand would replace a pane. */
  replaceProcess(ref: RuntimeRef): void {
    const t = this.terminalOf(ref);
    t.pane = { ...this.pane(t.spec), generation: t.pane.generation };
  }

  /** The terminal ends outside Bazhen, as a killed session would; every client closes. */
  vanish(ref: RuntimeRef): void {
    this.remove(this.terminalOf(ref));
  }

  /**
   * Holds the terminal's stream snapshots: each is taken only at `take`, and resolves only at
   * `release`, so a test can put output before and after the point it is taken at.
   */
  holdSnapshots(ref: RuntimeRef): SnapshotHold {
    const t = this.terminalOf(ref);
    const held: HeldSnapshots = { asked: [], taken: [] };
    t.held = held;
    return {
      asked: () => held.asked.length,
      take: () => {
        const snapshot = this.snapshotOf(t);
        for (const settle of held.asked.splice(0)) held.taken.push(() => settle(snapshot));
      },
      release: () => {
        if (t.held === held) delete t.held;
        for (const resolve of held.taken.splice(0)) resolve();
      },
    };
  }

  /** The terminal's snapshot clients fall too far behind its output, and their streams close. */
  fallBehind(ref: RuntimeRef): void {
    if (this.attachKind !== "snapshot") throw new Error("only a snapshot client falls behind");
    for (const client of this.terminalOf(ref).streams) client.end("behind");
  }

  /** The server stays up but can no longer be read, as a socket Bazhen can't open. */
  disconnect(): void {
    this.reachable = false;
  }

  /** A terminal goes, and with the last one the server, as tmux's does. */
  private remove(t: Terminal): void {
    this.terminals.delete(t.spec.terminalId);
    for (const client of t.streams) client.end();
    if (this.terminals.size === 0) this.serverStart = "";
  }

  private pane(spec: ProcessSpec): Pane {
    const [program, flag, script] = spec.argv;
    const code = program === "sh" && flag === "-c" ? EXIT.exec(script ?? "")?.[1] : undefined;
    return {
      id: `%${++this.serial}`,
      pid: 10_000 + this.serial,
      generation: spec.generation,
      echo: program === "cat",
      exit: code === undefined ? null : { type: "exited", code: Number(code) },
    };
  }

  private refOf(t: Terminal): RuntimeRef {
    return {
      terminalId: t.spec.terminalId,
      runtime: this.kind,
      locator: {
        session: `bz-${t.spec.terminalId.slice(-12)}`,
        serverPid: "1",
        serverStart: this.serverStart,
        sessionId: t.sessionId,
        paneId: t.pane.id,
        panePid: String(t.pane.pid),
        generation: String(t.pane.generation),
      },
    };
  }

  private emit(t: Terminal, bytes: Uint8Array): void {
    t.printed = concat(t.printed, bytes);
    t.offset += bytes.length;
    const was = t.alternate;
    t.alternate = screenAfter(decode(bytes), was);
    for (const client of t.streams) client.emit(bytes);
    if (t.alternate !== was) for (const client of t.streams) client.switched(t.alternate);
  }

  /** The history scrolled above a clear screen, then everything printed since from its top. */
  private snapshotOf(t: Terminal): Omit<SnapshotAttached, "stream" | "alternate"> {
    const above = `${"\r\n".repeat(t.size.rows)}\x1b[0m\x1b[H`;
    const history = t.history === "" ? "" : `${t.history.replaceAll("\n", "\r\n")}${above}`;
    return {
      kind: "snapshot",
      vt: encode(history + decode(t.printed).replaceAll(QUERY, "")),
      offset: t.offset,
      generation: t.pane.generation,
    };
  }

  private reportIfExited(t: Terminal): void {
    const status = t.pane.exit;
    if (status === null || !this.reachable) return;
    for (const cb of this.listeners) cb(this.refOf(t), status);
  }

  private read(): void {
    if (!this.reachable) throw new Error("the fake runtime's server can't be read");
  }

  /** Throws as tmux does when no server runs: nothing is there to read. */
  private server(): void {
    if (this.serverStart === "") throw new Error("no server running");
  }

  private terminalOf(ref: RuntimeRef): Terminal {
    const t = this.terminals.get(ref.terminalId);
    if (t === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    return t;
  }

  /** As TmuxRuntime's: the terminal, from the server `ref` was made on, or undefined if gone. */
  private onServer(ref: RuntimeRef): Terminal | undefined {
    this.read();
    this.server();
    if (ref.locator.serverStart !== this.serverStart || ref.locator.serverPid !== "1") {
      throw new StaleIncarnation(ref.terminalId, "server-replaced");
    }
    return this.terminals.get(ref.terminalId);
  }

  private paneOf(ref: RuntimeRef): Terminal {
    const t = this.onServer(ref);
    if (t === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    if (t.pane.id !== ref.locator.paneId)
      throw new StaleIncarnation(ref.terminalId, "pane-replaced");
    return t;
  }
}

const fakeOf = (runtime: unknown) => {
  if (!(runtime instanceof FakeRuntime)) throw new Error("not the fake runtime");
  return runtime;
};

/** The contract's harness for a FakeRuntime attaching as `attach` says. */
export function fakeContractHarness(attach: Attached["kind"]): ContractHarness {
  return {
    make: () => ({ runtime: new FakeRuntime({ attach }), dispose: () => {} }),
    unreadable: (runtime) => fakeOf(runtime).disconnect(),
    replaceProcess: (runtime, ref) => fakeOf(runtime).replaceProcess(ref),
    vanish: (runtime, ref) => fakeOf(runtime).vanish(ref),
    reboot: (runtime) => fakeOf(runtime).reboot(),
    forge: (ref) => ({ ...ref, locator: { ...ref.locator, serverStart: "1" } }),
    placeOf: (ref) => ref.locator.paneId,
    exitMayBeUnknown: false,
    cwd: "/w",
    waitMs: 1_000,
  };
}
