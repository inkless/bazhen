import type { TerminalId } from "@bazhen/core";
import type { HolderClient, HolderEvent } from "./client.ts";

export interface TitleWatchOptions {
  /** The terminals to watch, each with its holder's socket; throws when they can't be listed. */
  readonly list: () => Promise<readonly { terminalId: TerminalId; socket: string }[]>;
  /** A connection to the holder at `socket` that only reads: no writer slot, no subscription. */
  readonly connect: (
    socket: string,
    onEvent: (event: HolderEvent) => void,
  ) => Promise<HolderClient>;
  /** How often the terminals are listed again, for one whose connection was refused or lost. */
  readonly syncMs: number;
  readonly onError: (err: unknown) => void;
}

type Listener = (terminalId: TerminalId) => void;

/** A connection being opened, or open; `client` is set once it is. */
interface Watching {
  client: HolderClient | null;
}

/**
 * Tells its listeners of each listed terminal whose title may have changed: once as its connection
 * opens, then on each `title` its holder reports, which a holder sends to every connection, not
 * only a subscribed one. One connection per terminal while anyone listens, none after.
 */
export class TitleWatch {
  private readonly opts: TitleWatchOptions;
  private readonly listeners = new Set<Listener>();
  private readonly watching = new Map<TerminalId, Watching>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing: Promise<void> | null = null;

  constructor(opts: TitleWatchOptions) {
    this.opts = opts;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.sync(), this.opts.syncMs);
      void this.sync();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      clearInterval(this.timer);
      this.timer = undefined;
      for (const terminalId of this.watching.keys()) this.forget(terminalId);
    };
  }

  /** Lists the terminals, opens a connection to each not yet watched, and drops those not listed. */
  sync(): Promise<void> {
    this.syncing ??= this.list().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async list(): Promise<void> {
    if (this.listeners.size === 0) return;
    let listed: Awaited<ReturnType<TitleWatchOptions["list"]>>;
    try {
      listed = await this.opts.list();
    } catch (err) {
      this.opts.onError(err);
      return;
    }
    if (this.listeners.size === 0) return;
    const ids = new Set(listed.map((t) => t.terminalId));
    for (const terminalId of this.watching.keys())
      if (!ids.has(terminalId)) this.forget(terminalId);
    await Promise.all(listed.map(({ terminalId, socket }) => this.watch(terminalId, socket)));
  }

  /** Watches the terminal at `socket`, unless it is already watched or nobody listens. */
  async watch(terminalId: TerminalId, socket: string): Promise<void> {
    if (this.listeners.size === 0 || this.watching.has(terminalId)) return;
    const entry: Watching = { client: null };
    this.watching.set(terminalId, entry);
    let client: HolderClient;
    try {
      client = await this.opts.connect(socket, (event) => {
        if (event.type === "title") this.tell(terminalId);
      });
    } catch {
      // Watched again at the next sync, if it is still listed.
      if (this.watching.get(terminalId) === entry) this.watching.delete(terminalId);
      return;
    }
    if (this.watching.get(terminalId) !== entry || client.hello.terminalId !== terminalId) {
      if (this.watching.get(terminalId) === entry) this.watching.delete(terminalId);
      client.end();
      return;
    }
    entry.client = client;
    void client.ended.then(() => {
      if (this.watching.get(terminalId) === entry) this.watching.delete(terminalId);
    });
    this.tell(terminalId);
  }

  private forget(terminalId: TerminalId): void {
    const entry = this.watching.get(terminalId);
    this.watching.delete(terminalId);
    entry?.client?.end();
  }

  private tell(terminalId: TerminalId): void {
    for (const listener of this.listeners) {
      try {
        listener(terminalId);
      } catch (err) {
        this.opts.onError(err);
      }
    }
  }
}
