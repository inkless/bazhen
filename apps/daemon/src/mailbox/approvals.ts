import { isId, newId, type AttentionId } from "@bazhen/core";
import {
  AnswerAttentionResponse,
  type AnswerAttentionRequest,
  type EventPayload,
  type HookReply,
} from "@bazhen/protocol";
import { APPROVAL_WAIT_MS, approvalReply } from "@bazhen/harness-claude-code";
import type { Store } from "../store/store.ts";
import { QUIET } from "./mailbox.ts";

/** An answer for an item that is no longer open: it was answered, timed out or went stale. */
export class AttentionClosed extends Error {
  readonly attentionId: string;

  constructor(attentionId: string) {
    super(`attention item ${attentionId} is not open`);
    this.attentionId = attentionId;
  }
}

type CloseReason = EventPayload<"attention.closed">["reason"];

/**
 * A harness asking to run a tool becomes an attention item while its hook waits (§5.6). The
 * first answer wins: the inbox's returns the hook's decision, which dismisses the TUI's prompt;
 * one given in the TUI shows only as the tool running or the turn ending. Past the wait the hook
 * gives up with no decision, so the TUI prompt decides, never an automatic allow.
 */
export class Approvals {
  private readonly store: Store;
  private readonly waitMs: number;
  private readonly pending = new Map<AttentionId, (reply: HookReply) => void>();

  constructor(store: Store, waitMs = APPROVAL_WAIT_MS) {
    this.store = store;
    this.waitMs = waitMs;
  }

  request(agentId: string, summary: string): Promise<HookReply> {
    const id = newId("attn");
    this.store.append({
      type: "attention.opened",
      entityId: id,
      actor: "system",
      payload: { agentId, summary },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.close(id, "timed_out");
        resolve(QUIET);
      }, this.waitMs);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(reply);
      });
    });
  }

  answer(id: string, req: AnswerAttentionRequest): AnswerAttentionResponse {
    const response = this.store.once(
      req.idempotencyKey,
      (r) => AnswerAttentionResponse.parse(r),
      () => {
        if (!isId("attn", id) || !this.store.openAttention().includes(id))
          throw new AttentionClosed(id);
        const eventId = this.record("attention.answered", id, { decision: req.decision });
        return { eventIds: [eventId] };
      },
    );
    if (isId("attn", id)) this.pending.get(id)?.({ ...QUIET, stdout: approvalReply(req.decision) });
    return response;
  }

  /** The tool ran or the turn ended: whatever is still open was answered in the TUI. */
  settled(agentId: string): void {
    for (const id of this.store.openAttention(agentId)) {
      this.pending.get(id)?.(QUIET);
      this.close(id, "answered_in_tui");
    }
  }

  /** The hooks behind open items died with the daemon; their requests are gone. */
  closeAbandoned(): void {
    for (const id of this.store.openAttention()) this.close(id, "stale");
  }

  private close(id: AttentionId, reason: CloseReason): void {
    this.record("attention.closed", id, { reason });
  }

  private record<T extends "attention.answered" | "attention.closed">(
    type: T,
    id: AttentionId,
    payload: EventPayload<T>,
  ): number {
    return this.store.append({ type, entityId: id, actor: "system", payload });
  }
}
