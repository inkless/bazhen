import type { RuntimeRef, TerminalId } from "@bazhen/core";
import { matching, readThreadList, readThreadStarted, titlePrefix } from "@bazhen/harness-codex";
import type { Store } from "../store/store.ts";
import type { ChannelListener } from "./channel.ts";

export interface CodexThreadsOptions {
  readonly store: Store;
  /** What reads a terminal's title, on whichever runtime it runs. */
  readonly runtime: {
    title(ref: RuntimeRef): Promise<string>;
  };
  /** The app-server, to list threads and to resume (subscribe to) the one an agent moved to. */
  readonly channel: {
    request(method: string, params: unknown): Promise<unknown>;
    resume(threadId: string): Promise<void>;
  };
  readonly log?: (message: string) => void;
  /** The first wait before resuming a thread again; it doubles to RESUME_MAX_MS. */
  readonly retryMs?: number;
  /** How long a thread is resumed again before the agent is left where it is. */
  readonly giveUpMs?: number;
  /** An agent's mail, held while it waits to move, may go again: to its thread as it is now. */
  readonly released?: (agentId: string) => void;
  /** The agent's TUI shows its thread, which it does only once it is up. */
  readonly ready?: (agentId: string) => void;
}

/** The longest wait between resumes of a thread the TUI shows but the server can't load yet. */
const RESUME_MAX_MS = 5000;
/** How long such a thread is tried, by default, before the agent is left where it is. */
const RESUME_GIVE_UP_MS = 10 * 60_000;

/**
 * What tmux runs when a pane's title changes, with the pane's id appended: the hook client,
 * telling the daemon on `socket`. The client runs outside any agent, so the socket is its
 * argument.
 */
export const paneTitleCommand = (client: string, socket: string) =>
  [client, "pane-title", socket] as const;

/** A terminal waiting to resume the thread its title names: for which agent, since when. */
interface Resuming {
  readonly agentId: string;
  readonly threadId: string;
  readonly since: number;
  waitMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** How many new thread ids are kept to resolve titles against; the oldest go first. */
const SEEN = 2000;

export const UNTRACKED = "thread switches are not being tracked";

/**
 * Follows a Codex TUI from thread to thread (foundation-design §5.8, C6). The TUI keeps its
 * terminal's title set to the thread it shows, and the runtime tells the daemon when a title
 * changes: tmux by a hook, a holder by the frame it sends. The title
 * holds at most the id's first 29 characters, so it is resolved against the threads the
 * app-server has announced, then against its thread list, for one from before Bazhen connected.
 * Only exactly one match moves the agent: none, several, or a title that is no thread id leaves
 * it on its thread. A title can name a thread before the server announces it, so one that matched
 * nothing is tried again when a thread it names is announced. A thread `/new` starts can't be
 * resumed until its first prompt saves it, so the move waits, resuming again with backoff for as
 * long as the title still names it, and holds the agent's new mail meanwhile, which would
 * otherwise go to a thread the user no longer sees. A thread another running agent is bound to is
 * never moved onto. Mail and approvals follow the binding without more work.
 */
export class CodexThreads {
  private readonly opts: CodexThreadsOptions;
  private readonly log: (message: string) => void;
  private readonly seen = new Set<string>();
  /** Terminals whose title named no thread yet, by the prefix it named. */
  private readonly waiting = new Map<TerminalId, string>();
  /** Terminals waiting to resume the thread their title names. */
  private readonly resuming = new Map<TerminalId, Resuming>();
  /**
   * Terminals a TUI is started in again, whose title may still be the last TUI's: a respawn
   * keeps the terminal, and a TUI that was killed never empties its title. Their title says the
   * new TUI is up only once a change to it has been heard.
   */
  private readonly reused = new Set<TerminalId>();
  /** The agents whose titles are being read at start; their mail waits until they are. */
  private starting: Set<string> | undefined;
  /** One title at a time, in the order the runtimes reported them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: CodexThreadsOptions) {
    this.opts = opts;
    this.log = opts.log ?? console.warn;
  }

  readonly listener: Partial<ChannelListener> = {
    notification: (method, params) => {
      const id = readThreadStarted(method, params);
      if (id === null) return;
      this.seen.delete(id);
      this.seen.add(id);
      for (const old of this.seen) {
        if (this.seen.size <= SEEN) break;
        this.seen.delete(old);
      }
      for (const [terminal, prefix] of this.waiting) {
        if (id.startsWith(prefix)) void this.titleChanged(terminal);
      }
    },
  };

  /** Whether an agent's new mail waits, while it is about to move to the thread its TUI shows. */
  held(agentId: string): boolean {
    return (
      this.starting?.has(agentId) === true ||
      [...this.resuming.values()].some((r) => r.agentId === agentId)
    );
  }

  /**
   * Reads every running Codex agent's title, as after a daemon restart, which forgot any move in
   * progress and every title change while it was down.
   */
  followAll(): void {
    const { store } = this.opts;
    const terminals = store.codexTerminals();
    // Until each title is read, mail could go to a thread the TUI has left.
    const starting = new Set(terminals.flatMap((t) => store.codexAgentIn(t)?.agentId ?? []));
    this.starting = starting;
    for (const terminal of terminals) void this.titleChanged(terminal);
    void this.queue.then(() => {
      this.starting = undefined;
      for (const agentId of starting) if (!this.held(agentId)) this.opts.released?.(agentId);
    });
  }

  /**
   * A title a runtime heard set in a terminal, `title` when it said which: followed if it is a
   * Codex agent's, and dropped at once otherwise, so other agents' titles, however often they
   * change, never wait in the queue ahead of a Codex agent's.
   */
  heard(terminal: TerminalId, title?: string): Promise<void> {
    if (!this.opts.store.isCodexTerminal(terminal)) return Promise.resolve();
    this.reused.delete(terminal);
    return this.titleChanged(terminal, title);
  }

  /** A TUI is about to start again in `terminal`, which keeps the last one's title. */
  reusing(terminal: TerminalId): void {
    this.reused.add(terminal);
  }

  /**
   * A terminal's title may have changed: to `title`, when the runtime said which, or else to what
   * reading it finds. Resolves once it has been acted on.
   */
  titleChanged(terminal: TerminalId, title?: string): Promise<void> {
    this.queue = this.queue
      .then(() => this.follow(terminal, title))
      .catch((err: unknown) => {
        this.log(`codex: following terminal ${terminal} failed: ${String(err)}`);
        // A move it was waiting on is tried again, or given up, rather than left holding mail.
        const r = this.resuming.get(terminal);
        if (r !== undefined) this.later(terminal, r);
      });
    return this.queue;
  }

  private async follow(terminal: TerminalId, told?: string): Promise<void> {
    const { store, runtime } = this.opts;
    this.waiting.delete(terminal);
    const agent = store.codexAgentIn(terminal);
    if (agent === undefined) return this.settle(terminal);
    const title = told ?? (await runtime.title(agent.runtime));
    // The TUI empties its title as it exits, which names no thread to follow.
    if (title.trim() === "") return this.settle(terminal);
    const prefix = titlePrefix(title);
    if (prefix === null) {
      this.settle(terminal);
      return this.untracked(agent.agentId, `its title ${JSON.stringify(title)} names no thread`);
    }
    // Still the same thread, as after `/compact`, or back on it.
    if (agent.threadId.startsWith(prefix)) {
      this.tracked(agent.agentId, terminal);
      return this.settle(terminal);
    }
    let found = matching(prefix, this.seen);
    if (found.length === 0) found = matching(prefix, await this.listed());
    const [threadId] = found;
    if (threadId === undefined) this.waiting.set(terminal, prefix);
    if (threadId === undefined || found.length > 1) {
      this.settle(terminal);
      const why = found.length > 1 ? `${found.length} threads` : "no thread";
      return this.untracked(agent.agentId, `${why} match ${prefix}`);
    }
    // One thread, one agent: a /resume of another agent's thread is not a move.
    if (store.codexAgentsOn(threadId).some((id) => id !== agent.agentId)) {
      this.settle(terminal);
      return this.untracked(agent.agentId, `thread ${threadId} is another agent's`);
    }
    // Subscribe first, so nothing the thread sends after the move is missed.
    if (!(await this.resumed(terminal, agent.agentId, threadId))) return;
    const now = store.codexAgentIn(terminal);
    // Closed, or moved again by another title, while the thread was being resumed.
    if (now?.agentId !== agent.agentId || now.threadId !== agent.threadId)
      return this.settle(terminal);
    store.append({
      type: "agent.external_ref_updated",
      entityId: agent.agentId,
      actor: "system",
      payload: {
        externalRef: { environmentId: agent.environmentId, kind: "codex-thread", id: threadId },
      },
    });
    this.tracked(agent.agentId, terminal);
    // Bound to the new thread now, so held mail goes there.
    this.settle(terminal);
  }

  /**
   * Resumes the thread a terminal's title names; false while it waits. One the server can't load
   * yet, as a `/new` before its first prompt, is tried again later until RESUME_GIVE_UP_MS have
   * passed, and the agent then stays where it is.
   */
  private async resumed(terminal: TerminalId, agentId: string, threadId: string): Promise<boolean> {
    const prior = this.resuming.get(terminal);
    const r =
      prior?.threadId === threadId
        ? prior
        : { agentId, threadId, since: Date.now(), waitMs: this.opts.retryMs ?? 500 };
    this.resuming.set(terminal, r);
    try {
      await this.opts.channel.resume(threadId);
      return true;
    } catch (err) {
      this.log(`codex: thread ${threadId} can't be resumed yet: ${String(err)}`);
      this.later(terminal, r);
      return false;
    }
  }

  /** Follows the terminal again after a wait, or, past the give-up time, leaves the agent be. */
  private later(terminal: TerminalId, r: Resuming): void {
    if (Date.now() - r.since >= (this.opts.giveUpMs ?? RESUME_GIVE_UP_MS)) {
      this.settle(terminal);
      return this.untracked(r.agentId, `thread ${r.threadId} could not be resumed`);
    }
    clearTimeout(r.timer);
    r.timer = setTimeout(() => void this.titleChanged(terminal), r.waitMs);
    r.timer.unref();
    r.waitMs = Math.min(r.waitMs * 2, RESUME_MAX_MS);
  }

  /** The terminal waits to move no longer: its agent's held mail may go. */
  private settle(terminal: TerminalId): void {
    const r = this.resuming.get(terminal);
    if (r === undefined) return;
    clearTimeout(r.timer);
    this.resuming.delete(terminal);
    this.opts.released?.(r.agentId);
  }

  /** The threads the server lists, newest first; none if it can't list them. */
  private async listed(): Promise<string[]> {
    try {
      return readThreadList(await this.opts.channel.request("thread/list", { limit: 50 }));
    } catch (err) {
      this.log(`codex: could not list threads: ${String(err)}`);
      return [];
    }
  }

  /**
   * The title names the agent's thread: its TUI is up, unless the title may be the last TUI's, and
   * switches are followed again, if it said they weren't.
   */
  private tracked(agentId: string, terminal: TerminalId): void {
    if (!this.reused.has(terminal)) this.opts.ready?.(agentId);
    const latest = this.opts.store.latestActivity(agentId);
    if (latest?.detail !== UNTRACKED) return;
    const { detail: _untracked, ...rest } = latest;
    this.opts.store.recordActivity(agentId, { ...rest, observedAt: new Date().toISOString() });
  }

  /** The agent stays where it is, and says that switches aren't followed. */
  private untracked(agentId: string, why: string): void {
    this.log(`codex: agent ${agentId} keeps its thread: ${why}`);
    const latest = this.opts.store.latestActivity(agentId);
    this.opts.store.recordActivity(agentId, {
      value: latest?.value ?? "unknown",
      source: "native",
      confidence: latest?.confidence ?? 1,
      observedAt: new Date().toISOString(),
      detail: UNTRACKED,
    });
  }
}
