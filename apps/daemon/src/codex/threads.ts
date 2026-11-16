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
  /** The first wait before a waiting move is tried again; it doubles to RESUME_MAX_MS. */
  readonly retryMs?: number;
  /** How long a waiting move is tried again before the agent is left where it is. */
  readonly giveUpMs?: number;
  /** An agent's mail, held while it waits to move, may go again: to its thread as it is now. */
  readonly released?: (agentId: string) => void;
  /** The agent's TUI shows its thread, which it does only once it is up. */
  readonly ready?: (agentId: string) => void;
}

/** The longest wait between tries of a move to a thread the server can't list or load yet. */
const RESUME_MAX_MS = 5000;
/** How long such a move is tried, by default, before the agent is left where it is. */
const RESUME_GIVE_UP_MS = 10 * 60_000;

/**
 * What tmux runs when a pane's title changes, with the pane's id appended: the hook client,
 * telling the daemon on `socket`. The client runs outside any agent, so the socket is its
 * argument.
 */
export const paneTitleCommand = (client: string, socket: string) =>
  [client, "pane-title", socket] as const;

/**
 * A terminal waiting to move its agent to the thread its title names, by the prefix it names: for
 * which agent, since when, and the thread once one matches it.
 */
interface Moving {
  readonly agentId: string;
  readonly prefix: string;
  threadId?: string;
  readonly since: number;
  waitMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** How many new thread ids are kept to resolve titles against; the oldest go first. */
const SEEN = 2000;
/** The threads `thread/list` answers with in one page. */
const LIST_PAGE = 50;
/**
 * The most pages a move's first try reads, for a thread the TUI resumed from far back; its
 * retries read only the first, where a thread saved since sorts.
 */
const LIST_PAGES = 40;

export const UNTRACKED = "thread switches are not being tracked";

/**
 * Follows a Codex TUI from thread to thread (foundation-design §5.8, C6). The TUI keeps its
 * terminal's title set to the thread it shows, and the runtime tells the daemon when a title
 * changes: tmux by a hook, a holder by the frame it sends. The title
 * holds at most the id's first 29 characters, so it is resolved against the threads the
 * app-server has announced, then against its thread list, for one from before Bazhen connected.
 * Only exactly one match moves the agent: several, or a title that is no thread id, leaves it on
 * its thread. A thread `/new` starts is listed, and can be resumed, only once its first prompt
 * saves it, and its announcement reaches only the clients connected then, not a daemon that was
 * down. So a title that matches nothing, or names a thread that can't be resumed yet, is a move
 * that waits: tried again with backoff for as long as the title still names it, sooner when a
 * thread it names is announced, and given up after a while. The agent's new mail is held
 * meanwhile, since it would otherwise go to a thread the user no longer sees. A thread another
 * running agent is bound to is never moved onto. Mail and approvals follow the binding without
 * more work.
 */
export class CodexThreads {
  private readonly opts: CodexThreadsOptions;
  private readonly log: (message: string) => void;
  private readonly seen = new Set<string>();
  /** Terminals waiting to move their agent to the thread their title names. */
  private readonly moving = new Map<TerminalId, Moving>();
  /**
   * Terminals a TUI is started in again, whose title may still be the last TUI's: a respawn
   * keeps the terminal, and a TUI that was killed never empties its title. Their title says the
   * new TUI is up only once a change to it has been heard.
   */
  private readonly reused = new Set<TerminalId>();
  /**
   * Terminals whose move was given up on, by the prefix their title named. That title, told again,
   * gets one try that holds no mail: it moves the agent if a thread it names has been announced or
   * listed, and can be resumed, by then. Any other title the terminal reports forgets it.
   */
  private readonly gaveUp = new Map<TerminalId, string>();
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
      for (const [terminal, m] of this.moving) {
        if (id.startsWith(m.prefix)) void this.titleChanged(terminal);
      }
      for (const [terminal, prefix] of this.gaveUp) {
        if (id.startsWith(prefix)) void this.titleChanged(terminal);
      }
    },
  };

  /** Whether an agent's new mail waits, while it is about to move to the thread its TUI shows. */
  held(agentId: string): boolean {
    return (
      this.starting?.has(agentId) === true ||
      [...this.moving.values()].some((m) => m.agentId === agentId)
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

  /** No TUI is starting in `terminal` any more: its respawn was refused, or it is closing. */
  left(terminal: TerminalId): void {
    this.reused.delete(terminal);
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
        const m = this.moving.get(terminal);
        if (m !== undefined) this.later(terminal, m);
      });
    return this.queue;
  }

  private async follow(terminal: TerminalId, told?: string): Promise<void> {
    const { store, runtime } = this.opts;
    const agent = store.codexAgentIn(terminal);
    if (agent === undefined) {
      this.gaveUp.delete(terminal);
      return this.settle(terminal);
    }
    const title = told ?? (await runtime.title(agent.runtime));
    const gaveUpOn = this.gaveUp.get(terminal);
    this.gaveUp.delete(terminal);
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
    const prior = this.moving.get(terminal);
    const waited = prior?.agentId === agent.agentId && prior.prefix === prefix ? prior : undefined;
    let found = matching(prefix, this.seen);
    if (found.length === 0 && waited?.threadId !== undefined) found = [waited.threadId];
    if (found.length === 0)
      found = matching(prefix, await this.listed(waited === undefined ? LIST_PAGES : 1));
    if (found.length > 1) {
      this.settle(terminal);
      return this.untracked(agent.agentId, `${found.length} threads match ${prefix}`);
    }
    const [threadId] = found;
    if (threadId === undefined) {
      if (gaveUpOn === prefix) {
        this.gaveUp.set(terminal, prefix);
        return this.settle(terminal);
      }
      if (waited === undefined)
        this.log(`codex: no thread matches ${prefix} yet; agent ${agent.agentId} waits to move`);
      return this.later(terminal, this.move(terminal, agent.agentId, prefix));
    }
    // One thread, one agent: a /resume of another agent's thread is not a move.
    if (store.codexAgentsOn(threadId).some((id) => id !== agent.agentId)) {
      this.settle(terminal);
      return this.untracked(agent.agentId, `thread ${threadId} is another agent's`);
    }
    // Subscribe first, so nothing the thread sends after the move is missed.
    const subscribed =
      gaveUpOn === prefix
        ? await this.resumedOnce(terminal, prefix, threadId)
        : await this.resumed(this.move(terminal, agent.agentId, prefix), terminal, threadId);
    if (!subscribed) return;
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
   * The terminal's move to the thread `prefix` names: the one it was waiting on, if it named the
   * same, so its backoff and give-up time go on; a new one otherwise, with a give-up time of its
   * own, as a title naming one unsaved `/new` after another gets.
   */
  private move(terminal: TerminalId, agentId: string, prefix: string): Moving {
    const prior = this.moving.get(terminal);
    if (prior?.agentId === agentId && prior.prefix === prefix) return prior;
    const m: Moving = { agentId, prefix, since: Date.now(), waitMs: this.opts.retryMs ?? 500 };
    this.moving.set(terminal, m);
    if (prior !== undefined) {
      clearTimeout(prior.timer);
      if (prior.agentId !== agentId) this.opts.released?.(prior.agentId);
    }
    return m;
  }

  /**
   * Resumes the thread a terminal's title names; false while it waits. One the server can't load
   * yet, as a `/new` before its first prompt, is tried again later.
   */
  private async resumed(m: Moving, terminal: TerminalId, threadId: string): Promise<boolean> {
    m.threadId = threadId;
    try {
      await this.opts.channel.resume(threadId);
      return true;
    } catch (err) {
      this.log(`codex: thread ${threadId} can't be resumed yet: ${String(err)}`);
      this.later(terminal, m);
      return false;
    }
  }

  /** One resume of a thread whose move was given up on; false, holding nothing, if it fails. */
  private async resumedOnce(terminal: TerminalId, prefix: string, threadId: string) {
    try {
      await this.opts.channel.resume(threadId);
      return true;
    } catch (err) {
      this.log(`codex: thread ${threadId} still can't be resumed: ${String(err)}`);
      this.gaveUp.set(terminal, prefix);
      return false;
    }
  }

  /**
   * Follows the terminal again after a wait, or, past the give-up time, leaves the agent on its
   * thread and lets its held mail go there.
   */
  private later(terminal: TerminalId, m: Moving): void {
    if (Date.now() - m.since >= (this.opts.giveUpMs ?? RESUME_GIVE_UP_MS)) {
      this.settle(terminal);
      this.gaveUp.set(terminal, m.prefix);
      const why =
        m.threadId === undefined
          ? `no thread matches ${m.prefix}`
          : `thread ${m.threadId} could not be resumed`;
      return this.untracked(m.agentId, why);
    }
    clearTimeout(m.timer);
    m.timer = setTimeout(() => void this.titleChanged(terminal), m.waitMs);
    m.timer.unref();
    m.waitMs = Math.min(m.waitMs * 2, RESUME_MAX_MS);
  }

  /** The terminal waits to move no longer: its agent's held mail may go. */
  private settle(terminal: TerminalId): void {
    const m = this.moving.get(terminal);
    if (m === undefined) return;
    clearTimeout(m.timer);
    this.moving.delete(terminal);
    this.opts.released?.(m.agentId);
  }

  /**
   * The threads the server lists in up to `pages` pages, newest first; those it listed before it
   * failed, if it does.
   */
  private async listed(pages: number): Promise<string[]> {
    const threads: string[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < pages; page++) {
        const params = { limit: LIST_PAGE, ...(cursor !== null && { cursor }) };
        const answer = readThreadList(await this.opts.channel.request("thread/list", params));
        threads.push(...answer.threads);
        cursor = answer.nextCursor;
        if (cursor === null) break;
      }
    } catch (err) {
      this.log(`codex: could not list threads: ${String(err)}`);
    }
    return threads;
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
