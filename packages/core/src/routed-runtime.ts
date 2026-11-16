import type { ExitStatus, RuntimeHealthState, Signal } from "@bazhen/protocol";
import type {
  Attached,
  Compatibility,
  Foreground,
  ProcessSpec,
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeInventoryEntry,
  RuntimeRef,
  Size,
  TerminalForeground,
  TerminalSpec,
} from "./runtime.ts";

/**
 * A ref names a runtime this daemon doesn't run. Never "gone": the terminal may well be running
 * where it was made, so nothing may be concluded about it from here.
 */
export class UnknownRuntime extends Error {
  readonly runtime: string;

  constructor(runtime: string, terminalId?: string) {
    super(
      `${terminalId === undefined ? "" : `terminal ${terminalId}: `}no ${runtime} runtime here`,
    );
    this.runtime = runtime;
  }
}

export interface RoutedRuntimeOptions {
  /** One adapter per kind. */
  readonly runtimes: readonly RuntimeAdapter[];
  /** The kind a terminal is created on when its spec names none. */
  readonly defaultKind: string;
  /** Where a runtime's failure goes when the others still answer for it. */
  readonly onError: (err: unknown) => void;
}

/** Each runtime of `runtime`'s, by kind, with its own health: one, unless it is routed. */
export async function healthOfEach(
  runtime: RuntimeAdapter,
): Promise<(RuntimeHealth & { readonly kind: string })[]> {
  const each =
    runtime instanceof RoutedRuntime ? runtime.kinds.map((k) => runtime.only(k)) : [runtime];
  return Promise.all(each.map(async (r) => ({ kind: r.kind, ...(await r.health()) })));
}

/** Worst first: one runtime that can't be read is what a reader of all of them must know. */
const SEVERITY: Record<RuntimeHealthState, number> = {
  unreachable: 2,
  healthy: 1,
  "not-running": 0,
};

/**
 * Several runtimes behind one adapter: each terminal stays on the runtime it was made on, and
 * every verb on a ref goes to the runtime the ref names (design §5.4).
 */
export class RoutedRuntime implements RuntimeAdapter {
  readonly kind = "routed";
  readonly kinds: readonly string[];
  readonly defaultKind: string;
  private readonly runtimes: ReadonlyMap<string, RuntimeAdapter>;
  private readonly onError: (err: unknown) => void;

  constructor(opts: RoutedRuntimeOptions) {
    const runtimes = new Map<string, RuntimeAdapter>();
    for (const runtime of opts.runtimes) {
      if (runtimes.has(runtime.kind)) throw new RangeError(`two ${runtime.kind} runtimes`);
      runtimes.set(runtime.kind, runtime);
    }
    if (!runtimes.has(opts.defaultKind)) throw new UnknownRuntime(opts.defaultKind);
    this.runtimes = runtimes;
    this.kinds = [...runtimes.keys()];
    this.defaultKind = opts.defaultKind;
    this.onError = opts.onError;
  }

  /** The one runtime of `kind`. */
  only(kind: string): RuntimeAdapter {
    const runtime = this.runtimes.get(kind);
    if (runtime === undefined) throw new UnknownRuntime(kind);
    return runtime;
  }

  private of(ref: RuntimeRef): RuntimeAdapter {
    const runtime = this.runtimes.get(ref.runtime);
    if (runtime === undefined) throw new UnknownRuntime(ref.runtime, ref.terminalId);
    return runtime;
  }

  /**
   * The worst of each runtime's health, each judged by the refs recorded on it, with the default
   * runtime's version.
   */
  async health(recorded: readonly RuntimeRef[] = []): Promise<RuntimeHealth> {
    const read = await Promise.all(
      this.kinds.map(async (kind) => ({
        kind,
        ...(await this.only(kind).health(recorded.filter((ref) => ref.runtime === kind))),
      })),
    );
    const worst = read.reduce((a, b) => (SEVERITY[b.state] > SEVERITY[a.state] ? b : a));
    const version = read.find((r) => r.kind === this.defaultKind)?.version ?? null;
    return { state: worst.state, version };
  }

  /** Every runtime's terminals; one that can't be read throws, as one runtime's would. */
  async inventory(): Promise<RuntimeInventoryEntry[]> {
    const all = await Promise.all([...this.runtimes.values()].map((r) => r.inventory()));
    return all.flat();
  }

  /** Every runtime's compatibility; one that can't be read throws, as its inventory does. */
  async compatibility(): Promise<Compatibility> {
    const all = await Promise.all(
      [...this.runtimes.values()].map((r) => r.compatibility?.() ?? Promise.resolve(undefined)),
    );
    return {
      outdated: new Map(all.flatMap((c) => [...(c?.outdated ?? [])])),
      served: new Set(all.flatMap((c) => [...(c?.served ?? [])])),
    };
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    return this.only(spec.runtime ?? this.defaultKind).create(spec);
  }

  async attach(ref: RuntimeRef, size: Size | null): Promise<Attached> {
    return this.of(ref).attach(ref, size);
  }

  async close(ref: RuntimeRef): Promise<void> {
    return this.of(ref).close(ref);
  }

  /** Never for a runtime not here: only the runtime it was made on can prove it gone. */
  async gone(ref: RuntimeRef): Promise<boolean> {
    const runtime = this.runtimes.get(ref.runtime);
    return runtime === undefined ? false : runtime.gone(ref);
  }

  async respawn(ref: RuntimeRef, spec: ProcessSpec): Promise<RuntimeRef> {
    return this.of(ref).respawn(ref, spec);
  }

  async foreground(ref: RuntimeRef): Promise<Foreground> {
    return this.of(ref).foreground(ref);
  }

  /**
   * Each runtime's foregrounds. One that can't be read leaves its terminals out, which the
   * contract allows, so the rest are still seen; only when none can be read does this throw.
   */
  async foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]> {
    const read = await Promise.allSettled(
      [...this.runtimes.values()].map((r) => r.foregrounds(terminalIds)),
    );
    const failed = read.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    if (failed.length === read.length) throw failed[0];
    for (const err of failed) this.onError(err);
    return read.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async title(ref: RuntimeRef): Promise<string> {
    return this.of(ref).title(ref);
  }

  async unlink(ref: RuntimeRef): Promise<void> {
    return this.of(ref).unlink(ref);
  }

  async paste(ref: RuntimeRef, text: string, brackets: boolean): Promise<void> {
    return this.of(ref).paste(ref, text, brackets);
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    return this.of(ref).signal(ref, signal);
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    const unsubscribe = [...this.runtimes.values()].map((r) => r.onExit(cb));
    return () => {
      for (const off of unsubscribe) off();
    };
  }

  attachCommand(ref: RuntimeRef): string {
    return this.of(ref).attachCommand(ref);
  }
}
