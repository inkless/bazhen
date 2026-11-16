import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  assertSameGeneration,
  ExitWatch,
  ProcessState,
  shellCommand,
  StaleIncarnation,
  TerminalUnconfirmed,
  TerminalUnservable,
  type Compatibility,
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
  type Containment,
  type HolderProcess,
  holderBuildOf,
  holderSocket,
  holderSocketRefusal,
  holdersDir,
  inTerminalScope,
  PasteRefused,
  pasteTextRefusal,
  processCommands,
  type ProcessCommand,
  processCwds,
  readProcess,
  rebindHolderSocket,
  START_SKEW_S,
  startHolder,
  type StartedHolder,
  type StartHolderOptions,
  terminalScope,
  vouchHolder,
} from "@bazhen/host-guard";
import {
  HOLDER_PROTOCOL_VERSION,
  isOlderHolderMajor,
  type ExitStatus,
  type HolderHelloReply,
  type HolderProcessSpec,
  type HolderStats,
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
import { TitleWatch } from "./title-watch.ts";

const EXIT_POLL_MS = 1_000;
const TITLE_SYNC_MS = 5_000;
/** How long a holder has to answer `hello` before it counts as one that can't be read. */
const HELLO_MS = 2_000;
const DEFAULT_COLORTERM = "truecolor";
const ignore = () => {};

export interface HolderRuntimeOptions {
  /** The daemon's private run directory: holders bind in its `holders` directory. */
  readonly root: string;
  /**
   * The `bazhen-holder` binary every new terminal's holder runs. Null when none is installed: the
   * holders already running are still found and served, and only a new terminal is refused.
   */
  readonly binary: string | null;
  /** Why there is no binary, which a refused new terminal says. */
  readonly unavailable?: string;
  /** Where holder builds are installed, each in a directory named by its build. */
  readonly installDir?: string;
  /** The environment every new terminal starts from, already filtered (foundation-design §9.5). */
  readonly env: Readonly<Record<string, string>>;
  /** How often dead terminals are looked for while anyone listens. */
  readonly exitPollMs?: number;
  /** How often, while titles are listened to, agents' holders are listed for any not watched. */
  readonly titleSyncMs?: number;
  /** How long a holder has to answer `hello`. */
  readonly helloMs?: number;
  /** Where a failure no caller waits on goes: exit polling, or a holder that can't be read. */
  readonly onError?: (err: unknown) => void;
  /** Starts a holder: host-guard's `startHolder`, unless a test records what it starts. */
  readonly start?: (options: StartHolderOptions) => Promise<StartedHolder>;
  /**
   * Whether each new terminal's holder starts in a scope of its own, asked before every start and
   * decided once by the caller. Without it, holders start where the daemon runs.
   */
  readonly containment?: () => Promise<Containment>;
  /** Whether a holder's pid runs in a terminal's scope: host-guard's, unless a test says. */
  readonly inScope?: (pid: number) => boolean | null;
  /** Reads processes' starts and commands: host-guard's `processCommands`, unless a test says. */
  readonly commands?: (
    pids: readonly number[],
  ) => Promise<ReadonlyMap<number, ProcessCommand> | "unreadable">;
}

/** A holder that answered, the build it runs and the protocol versions it speaks. */
export interface HolderBuild {
  readonly terminalId: string;
  /** Null for a holder not run from an install, or that `ps` no longer shows. */
  readonly build: string | null;
  readonly protocol: readonly string[];
  /** Whether it runs in a terminal's scope; null where that can't be read. */
  readonly contained: boolean | null;
  readonly socket: string;
  /** Null for a holder that shares no protocol with this build, which names no pid. */
  readonly holderPid: number | null;
  /** Its memory, as it reports it; null where it didn't. */
  readonly stats: HolderStats | null;
}

/** What saying `hello` at a socket found. */
type Reached =
  | {
      readonly is: "holder";
      readonly hello: HolderHelloReply;
      /** Its memory, when the caller asked for it and the holder said. */
      readonly stats: HolderStats | null;
    }
  /** No holder listens there: no file, or one a holder that died left behind. */
  | { readonly is: "none"; readonly stale: boolean; readonly cause: unknown }
  /** Something may listen there, but couldn't be read: refused access, or no answer in time. */
  | { readonly is: "unreadable"; readonly cause: unknown }
  /**
   * A holder answers there, but shares no protocol major with this build: it runs, and can't be
   * spoken to, so it is never called gone and never signalled.
   */
  | { readonly is: "outdated"; readonly protocol: readonly string[] };

const codeOf = (error: unknown) =>
  error instanceof HolderDisconnected && error.cause instanceof Error && "code" in error.cause
    ? error.cause.code
    : undefined;

function reachedBy(error: unknown): Exclude<Reached, { is: "holder" }> {
  if (error instanceof HolderRequestError && error.code === "no-shared-version")
    return { is: "outdated", protocol: error.protocol ?? [] };
  const code = codeOf(error);
  if (code === "ENOENT") return { is: "none", stale: false, cause: error };
  if (code === "ECONNREFUSED") return { is: "none", stale: true, cause: error };
  return { is: "unreadable", cause: error };
}

/** The terminal whose holder binds `socket`, by its name; null for one no holder of ours binds. */
function terminalAt(socket: string): TerminalId | null {
  const name = basename(socket, ".sock");
  return isId("term", name) ? name : null;
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
  private readonly titles: TitleWatch;
  private readonly controls = new Map<string, Control>();
  /** For each terminal, what settles once its last control connection has closed. */
  private readonly retiring = new Map<string, Promise<void>>();
  /** The sockets reported unreadable, each reported again only once it has been readable. */
  private readonly unreadable = new Set<string>();

  constructor(opts: HolderRuntimeOptions) {
    this.opts = opts;
    this.env = opts.env;
    this.exits = new ExitWatch({
      read: () => this.deadTerminals(),
      intervalMs: opts.exitPollMs ?? EXIT_POLL_MS,
      onError: this.report,
    });
    this.titles = new TitleWatch({
      list: async () =>
        (await this.listed()).entries.flatMap(({ ref, tags }) =>
          tags.kind === "agent" ? [this.watched(ref)] : [],
        ),
      connect: (socket, onEvent) => this.connect(socket, false, onEvent),
      syncMs: opts.titleSyncMs ?? TITLE_SYNC_MS,
      onError: this.report,
    });
  }

  private readonly commands = (pids: readonly number[]) =>
    (this.opts.commands ?? processCommands)(pids);

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

  /** Says `hello` at `socket`, asks for its `stats` too `withStats`, and hangs up. */
  private async reach(socket: string, withStats = false): Promise<Reached> {
    let client: HolderClient;
    try {
      client = await this.connect(socket, false, ignore);
    } catch (error) {
      return reachedBy(error);
    }
    try {
      const signal = AbortSignal.timeout(this.opts.helloMs ?? HELLO_MS);
      // A holder that won't say still answered: it is listed, without its memory.
      const stats = withStats ? await client.stats({ signal }).catch(() => null) : null;
      return { is: "holder", hello: client.hello, stats };
    } finally {
      client.end();
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
      if (reached.is === "outdated") {
        const pid = recordedHolder(ref)?.pid ?? null;
        throw new TerminalUnservable(ref.terminalId, reached.protocol, pid);
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
    let reached: (Reached & { readonly socket: string })[];
    try {
      reached = await this.reachAll();
    } catch {
      return { state: "unreachable", version };
    }
    if (reached.some((r) => r.is === "unreadable")) return { state: "unreachable", version };
    // One that can't be spoken to still runs, so it is never told to rebind.
    const answering = new Set(
      reached.flatMap((r) => {
        if (r.is === "holder") return [r.hello.terminalId];
        const at = r.is === "outdated" ? terminalAt(r.socket) : null;
        return at === null ? [] : [at];
      }),
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

  /**
   * `hello` to every socket in the holders' directory, and `stats` too `withStats`; one that
   * can't be listed throws.
   */
  private async reachAll(withStats = false): Promise<(Reached & { readonly socket: string })[]> {
    const dir = holdersDir(this.opts.root);
    const names = await readdir(dir).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const sockets = names.filter((name) => name.endsWith(".sock")).map((name) => join(dir, name));
    return Promise.all(
      sockets.map(async (socket) => ({ ...(await this.reach(socket, withStats)), socket })),
    );
  }

  /**
   * Each holder that answers, with the build it runs, as its argv[0] names it: what `ps` shows of
   * the pid that answered, if it started when the holder says it did. A holder that shares no
   * protocol with this build is listed by its socket, with no pid or build. Reads only.
   */
  async builds(): Promise<HolderBuild[]> {
    const installDir = this.opts.installDir ?? null;
    const inScope = this.opts.inScope ?? inTerminalScope;
    const listed = await Promise.all(
      (await this.reachAll(true)).map(async (r): Promise<HolderBuild | null> => {
        if (r.is === "outdated") {
          const terminalId = terminalAt(r.socket);
          if (terminalId === null) return null;
          const { socket, protocol } = r;
          return {
            terminalId,
            build: null,
            protocol,
            contained: null,
            socket,
            holderPid: null,
            stats: null,
          };
        }
        if (r.is !== "holder") return null;
        const { hello } = r;
        const reading = installDir === null ? "unread" : await readProcess(hello.holderPid);
        const same =
          typeof reading !== "string" &&
          Math.abs(reading.start - hello.holderStart) <= START_SKEW_S;
        const build = same && installDir !== null ? holderBuildOf(reading.args, installDir) : null;
        return {
          terminalId: hello.terminalId,
          build,
          protocol: hello.protocol,
          // The pid is the one that just answered, so it can't have been reused.
          contained: inScope(hello.holderPid),
          socket: r.socket,
          holderPid: hello.holderPid,
          stats: r.stats,
        };
      }),
    );
    return listed.filter((h) => h !== null);
  }

  /**
   * The terminals whose holders this build can't fully serve, with the versions each speaks: one
   * sharing no major with it, and one it serves only on an older major. Each needs a restart onto
   * a new holder to be served in full (design §4.7). Beside them, the terminals it serves in full.
   * Holders that can't be listed throw.
   */
  async compatibility(): Promise<Compatibility> {
    const outdated = new Map<TerminalId, readonly string[]>();
    const served = new Set<TerminalId>();
    for (const reached of await this.reachAll()) {
      const at = terminalAt(reached.socket);
      if (at === null) continue;
      if (reached.is === "outdated") outdated.set(at, reached.protocol);
      else if (reached.is !== "holder" || reached.hello.terminalId !== at) continue;
      else if (isOlderHolderMajor(reached.hello.version)) outdated.set(at, reached.hello.protocol);
      else served.add(at);
    }
    return { outdated, served };
  }

  /**
   * Every terminal a holder answers for. A socket that can't be read makes it throw: a reader that
   * concludes from what is missing, as reconciliation does, must not take a holder it couldn't read
   * for one that isn't there.
   */
  async inventory(): Promise<RuntimeInventoryEntry[]> {
    const { entries, unreadable } = await this.listed();
    if (unreadable.length > 0)
      throw new Error(`the holders at ${unreadable.join(", ")} can't be read`);
    return entries;
  }

  /**
   * What `inventory` reads, leaving out the sockets that couldn't be read, each reported once until
   * it reads again: for readers that only act on what they find, as exit polling does.
   */
  private async listed(): Promise<{
    readonly entries: RuntimeInventoryEntry[];
    readonly unreadable: string[];
  }> {
    const all = await this.reachAll();
    const listed = new Set(all.map((reached) => reached.socket));
    for (const socket of this.unreadable) if (!listed.has(socket)) this.unreadable.delete(socket);
    const unreadable: string[] = [];
    const entries = all.flatMap((reached): RuntimeInventoryEntry[] => {
      if (reached.is === "unreadable") {
        unreadable.push(reached.socket);
        if (!this.unreadable.has(reached.socket)) {
          this.unreadable.add(reached.socket);
          this.report(
            new Error(`the holder at ${reached.socket} can't be read`, { cause: reached.cause }),
          );
        }
        return [];
      }
      this.unreadable.delete(reached.socket);
      if (reached.is !== "holder") return [];
      const { hello } = reached;
      const { terminalId } = hello;
      const tags = decodeTags(hello.tags);
      // A holder answers at its own terminal's socket only; anything else isn't one of ours.
      if (tags === null || !isId("term", terminalId)) return [];
      if (basename(reached.socket) !== `${terminalId}.sock`) return [];
      return [{ ref: this.refOf(terminalId, hello), tags, exit: hello.exit }];
    });
    return { entries, unreadable };
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const { binary } = this.opts;
    if (binary === null) {
      const why = this.opts.unavailable ?? "no bazhen-holder is installed";
      throw new Error(`terminal ${spec.terminalId}: no holder can be started: ${why}`);
    }
    const socket = this.socketOf(spec.terminalId);
    const holderSpec = {
      protocol: [HOLDER_PROTOCOL_VERSION],
      terminalId: spec.terminalId,
      socket,
      tags: encodeTags(spec.tags),
      size: spec.size,
      historyLines: spec.historyLines,
      ...this.processSpec(spec),
    };
    const start = this.opts.start ?? startHolder;
    const containment = await this.opts.containment?.();
    const scope =
      containment?.kind === "scoped" ? { scope: terminalScope(containment, spec.terminalId) } : {};
    await start({ binary, root: this.opts.root, spec: holderSpec, env: {}, ...scope });
    const reached = await this.reach(socket);
    if (reached.is !== "holder") {
      // Best effort: one that answers later is told to close, rather than left with no record.
      void this.closeAt(socket);
      throw new Error(`terminal ${spec.terminalId}: its holder started but doesn't answer`, {
        cause: reached.is === "outdated" ? reached.protocol : reached.cause,
      });
    }
    const ref = this.refOf(spec.terminalId, reached.hello);
    if (spec.tags.kind === "agent") void this.titles.watch(this.watched(ref));
    return ref;
  }

  /** What the title watch watches of a terminal: its socket, and the holder its ref names. */
  private watched(ref: RuntimeRef) {
    return {
      terminalId: ref.terminalId,
      socket: this.socketOf(ref.terminalId),
      holderPid: Number(ref.locator.holderPid),
      holderStart: Number(ref.locator.holderStart),
    };
  }

  /** Closes whatever holder answers at `socket`, ignoring every failure. */
  private async closeAt(socket: string): Promise<void> {
    try {
      const client = await this.connect(socket, false, ignore);
      await client.close().finally(() => client.end());
    } catch {
      // Nothing answers, or it won't close: there is nothing more to do from here.
    }
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

  async attach(ref: RuntimeRef, size: Size | null): Promise<SnapshotAttached> {
    const stream = new HolderStream(this.controlFor(ref), size ?? { cols: 80, rows: 24 });
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

  /**
   * The control connection for the holder `ref` names, made if no stream of it has one. One made
   * for another holder of the terminal is left to its streams, and never reaches this one.
   */
  private controlFor(ref: RuntimeRef): Control {
    const id = ref.terminalId;
    const holder = { pid: Number(ref.locator.holderPid), start: Number(ref.locator.holderStart) };
    const current = this.controls.get(id);
    if (current?.serves(holder) === true) return current;
    const socket = this.socketOf(id);
    const control: Control = new Control({
      open: (writer, onEvent) => this.connect(socket, writer, onEvent),
      holder,
      after: this.retiring.get(id),
      onIdle: (closed) => {
        if (this.controls.get(id) === control) this.controls.delete(id);
        this.retiring.set(id, closed);
        void closed.then(() => {
          if (this.retiring.get(id) === closed) this.retiring.delete(id);
        });
      },
    });
    this.controls.set(id, control);
    return control;
  }

  private forget(terminalId: string): void {
    const control = this.controls.get(terminalId);
    this.controls.delete(terminalId);
    if (control !== undefined) this.retiring.set(terminalId, control.end());
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
    const group = await this.foregroundGroup(ref);
    const command = commandIn(await this.commands([group.pgid]), group);
    if (command === null) throw new Error(`can't read terminal ${ref.terminalId}'s foreground`);
    return { command, own: group.own };
  }

  /** The group holding the terminal's foreground as its holder names it, and its leader's start. */
  private async foregroundGroup(ref: RuntimeRef) {
    const read = await this.withProcess(ref, async (client) => {
      if (client.hello.exit !== null) throw new ProcessState(ref.terminalId, "running");
      return client.foreground().catch((error: unknown) => {
        throw refusal(ref, error);
      });
    });
    return { own: read.pgid === read.childPid, pgid: read.pgid, start: read.pgidStart };
  }

  /**
   * One read of every leader's command, and one more of those with a directory, however many
   * terminals there are: each `ps` started holds up everything else the caller serves until it
   * has exec'd.
   */
  async foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]> {
    if (terminalIds.size === 0) return [];
    const live = (await this.listed()).entries.filter(
      (e) => e.exit === null && terminalIds.has(e.ref.terminalId),
    );
    const groups = (
      await Promise.all(
        live.map(async ({ ref }) => {
          try {
            return [{ ref, ...(await this.foregroundGroup(ref)) }];
          } catch {
            return [];
          }
        }),
      )
    ).flat();
    const commands = await this.commands(groups.map((g) => g.pgid));
    const named = groups.flatMap((group) => {
      const command = commandIn(commands, group);
      return command === null ? [] : [{ ...group, command }];
    });
    // The foreground's own directory, as tmux reports a pane's: read once for them all, and kept
    // only for a leader that is still the one that started when the holder said.
    const cwds = await processCwds(named.map((g) => g.pgid));
    const leaders = named.filter((g) => cwds.has(g.pgid));
    const still =
      leaders.length === 0 ? new Map() : await this.commands(leaders.map((g) => g.pgid));
    return named.map(({ ref, command, own, pgid, start }) => {
      const cwd = cwds.get(pgid);
      const same = cwd !== undefined && commandIn(still, { pgid, start }) !== null;
      return { ref, command, own, cwd: same ? cwd : null };
    });
  }

  /** The title in the holder's `hello`: its current process's, whichever generation that is. */
  async title(ref: RuntimeRef): Promise<string> {
    const client = await this.holderOf(ref);
    client.end();
    return client.hello.title;
  }

  async unlink(ref: RuntimeRef): Promise<void> {
    const client = await this.holderOf(ref);
    try {
      await client.setTags(unlinked(client.hello.tags));
    } finally {
      client.end();
    }
  }

  /**
   * Refuses every paste, once the text and the ref have been checked as for any runtime: a
   * holder has no gate that checks, in the same turn as it types, that the program would read
   * the paste as text, so nothing is typed without one.
   */
  async paste(ref: RuntimeRef, text: string, brackets: boolean): Promise<void> {
    const refused = pasteTextRefusal(text, brackets);
    if (refused !== undefined) throw new RangeError(refused);
    await this.withProcess(ref, async (client) => {
      if (client.hello.exit !== null) throw new ProcessState(ref.terminalId, "running");
    });
    throw new PasteRefused("a holder terminal has no paste gate");
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

  /**
   * Calls `cb` with an agent terminal's title: as the runtime starts watching it, and each time
   * its program sets one. Returns the unsubscribe function, which ends every watch once no
   * listener is left.
   */
  onTitle(cb: (terminalId: TerminalId, title: string) => void): () => void {
    return this.titles.subscribe(cb);
  }

  attachCommand(ref: RuntimeRef): string {
    return shellCommand(["bazhen", "attach", ref.terminalId]);
  }

  private async deadTerminals(): Promise<DeadTerminal[]> {
    return (await this.listed()).entries.flatMap((e) =>
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

/**
 * The command of the process leading group `pgid`, as `read` shows it, if that is still the one
 * that started at `start`.
 */
function commandIn(
  read: ReadonlyMap<number, ProcessCommand> | "unreadable",
  { pgid, start }: { readonly pgid: number; readonly start: number },
): string | null {
  const shown = read === "unreadable" ? undefined : read.get(pgid);
  if (shown === undefined || Math.abs(shown.start - start) > START_SKEW_S) return null;
  return basename(shown.comm);
}
