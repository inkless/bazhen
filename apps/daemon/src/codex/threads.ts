import type { RuntimeRef } from "@bazhen/core";
import { matching, readThreadList, readThreadStarted, titlePrefix } from "@bazhen/harness-codex";
import type { Store } from "../store/store.ts";
import type { ChannelListener } from "./channel.ts";

export interface CodexThreadsOptions {
  readonly store: Store;
  /** The tmux runtime the agents' panes are on, which reads a pane's title. */
  readonly runtime: {
    readonly socket: string;
    paneTitle(ref: RuntimeRef): Promise<string>;
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

/** A pane waiting to resume the thread its title names: for which agent, since when. */
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
 * Follows a Codex TUI from thread to thread (foundation-design §5.8, C6). The TUI keeps its pane's
 * title set to the thread it shows, and tmux tells the daemon when a title changes. The title
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
  /** Panes whose title named no thread yet, by the prefix it named. */
  private readonly waiting = new Map<string, string>();
  /** Panes waiting to resume the thread their title names. */
  private readonly resuming = new Map<string, Resuming>();
  /** The agents whose titles are being read at start; their mail waits until they are. */
  private starting: Set<string> | undefined;
  /** One title at a time, in the order tmux reported them. */
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
      for (const [pane, prefix] of this.waiting) {
        if (id.startsWith(prefix)) void this.paneTitleChanged(pane);
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
    const { store, runtime } = this.opts;
    const panes = store.codexPanes(runtime.socket);
    // Until each title is read, mail could go to a thread the TUI has left.
    const starting = new Set(
      panes.flatMap((pane) => store.codexAgentInPane(runtime.socket, pane)?.agentId ?? []),
    );
    this.starting = starting;
    for (const pane of panes) void this.paneTitleChanged(pane);
    void this.queue.then(() => {
      this.starting = undefined;
      for (const agentId of starting) if (!this.held(agentId)) this.opts.released?.(agentId);
    });
  }

  /** A pane's title changed; resolves once it has been acted on. */
  paneTitleChanged(pane: string): Promise<void> {
    this.queue = this.queue
      .then(() => this.follow(pane))
      .catch((err: unknown) => {
        this.log(`codex: following pane ${pane} failed: ${String(err)}`);
        // A move it was waiting on is tried again, or given up, rather than left holding mail.
        const r = this.resuming.get(pane);
        if (r !== undefined) this.later(pane, r);
      });
    return this.queue;
  }

  private async follow(pane: string): Promise<void> {
    const { store, runtime } = this.opts;
    this.waiting.delete(pane);
    const agent = store.codexAgentInPane(runtime.socket, pane);
    if (agent === undefined) return this.settle(pane);
    const title = await runtime.paneTitle(agent.runtime);
    const prefix = titlePrefix(title);
    if (prefix === null) {
      this.settle(pane);
      return this.untracked(agent.agentId, "its title is not a thread id");
    }
    // Still the same thread, as after `/compact`, or back on it.
    if (agent.threadId.startsWith(prefix)) return this.settle(pane);
    let found = matching(prefix, this.seen);
    if (found.length === 0) found = matching(prefix, await this.listed());
    const [threadId] = found;
    if (threadId === undefined) this.waiting.set(pane, prefix);
    if (threadId === undefined || found.length > 1) {
      this.settle(pane);
      const why = found.length > 1 ? `${found.length} threads` : "no thread";
      return this.untracked(agent.agentId, `${why} match ${prefix}`);
    }
    // One thread, one agent: a /resume of another agent's thread is not a move.
    if (store.codexAgentsOn(threadId).some((id) => id !== agent.agentId)) {
      this.settle(pane);
      return this.untracked(agent.agentId, `thread ${threadId} is another agent's`);
    }
    // Subscribe first, so nothing the thread sends after the move is missed.
    if (!(await this.resumed(pane, agent.agentId, threadId))) return;
    const now = store.codexAgentInPane(runtime.socket, pane);
    // Closed, or moved again by another title, while the thread was being resumed.
    if (now?.agentId !== agent.agentId || now.threadId !== agent.threadId) return this.settle(pane);
    store.append({
      type: "agent.external_ref_updated",
      entityId: agent.agentId,
      actor: "system",
      payload: {
        externalRef: { environmentId: agent.environmentId, kind: "codex-thread", id: threadId },
      },
    });
    this.tracked(agent.agentId);
    // Bound to the new thread now, so held mail goes there.
    this.settle(pane);
  }

  /**
   * Resumes the thread a pane's title names; false while it waits. One the server can't load
   * yet, as a `/new` before its first prompt, is tried again later until RESUME_GIVE_UP_MS have
   * passed, and the agent then stays where it is.
   */
  private async resumed(pane: string, agentId: string, threadId: string): Promise<boolean> {
    const prior = this.resuming.get(pane);
    const r =
      prior?.threadId === threadId
        ? prior
        : { agentId, threadId, since: Date.now(), waitMs: this.opts.retryMs ?? 500 };
    this.resuming.set(pane, r);
    try {
      await this.opts.channel.resume(threadId);
      return true;
    } catch (err) {
      this.log(`codex: thread ${threadId} can't be resumed yet: ${String(err)}`);
      this.later(pane, r);
      return false;
    }
  }

  /** Follows the pane again after a wait, or, past the give-up time, leaves the agent be. */
  private later(pane: string, r: Resuming): void {
    if (Date.now() - r.since >= (this.opts.giveUpMs ?? RESUME_GIVE_UP_MS)) {
      this.settle(pane);
      return this.untracked(r.agentId, `thread ${r.threadId} could not be resumed`);
    }
    clearTimeout(r.timer);
    r.timer = setTimeout(() => void this.paneTitleChanged(pane), r.waitMs);
    r.timer.unref();
    r.waitMs = Math.min(r.waitMs * 2, RESUME_MAX_MS);
  }

  /** The pane waits to move no longer: its agent's held mail may go. */
  private settle(pane: string): void {
    const r = this.resuming.get(pane);
    if (r === undefined) return;
    clearTimeout(r.timer);
    this.resuming.delete(pane);
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

  /** A move took: switches are followed again, if the agent said they weren't. */
  private tracked(agentId: string): void {
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
