import type { TerminalId } from "@bazhen/core";
import type { HolderClient, HolderEvent } from "./client.ts";

/** A terminal to watch: the holder that runs it, by its pid and start, and its socket. */
export interface Watched {
  readonly terminalId: TerminalId;
  readonly socket: string;
  readonly holderPid: number;
  readonly holderStart: number;
}

export interface TitleWatchOptions {
  /** The terminals to watch now; throws when they can't be listed. */
  readonly list: () => Promise<readonly Watched[]>;
  /** A connection to the holder at `socket` that only reads: no writer slot, no subscription. */
  readonly connect: (
    socket: string,
    onEvent: (event: HolderEvent) => void,
  ) => Promise<HolderClient>;
  /** How often the terminals are listed again, for one whose connection was refused or lost. */
  readonly syncMs: number;
  readonly onError: (err: unknown) => void;
}

type Listener = (terminalId: TerminalId, title: string) => void;

/** A connection being opened, or open, to one holder; `client` is set once it is. */
interface Watching {
  readonly holderPid: number;
  readonly holderStart: number;
  client: HolderClient | null;
}

const sameHolder = (a: Pick<Watching, "holderPid" | "holderStart">, b: Watching) =>
  a.holderPid === b.holderPid && a.holderStart === b.holderStart;

/**
 * Tells its listeners each listed terminal's title: as its connection opens, then each `title` its
 * holder reports, which a holder sends to every connection, not only a subscribed one. One
 * connection per terminal, to the holder that runs it now, while anyone listens, none after. A
 * holder that goes away ends its connection, so a terminal a listing leaves out, as one whose
 * holder was slow to answer, keeps its watch.
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

  /** Returns the unsubscribe function; once the last listener goes, every watch ends. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.sync(), this.opts.syncMs);
      this.timer.unref();
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

  /** Lists the terminals and watches each one not yet watched on the holder that runs it now. */
  sync(): Promise<void> {
    this.syncing ??= this.list().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async list(): Promise<void> {
    if (this.listeners.size === 0) return;
    let listed: readonly Watched[];
    try {
      listed = await this.opts.list();
    } catch (err) {
      this.opts.onError(err);
      return;
    }
    await Promise.all(listed.map((terminal) => this.watch(terminal)));
  }

  /**
   * Watches the terminal on the holder named, in place of a watch on any other holder of it;
   * nothing while nobody listens, or while that holder is already watched.
   */
  async watch(terminal: Watched): Promise<void> {
    const { terminalId, socket } = terminal;
    if (this.listeners.size === 0) return;
    const current = this.watching.get(terminalId);
    if (current !== undefined && sameHolder(terminal, current)) return;
    if (current !== undefined) this.forget(terminalId);
    const entry: Watching = {
      holderPid: terminal.holderPid,
      holderStart: terminal.holderStart,
      client: null,
    };
    this.watching.set(terminalId, entry);
    const ours = () => this.watching.get(terminalId) === entry;
    // A title read with `hello`, in the same chunk, reaches here before `hello` is checked: the
    // latest is kept until then, and told in place of the one `hello` named.
    let early: string | undefined;
    let client: HolderClient;
    try {
      client = await this.opts.connect(socket, (event) => {
        if (event.type !== "title") return;
        if (entry.client === null) early = event.body.text;
        else if (ours()) this.tell(terminalId, event.body.text);
      });
    } catch {
      // Watched again at the next sync, if it is still listed.
      if (ours()) this.watching.delete(terminalId);
      return;
    }
    const { hello } = client;
    if (!ours() || hello.terminalId !== terminalId || !sameHolder(hello, entry)) {
      if (ours()) this.watching.delete(terminalId);
      client.end();
      return;
    }
    entry.client = client;
    void client.ended.then(() => {
      if (ours()) this.watching.delete(terminalId);
    });
    this.tell(terminalId, early ?? hello.title);
  }

  private forget(terminalId: TerminalId): void {
    const entry = this.watching.get(terminalId);
    this.watching.delete(terminalId);
    entry?.client?.end();
  }

  private tell(terminalId: TerminalId, title: string): void {
    for (const listener of this.listeners) {
      try {
        listener(terminalId, title);
      } catch (err) {
        this.opts.onError(err);
      }
    }
  }
}
