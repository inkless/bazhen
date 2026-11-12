import { isId, newId, type AttentionId } from "@bazhen/core";
import {
  AnswerAttentionResponse,
  type AnswerAttentionRequest,
  type EventPayload,
  type HookReply,
} from "@bazhen/protocol";
import { APPROVAL_WAIT_MS, approvalReply, isMainAgentTool } from "@bazhen/harness-claude-code";
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
 * first answer wins: the inbox's returns the hook's decision, which dismisses the TUI's prompt.
 * One given in the TUI shows only as that tool call's result, or the turn ending; Esc kills the
 * hook. Past the wait the hook gives up with no decision, so the TUI prompt decides, never an
 * automatic allow.
 */
export class Approvals {
  private readonly store: Store;
  private readonly waitMs: number;
  private readonly pending = new Map<AttentionId, (reply: HookReply) => void>();

  constructor(store: Store, waitMs = APPROVAL_WAIT_MS) {
    this.store = store;
    this.waitMs = waitMs;
  }

  request(agentId: string, summary: string, tool: string, signal: AbortSignal): Promise<HookReply> {
    const id = newId("attn");
    this.store.append({
      type: "attention.opened",
      entityId: id,
      actor: "system",
      payload: { agentId, summary, tool },
    });
    return new Promise((resolve) => {
      const settle = (reply: HookReply, reason?: CloseReason) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (reason !== undefined) this.close(id, reason);
        resolve(reply);
      };
      const timer = setTimeout(() => settle(QUIET, "timed_out"), this.waitMs);
      // The hook was killed, as Esc does: the TUI took the request back.
      signal.addEventListener("abort", () => settle(QUIET, "answered_in_tui"));
      this.pending.set(id, settle);
    });
  }

  answer(id: string, req: AnswerAttentionRequest): AnswerAttentionResponse {
    const response = this.store.once(
      req.idempotencyKey,
      { attention: id, decision: req.decision },
      (r) => AnswerAttentionResponse.parse(r),
      () => {
        if (!isId("attn", id) || !this.openIds().includes(id)) throw new AttentionClosed(id);
        const eventId = this.record("attention.answered", id, { decision: req.decision });
        return { eventIds: [eventId] };
      },
    );
    if (isId("attn", id)) this.pending.get(id)?.({ ...QUIET, stdout: approvalReply(req.decision) });
    return response;
  }

  /** That tool call ran or failed: its request, if still open, was answered in the TUI. */
  toolSettled(agentId: string, tool: string): void {
    this.settleWhere(agentId, (t) => t === tool);
  }

  /**
   * The agent's turn ended: its own requests are over. A subagent's may outlive the turn, so
   * they wait for their own result.
   */
  turnEnded(agentId: string): void {
    this.settleWhere(agentId, isMainAgentTool);
  }

  private settleWhere(agentId: string, matches: (tool: string) => boolean): void {
    for (const item of this.store.openAttention(agentId)) {
      if (!matches(item.tool)) continue;
      this.pending.get(item.id)?.(QUIET);
      this.close(item.id, "answered_in_tui");
    }
  }

  private openIds(): AttentionId[] {
    return this.store.openAttention().map((item) => item.id);
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
