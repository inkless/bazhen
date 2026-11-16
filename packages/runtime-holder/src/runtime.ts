import { readdir, readlink, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  assertSameGeneration,
  ExitWatch,
  ProcessState,
  shellCommand,
  StaleIncarnation,
  TerminalUnconfirmed,
  type DeadTerminal,
  type Foreground,
  type ProcessSpec,
  type RuntimeAdapter,
  type RuntimeHealth,
  type RuntimeInventoryEntry,
  type RuntimeRef,
  type Size,
  type SnapshotAttached,
  isId,
  type TerminalForeground,
  type TerminalId,
  type TerminalSpec,
} from "@bazhen/core";
import {
  type HolderProcess,
  holderSocket,
  holderSocketRefusal,
  holdersDir,
  readProcess,
  rebindHolderSocket,
  START_SKEW_S,
  startHolder,
  type StartedHolder,
  type StartHolderOptions,
  vouchHolder,
} from "@bazhen/host-guard";
import {
  HOLDER_PROTOCOL_VERSION,
  type ExitStatus,
  type HolderHelloReply,
  type HolderProcessSpec,
  type Signal,
} from "@bazhen/protocol";
import {
  connectHolder,
  HolderDisconnected,
  HolderRequestError,
  type HolderClient,
  type HolderEvent,
} from "./client.ts";
import { Control, HolderStream } from "./runtime-stream.ts";
import { decodeTags, encodeTags, unlinked } from "./tags.ts";

const EXIT_POLL_MS = 1_000;
/** How long a holder has to answer `hello` before it counts as one that can't be read. */
const HELLO_MS = 2_000;
const DEFAULT_COLORTERM = "truecolor";
const ignore = () => {};

export interface HolderRuntimeOptions {
  /** The daemon's private run directory: holders bind in its `holders` directory. */
  readonly root: string;
  /** The `bazhen-holder` binary every new terminal's holder runs. */
  readonly binary: string;
  /** The environment every new terminal starts from, already filtered (foundation-design §9.5). */
  readonly env: Readonly<Record<string, string>>;
  /** How often dead terminals are looked for while anyone listens. */
  readonly exitPollMs?: number;
  /** How long a holder has to answer `hello`. */
  readonly helloMs?: number;
  /** Where a failure no caller waits on goes: exit polling, or a holder that can't be read. */
  readonly onError?: (err: unknown) => void;
  /** Starts a holder: host-guard's `startHolder`, unless a test records what it starts. */
  readonly start?: (options: StartHolderOptions) => Promise<StartedHolder>;
}

/** What saying `hello` at a socket found. */
type Reached =
  | { readonly is: "holder"; readonly hello: HolderHelloReply }
  /** No holder listens there: no file, or one a holder that died left behind. */
  | { readonly is: "none"; readonly stale: boolean; readonly cause: unknown }
  /** Something may listen there, but couldn't be read: refused access, or no answer in time. */
  | { readonly is: "unreadable"; readonly cause: unknown };

const codeOf = (error: unknown) =>
  error instanceof HolderDisconnected && error.cause instanceof Error && "code" in error.cause
    ? error.cause.code
    : undefined;

function reachedBy(error: unknown): Exclude<Reached, { is: "holder" }> {
  const code = codeOf(error);
  if (code === "ENOENT") return { is: "none", stale: false, cause: error };
  if (code === "ECONNREFUSED") return { is: "none", stale: true, cause: error };
  return { is: "unreadable", cause: error };
}

/** The holder a ref recorded, or null for a ref that names none. */
function recordedHolder(ref: RuntimeRef): HolderProcess | null {
  const pid = Number(ref.locator.holderPid);
  const start = Number(ref.locator.holderStart);
  return Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(start)
    ? { pid, start }
    : null;
}

/**
 * Runs each terminal in a `bazhen-holder` of its own, found again by its socket in the run
 * directory, whatever happened to the daemon in between (design §5).
 */
export class HolderRuntime implements RuntimeAdapter {
  readonly kind = "holder";
  private readonly opts: HolderRuntimeOptions;
  private env: Readonly<Record<string, string>>;
  private readonly exits: ExitWatch;
  private readonly controls = new Map<string, Control>();

  constructor(opts: HolderRuntimeOptions) {
    this.opts = opts;
    this.env = opts.env;
    this.exits = new ExitWatch({
      read: () => this.deadTerminals(),
      intervalMs: opts.exitPollMs ?? EXIT_POLL_MS,
      onError: this.report,
    });
  }

  private readonly report = (err: unknown) =>
    (this.opts.onError ?? ((e: unknown) => console.warn("holder runtime:", e)))(err);

  /** Replaces the environment new terminals start from; running ones keep theirs (§5.5). */
  replaceEnv(env: Readonly<Record<string, string>>): void {
    this.env = env;
  }

  private socketOf(terminalId: string): string {
    const socket = holderSocket(this.opts.root, terminalId);
    const refused = holderSocketRefusal(socket, this.opts.root, terminalId);
    if (refused !== undefined) throw new RangeError(`terminal ${terminalId}: ${refused}`);
    return socket;
  }

  private connect(socket: string, writer: boolean, onEvent: (event: HolderEvent) => void) {
    const signal = AbortSignal.timeout(this.opts.helloMs ?? HELLO_MS);
    return connectHolder(socket, { writer, onEvent, signal });
  }

  /** Says `hello` at `socket` and hangs up. */
  private async reach(socket: string): Promise<Reached> {
    try {
      const client = await this.connect(socket, false, ignore);
      client.end();
      return { is: "holder", hello: client.hello };
    } catch (error) {
      return reachedBy(error);
    }
  }

  private refOf(terminalId: TerminalId, hello: HolderHelloReply): RuntimeRef {
    return {
      terminalId,
      runtime: this.kind,
      locator: {
        socket: this.socketOf(terminalId),
        holderPid: String(hello.holderPid),
        holderStart: String(hello.holderStart),
        childPid: String(hello.childPid),
        childStart: String(hello.childStart),
        generation: String(hello.generation),
      },
    };
  }

  /**
   * A connection to the holder `ref` was made on, past `hello`. A holder that isn't there is
   * `StaleIncarnation("gone")` once it is provably gone, and `TerminalUnconfirmed` until then; a
   * different holder at its socket is `server-replaced`.
   */
  private async holderOf(
    ref: RuntimeRef,
    onEvent: (event: HolderEvent) => void = ignore,
  ): Promise<HolderClient> {
    let client: HolderClient;
    try {
      client = await this.connect(this.socketOf(ref.terminalId), false, onEvent);
    } catch (error) {
      const reached = reachedBy(error);
      if (reached.is === "none" && (await this.gone(ref))) {
        throw new StaleIncarnation(ref.terminalId, "gone");
      }
      throw new TerminalUnconfirmed(ref.terminalId, error);
    }
    const { hello } = client;
    if (
      hello.terminalId !== ref.terminalId ||
      String(hello.holderPid) !== ref.locator.holderPid ||
      String(hello.holderStart) !== ref.locator.holderStart
    ) {
      client.end();
      throw new StaleIncarnation(ref.terminalId, "server-replaced");
    }
    return client;
  }

  /** `holderOf`, then the process `ref` recorded: the same generation and the same child. */
  private async processOf(ref: RuntimeRef, onEvent?: (event: HolderEvent) => void) {
    const client = await this.holderOf(ref, onEvent);
    const { hello } = client;
    try {
      assertSameGeneration(ref, String(hello.generation));
      if (
        String(hello.childPid) !== ref.locator.childPid ||
        String(hello.childStart) !== ref.locator.childStart
      ) {
        throw new StaleIncarnation(ref.terminalId, "process-replaced");
      }
    } catch (error) {
      client.end();
      throw error;
    }
    return client;
  }

  /** Runs `act` on a connection to `ref`'s process, then hangs up. */
  private async withProcess<T>(
    ref: RuntimeRef,
    act: (client: HolderClient) => Promise<T>,
    onEvent?: (event: HolderEvent) => void,
  ): Promise<T> {
    const client = await this.processOf(ref, onEvent);
    try {
      return await act(client);
    } finally {
      client.end();
    }
  }

  /**
   * `unreachable` while a holder can't be read, or while one a ref recorded still runs with its
   * socket gone, which is then told to bind it again (§5.4). `not-running` only when no holder
   * answers and none recorded still runs.
   */
  async health(recorded: readonly RuntimeRef[] = []): Promise<RuntimeHealth> {
    const version = `holder/${HOLDER_PROTOCOL_VERSION}`;
    let reached: Reached[];
    try {
      reached = await this.reachAll();
    } catch {
      return { state: "unreachable", version };
    }
    if (reached.some((r) => r.is === "unreadable")) return { state: "unreachable", version };
    const answering = new Set(
      reached.flatMap((r) => (r.is === "holder" ? [r.hello.terminalId] : [])),
    );
    let socketless = false;
    for (const ref of recorded) {
      if (answering.has(ref.terminalId)) continue;
      const holder = recordedHolder(ref);
      if (holder !== null && (await rebindHolderSocket(holder))) socketless = true;
    }
    if (socketless) return { state: "unreachable", version };
    return { state: answering.size > 0 ? "healthy" : "not-running", version };
  }

  /** `hello` to every socket in the holders' directory; one that can't be listed throws. */
  private async reachAll(): Promise<(Reached & { readonly socket: string })[]> {
    const dir = holdersDir(this.opts.root);
    const names = await readdir(dir).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const sockets = names.filter((name) => name.endsWith(".sock")).map((name) => join(dir, name));
    return Promise.all(sockets.map(async (socket) => ({ ...(await this.reach(socket)), socket })));
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    return (await this.reachAll()).flatMap((reached) => {
      if (reached.is === "unreadable") {
        this.report(
          new Error(`the holder at ${reached.socket} can't be read`, { cause: reached.cause }),
        );
        return [];
      }
      if (reached.is !== "holder") return [];
      const { hello } = reached;
      const { terminalId } = hello;
      const tags = decodeTags(hello.tags);
      // A holder answers at its own terminal's socket only; anything else isn't one of ours.
      if (tags === null || !isId("term", terminalId)) return [];
      if (basename(reached.socket) !== `${terminalId}.sock`) return [];
      return [{ ref: this.refOf(terminalId, hello), tags, exit: hello.exit }];
    });
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const socket = this.socketOf(spec.terminalId);
    const holderSpec = {
      protocol: [HOLDER_PROTOCOL_VERSION],
      terminalId: spec.terminalId,
      socket,
      tags: encodeTags(spec.tags),
      size: spec.size,
      ...this.processSpec(spec),
    };
    const start = this.opts.start ?? startHolder;
    await start({ binary: this.opts.binary, root: this.opts.root, spec: holderSpec, env: {} });
    const reached = await this.reach(socket);
    if (reached.is !== "holder") {
      throw new Error(`terminal ${spec.terminalId}: its holder started but doesn't answer`, {
        cause: reached.cause,
      });
    }
    return this.refOf(spec.terminalId, reached.hello);
  }

  /** What the holder runs: the runtime's environment, then the terminal's own variables. */
  private processSpec(spec: ProcessSpec): HolderProcessSpec {
    return {
      argv: [...spec.argv],
      cwd: spec.cwd,
      env: {
        ...this.env,
        ...spec.env,
        TERM: "xterm-256color",
        COLORTERM: spec.env["COLORTERM"] ?? DEFAULT_COLORTERM,
      },
      generation: spec.generation,
      ...(spec.theme === undefined ? {} : { theme: spec.theme }),
    };
  }

  async attach(
    ref: RuntimeRef,
    size: Size | null,
    _historyLines: number,
  ): Promise<SnapshotAttached> {
    let control = this.controls.get(ref.terminalId);
    if (control === undefined) {
      const socket = this.socketOf(ref.terminalId);
      control = new Control((writer, onEvent) => this.connect(socket, writer, onEvent));
      this.controls.set(ref.terminalId, control);
    }
    const stream = new HolderStream(control, size ?? { cols: 80, rows: 24 });
    try {
      const reader = await this.holderOf(ref, (event) => stream.event(event));
      if (size === null) stream.size = reader.hello.size;
      else await stream.resize(size);
      return await stream.attach(reader);
    } catch (error) {
      stream.close();
      throw error;
    }
  }

  /**
   * Closes the terminal: its holder ends its session and exits. One no holder answers for counts
   * as closed once it is provably gone, its stale socket removed; otherwise it is unconfirmed.
   */
  async close(ref: RuntimeRef): Promise<void> {
    let client: HolderClient;
    try {
      client = await this.holderOf(ref);
    } catch (error) {
      if (!(error instanceof StaleIncarnation && error.reason === "gone")) throw error;
      this.forget(ref.terminalId);
      const reached = await this.reach(this.socketOf(ref.terminalId));
      if (reached.is === "none" && reached.stale) {
        await rm(this.socketOf(ref.terminalId), { force: true });
      }
      return;
    }
    try {
      await client.close();
      await client.ended;
    } finally {
      client.end();
      this.forget(ref.terminalId);
    }
  }

  private forget(terminalId: string): void {
    this.controls.get(terminalId)?.end();
    this.controls.delete(terminalId);
  }

  /**
   * No holder answers at the terminal's socket, and the holder `ref` recorded is no longer the
   * process at its pid. One that can't be read, or still runs, is no proof.
   */
  async gone(ref: RuntimeRef): Promise<boolean> {
    const reached = await this.reach(this.socketOf(ref.terminalId));
    if (reached.is !== "none") return false;
    const holder = recordedHolder(ref);
    return holder === null || (await vouchHolder(holder)) === null;
  }

  async respawn(ref: RuntimeRef, spec: ProcessSpec): Promise<RuntimeRef> {
    let respawned: { childPid: number; childStart: number; generation: number } | null = null;
    return this.withProcess(
      ref,
      async (client) => {
        if (client.hello.exit === null) throw new ProcessState(ref.terminalId, "exited");
        try {
          await client.respawn(this.processSpec(spec));
        } catch (error) {
          throw refusal(ref, error);
        }
        if (respawned === null)
          throw new Error(`terminal ${ref.terminalId}: respawned unannounced`);
        const { childPid, childStart, generation } = respawned;
        return {
          ...ref,
          locator: {
            ...ref.locator,
            childPid: String(childPid),
            childStart: String(childStart),
            generation: String(generation),
          },
        };
      },
      (event) => {
        if (event.type === "respawned") respawned = event.body;
      },
    );
  }

  /**
   * What holds the terminal's foreground, from its PTY: the holder names the group, `ps` its
   * leader's command, checked against the start the holder read so a reused pid is refused.
   */
  async foreground(ref: RuntimeRef): Promise<Foreground> {
    const read = await this.withProcess(ref, async (client) => {
      if (client.hello.exit !== null) throw new ProcessState(ref.terminalId, "running");
      return client.foreground().catch((error: unknown) => {
        throw refusal(ref, error);
      });
    });
    const command = await commandOf(read.pgid, read.pgidStart);
    if (command === null) throw new Error(`can't read terminal ${ref.terminalId}'s foreground`);
    return { command, own: read.pgid === read.childPid };
  }

  async foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]> {
    if (terminalIds.size === 0) return [];
    const live = (await this.inventory()).filter(
      (e) => e.exit === null && terminalIds.has(e.ref.terminalId),
    );
    const read = await Promise.all(
      live.map(async ({ ref }) => {
        try {
          const foreground = await this.foreground(ref);
          const cwd = await readlink(`/proc/${ref.locator.childPid}/cwd`).catch(() => null);
          return [{ ref, ...foreground, cwd }];
        } catch {
          return [];
        }
      }),
    );
    return read.flat();
  }

  async unlink(ref: RuntimeRef): Promise<void> {
    const client = await this.holderOf(ref);
    try {
      await client.setTags(unlinked(client.hello.tags));
    } finally {
      client.end();
    }
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    await this.withProcess(ref, async (client) => {
      if (client.hello.exit !== null) throw new ProcessState(ref.terminalId, "running");
      await client.signal(signal).catch((error: unknown) => {
        throw refusal(ref, error);
      });
    });
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.exits.subscribe(cb);
  }

  attachCommand(ref: RuntimeRef): string {
    return shellCommand(["bazhen", "attach", ref.terminalId]);
  }

  private async deadTerminals(): Promise<DeadTerminal[]> {
    return (await this.inventory()).flatMap((e) =>
      e.exit === null ? [] : [{ ref: e.ref, status: e.exit }],
    );
  }
}

/** A holder's refusal as the contract names it: the process isn't in the state asked for. */
function refusal(ref: RuntimeRef, error: unknown): unknown {
  if (!(error instanceof HolderRequestError)) return error;
  if (error.rawCode === "exited") return new ProcessState(ref.terminalId, "running");
  if (error.rawCode === "running") return new ProcessState(ref.terminalId, "exited");
  if (error.code === "stale-generation")
    return new StaleIncarnation(ref.terminalId, "process-replaced");
  return error;
}

/** The command of the process leading group `pgid`, if it is still the one that started at `start`. */
async function commandOf(pgid: number, start: number): Promise<string | null> {
  const reading = await readProcess(pgid);
  if (typeof reading === "string" || Math.abs(reading.start - start) > START_SKEW_S) return null;
  return basename(reading.comm);
}
