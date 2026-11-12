// An in-memory RuntimeAdapter, for tests that must not run tmux. It keeps TmuxRuntime's contract:
// runtime-contract.ts runs one suite against both, so what a test proves against this runtime
// holds against tmux. A program's argv decides what it does: `sh -c '… exit N'` exits with N at
// once, `cat` echoes what it is sent, and anything else runs until it is signalled.

import type { ExitStatus, Signal } from "@bazhen/protocol";
import type { TerminalId } from "../ids.ts";
import {
  ProcessState,
  StaleIncarnation,
  type Attached,
  type RuntimeAdapter,
  type RuntimeHealth,
  type RuntimeInventoryEntry,
  type RuntimeRef,
  type RuntimeStream,
  type Size,
  type TerminalSpec,
} from "../runtime.ts";
import { decode, encode } from "./platform.ts";

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
}

interface Terminal {
  spec: TerminalSpec;
  readonly sessionId: string;
  pane: Pane;
  size: Size;
  history: string;
  readonly streams: Set<{ emit(bytes: Uint8Array): void; end(): void }>;
  readonly clients: ClientRecord;
}

type ExitListener = (ref: RuntimeRef, status: ExitStatus) => void;

const EXIT = /(?:^|;)\s*exit (\d+)\s*$/;

export class FakeRuntime implements RuntimeAdapter {
  readonly kind = "fake";
  private readonly terminals = new Map<TerminalId, Terminal>();
  private readonly listeners = new Set<ExitListener>();
  private readonly reachable: boolean;
  /** The server's start time, as TmuxRuntime records it; empty while no server runs. */
  private serverStart = "";
  private serial = 0;

  constructor(opts: { readonly reachable?: boolean } = {}) {
    this.reachable = opts.reachable ?? true;
  }

  async health(): Promise<RuntimeHealth> {
    if (!this.reachable) return { state: "unreachable", version: null };
    return { state: this.serverStart === "" ? "not-running" : "healthy", version: "fake" };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    this.read();
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
      streams: new Set(),
      clients: { attaches: [], written: [], resizes: [], closes: 0 },
    };
    this.terminals.set(spec.terminalId, t);
    this.reportIfExited(t);
    return this.refOf(t);
  }

  async attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<Attached> {
    const t = this.terminalOf(ref);
    t.clients.attaches.push(size);
    if (size !== null) t.size = size;
    const data: ((bytes: Uint8Array) => void)[] = [];
    const closed: (() => void)[] = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      t.streams.delete(client);
      for (const cb of closed) cb();
    };
    const client = { emit: (bytes: Uint8Array) => data.forEach((cb) => cb(bytes)), end };
    t.streams.add(client);
    const stream: RuntimeStream = {
      size: t.size,
      onData: (cb) => void data.push(cb),
      onClose: (cb) => (ended ? cb() : void closed.push(cb)),
      write: (bytes) => {
        t.clients.written.push(decode(bytes));
        if (t.pane.echo && t.pane.exit === null) this.emit(t, bytes);
      },
      resize: async (next) => {
        if (!this.terminals.has(t.spec.terminalId)) throw new Error("the terminal is gone");
        t.clients.resizes.push(next);
        t.size = next;
      },
      close: () => {
        t.clients.closes++;
        end();
      },
    };
    const lines = historyLines > 0 ? t.history.split("\n").slice(-historyLines).join("\n") : "";
    return { stream, history: lines };
  }

  async close(ref: RuntimeRef): Promise<void> {
    const t = this.onServer(ref);
    if (t !== undefined) this.vanish(this.refOf(t));
  }

  async respawn(ref: RuntimeRef, spec: TerminalSpec): Promise<RuntimeRef> {
    const t = this.paneOf(ref);
    if (t.pane.exit === null) throw new ProcessState(ref.terminalId, "exited");
    assertSameGeneration(ref, t.pane);
    t.spec = spec;
    t.pane = { ...this.pane(spec), id: t.pane.id };
    this.reportIfExited(t);
    return this.refOf(t);
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    const t = this.paneOf(ref);
    if (t.pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    assertSameGeneration(ref, t.pane);
    this.exit(this.refOf(t), { type: "signalled", signal });
  }

  /** Reports every terminal already dead at once, as a poll would, then each exit as it happens. */
  onExit(cb: ExitListener): () => void {
    this.listeners.add(cb);
    if (this.reachable) {
      for (const t of this.terminals.values())
        if (t.pane.exit !== null) cb(this.refOf(t), t.pane.exit);
    }
    return () => void this.listeners.delete(cb);
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

  /** Lines that have scrolled off the terminal's screen, oldest first, which attach returns. */
  scroll(ref: RuntimeRef, history: string): void {
    this.terminalOf(ref).history = history;
  }

  /** The terminal's process ends, however it was asked to. */
  exit(ref: RuntimeRef, status: ExitStatus): void {
    const t = this.terminalOf(ref);
    t.pane.exit = status;
    this.reportIfExited(t);
  }

  /** The pane is replaced inside the terminal, as a split and a kill by hand would. */
  replacePane(ref: RuntimeRef): void {
    const t = this.terminalOf(ref);
    t.pane = { ...this.pane(t.spec), generation: t.pane.generation };
  }

  /** The terminal ends outside Bazhen, as a killed session would; every client closes. */
  vanish(ref: RuntimeRef): void {
    const t = this.terminalOf(ref);
    this.terminals.delete(t.spec.terminalId);
    for (const client of t.streams) client.end();
  }

  private pane(spec: TerminalSpec): Pane {
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
    for (const client of t.streams) client.emit(bytes);
  }

  private reportIfExited(t: Terminal): void {
    const status = t.pane.exit;
    if (status === null || !this.reachable) return;
    for (const cb of this.listeners) cb(this.refOf(t), status);
  }

  private read(): void {
    if (!this.reachable) throw new Error("the fake runtime is unreachable");
  }

  private terminalOf(ref: RuntimeRef): Terminal {
    const t = this.terminals.get(ref.terminalId);
    if (t === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    return t;
  }

  /** As TmuxRuntime's: the terminal, from the server `ref` was made on, or undefined if gone. */
  private onServer(ref: RuntimeRef): Terminal | undefined {
    this.read();
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

function assertSameGeneration(ref: RuntimeRef, now: Pane): void {
  const recorded = ref.locator.generation;
  if (!recorded) throw new StaleIncarnation(ref.terminalId, "unnumbered");
  if (recorded !== String(now.generation)) {
    throw new StaleIncarnation(ref.terminalId, "process-replaced");
  }
}
