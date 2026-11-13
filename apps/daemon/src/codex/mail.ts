import { isId, type MessageId } from "@bazhen/core";
import { messageText, queueArgs, readUserMessage } from "@bazhen/harness-codex";
import type { EventPayload } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";
import type { ChannelListener } from "./channel.ts";

export interface CodexMailOptions {
  readonly store: Store;
  /** The app-server, as `codex queue --remote` reaches it. */
  readonly remote: string;
  /** Runs the Codex CLI with these arguments, in the agents' environment, with a time limit. */
  readonly codex: (args: readonly string[]) => Promise<unknown>;
  readonly log?: (message: string) => void;
  /** The wait after a failed attempt; it doubles for the next. */
  readonly retryMs?: number;
  /**
   * Whether an agent's mail waits for now, as while its TUI shows a thread it isn't bound to
   * yet; `deliverQueued` hands it over once that ends.
   */
  readonly held?: (agentId: string) => boolean;
}

/** Attempts to hand a message to Codex before it is given up as undeliverable (§12). */
const ATTEMPTS = 3;

/**
 * Mail for Codex agents, through `codex queue` (foundation-design §5.8): to the app-server, which
 * wakes an idle thread or waits for the turn boundary, or, with none up, into the Codex home,
 * which holds it until one comes up. Either way the queue only stores it, so the message waits
 * as queued in Codex, and is delivered once a turn is seen taking it as its input.
 */
export class CodexMail {
  private readonly opts: CodexMailOptions;
  private readonly log: (message: string) => void;
  /** Messages being handed over: one attempt at a time each. */
  private readonly sending = new Set<string>();

  constructor(opts: CodexMailOptions) {
    this.opts = opts;
    this.log = opts.log ?? console.warn;
  }

  /**
   * Hands a queued message to its agent's thread, trying again with backoff, and gives it up as
   * undeliverable after the last attempt. One no longer queued is left alone.
   */
  async deliver(messageId: string, agentId: string): Promise<void> {
    if (this.sending.has(messageId)) return;
    this.sending.add(messageId);
    try {
      for (let attempt = 1; ; attempt++) {
        const message = this.queued(messageId, agentId);
        const threadId = this.opts.store.codexThread(agentId);
        if (message === undefined || threadId === undefined) return;
        // Still queued: it goes once the hold ends, to the thread the agent is bound to then.
        if (this.opts.held?.(agentId) === true) return;
        const offline = await this.queue(threadId, messageText(message.id, message.body));
        // A turn carrying it may have started, and confirmed it, before the queue returned.
        if (this.queued(messageId, agentId) === undefined) return;
        if (offline !== undefined) return this.record(message.id, "mailbox.accepted", { offline });
        if (attempt === ATTEMPTS) {
          return this.record(message.id, "mailbox.undeliverable", { reason: "gave_up" });
        }
        const wait = (this.opts.retryMs ?? 1000) * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    } finally {
      this.sending.delete(messageId);
    }
  }

  /** Hands over every message still queued for an agent, as once a hold on its mail ends. */
  deliverQueued(agentId: string): void {
    for (const m of this.opts.store.mail(agentId, ["queued"])) void this.deliver(m.id, agentId);
  }

  /** Confirms a message once a turn takes it as its input, whether or not the queue has returned. */
  readonly listener: Pick<ChannelListener, "notification" | "resumed"> = {
    /**
     * A connection resumed these threads, so the turns that take their mail will be seen: hand
     * over again every message still queued for them, as after a daemon restart that stopped a
     * hand-over. At least once, as for Claude Code (§7 step 2); one stored in Codex already is
     * left there.
     */
    resumed: (threads) => {
      for (const threadId of threads) {
        const agentId = this.opts.store.codexAgent(threadId);
        if (agentId === undefined) continue;
        this.deliverQueued(agentId);
      }
    },
    notification: (method, params) => {
      const input = readUserMessage(method, params);
      // Most turns carry no message of Bazhen's, and cost no query.
      if (input === null || input.messageId === null) return;
      // By the message, not by the thread. On the agent's own thread a turn may take it before
      // the queue has returned. One queued in Codex on a thread the agent has since moved off is
      // still taken there, so a thread no agent is on confirms one Codex holds. A thread another
      // agent is on confirms nothing of this one's, whatever its turn quotes.
      const { messageId, threadId } = input;
      if (!isId("msg", messageId)) return;
      const message = this.opts.store.codexMessageAgent(messageId);
      if (message === undefined) return;
      const owners = this.opts.store.codexAgentsOn(threadId);
      const own = owners.length === 1 && owners[0] === message.agentId;
      if (own || (owners.length === 0 && message.inCodex)) {
        this.record(messageId, "mailbox.delivered", {});
      }
    },
  };

  private queued(messageId: string, agentId: string) {
    return this.opts.store.mail(agentId, ["queued"]).find((m) => m.id === messageId);
  }

  /**
   * Stores the message in Codex: on the app-server, else in the Codex home. Says which, or
   * undefined if neither took it.
   */
  private async queue(threadId: string, text: string): Promise<boolean | undefined> {
    for (const to of [this.opts.remote, null]) {
      try {
        await this.opts.codex(queueArgs(threadId, text, to));
        return to === null;
      } catch (err) {
        this.log(`codex queue to ${to ?? "the Codex home"} failed: ${String(err)}`);
      }
    }
    return undefined;
  }

  private record<T extends "mailbox.accepted" | "mailbox.delivered" | "mailbox.undeliverable">(
    id: MessageId,
    type: T,
    payload: EventPayload<T>,
  ): void {
    this.opts.store.append({ type, entityId: id, actor: "system", payload });
  }
}
