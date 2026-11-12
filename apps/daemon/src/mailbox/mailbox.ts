import { newId, type AgentSessionId, type MessageId } from "@bazhen/core";
import {
  SendMessageResponse,
  type EventPayload,
  type HookReply,
  type SendMessageRequest,
} from "@bazhen/protocol";
import { wakeText } from "@bazhen/harness-claude-code";
import type { Store } from "../store/store.ts";

/** A reply that lets the hook go with no effect on the harness. */
export const QUIET: HookReply = { exitCode: 0, stdout: "", stderr: "", offered: [] };

/** How long the hook client has to write what it was handed and ack it. */
const ACK_DEADLINE_MS = 10_000;

/** A message for an agent this daemon doesn't know, or one with no way to take mail. */
export class UnknownAgent extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`no agent ${agentId} that takes mail`);
    this.agentId = agentId;
  }
}

type Step =
  | "mailbox.offered"
  | "mailbox.emitted"
  | "mailbox.seen"
  | "mailbox.delivered"
  | "mailbox.requeued";

/**
 * Claude Code's mail, delivered at least once through its own hooks and never typed
 * (foundation-design §4.7, §5.6). One waiter per agent holds the hook that wakes an idle session;
 * a message is offered to it, written by the hook client, seen in the prompt that carries its id,
 * and delivered when that prompt's turn stops.
 */
export class Mailbox {
  private readonly store: Store;
  private readonly ackDeadlineMs: number;
  private readonly waiters = new Map<string, (reply: HookReply) => void>();
  /** Messages handed to a hook and not yet written, with the agent each is for. */
  private readonly unacked = new Map<
    MessageId,
    { agentId: string; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(store: Store, ackDeadlineMs = ACK_DEADLINE_MS) {
    this.store = store;
    this.ackDeadlineMs = ackDeadlineMs;
  }

  send(agentId: string, req: SendMessageRequest): SendMessageResponse {
    const response = this.store.once(
      req.idempotencyKey,
      { agentId, body: req.body },
      (r) => SendMessageResponse.parse(r),
      () => {
        if (this.store.agent(agentId)?.harness !== "claude-code") throw new UnknownAgent(agentId);
        const messageId = newId("msg");
        const eventId = this.store.append({
          type: "mailbox.queued",
          entityId: messageId,
          actor: "system",
          payload: { agentId, body: req.body },
        });
        return { messageId, eventIds: [eventId] };
      },
    );
    this.offer(agentId);
    return response;
  }

  /**
   * The waiter hook: answered when mail is queued, or at once with nothing when a newer waiter
   * for the same agent replaces it, since Claude Code never reaps old ones and only the newest
   * may hand out mail.
   */
  wait(agentId: AgentSessionId, signal: AbortSignal): Promise<HookReply> {
    this.waiters.get(agentId)?.(QUIET);
    return new Promise((resolve) => {
      const release = (reply: HookReply) => {
        if (this.waiters.get(agentId) === release) this.waiters.delete(agentId);
        resolve(reply);
      };
      this.waiters.set(agentId, release);
      signal.addEventListener("abort", () => release(QUIET));
      this.offer(agentId);
    });
  }

  /** The hook client wrote what it was handed. */
  ack(offered: readonly string[]): void {
    for (const [id, { timer }] of this.unacked) {
      if (!offered.includes(id)) continue;
      clearTimeout(timer);
      this.unacked.delete(id);
      this.record("mailbox.emitted", id, {});
    }
  }

  /** A wake's prompt carries each message's id: those messages have been seen. */
  promptStarted(agentId: string, prompt: string, promptId: string | null): void {
    if (promptId === null) return;
    for (const m of this.store.mail(agentId, ["emitted"])) {
      if (prompt.includes(m.id)) this.record("mailbox.seen", m.id, { promptId });
    }
  }

  /** The turn that saw a message has stopped: it is delivered. */
  turnEnded(agentId: string, promptId: string | null): void {
    for (const m of this.store.mail(agentId, ["seen"])) {
      if (m.promptId === promptId) this.record("mailbox.delivered", m.id, {});
    }
  }

  /** The hooks holding mail died with the daemon's socket (§7 step 2). */
  requeueInFlight(): void {
    for (const { id, agentId } of this.store.inFlight())
      this.requeue(agentId, id, "daemon_restart");
  }

  private offer(agentId: string): void {
    const waiter = this.waiters.get(agentId);
    const queued = this.store.mail(agentId, ["queued"]);
    if (waiter === undefined || queued.length === 0) return;
    this.store.transaction(() => {
      for (const m of queued) this.record("mailbox.offered", m.id, {});
    });
    for (const m of queued) {
      const timer = setTimeout(
        () => this.requeue(agentId, m.id, "not_written"),
        this.ackDeadlineMs,
      );
      this.unacked.set(m.id, { agentId, timer });
    }
    waiter({ exitCode: 2, stdout: "", stderr: wakeText(queued), offered: queued.map((m) => m.id) });
  }

  /** Back to the queue, and straight to a waiter if one is already waiting. */
  private requeue(
    agentId: string,
    id: MessageId,
    reason: EventPayload<"mailbox.requeued">["reason"],
  ): void {
    this.unacked.delete(id);
    this.record("mailbox.requeued", id, { reason });
    this.offer(agentId);
  }

  private record<T extends Step>(type: T, id: MessageId, payload: EventPayload<T>): number {
    return this.store.append({ type, entityId: id, actor: "system", payload });
  }
}
