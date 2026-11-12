import { isId, newId, type AttentionId } from "@bazhen/core";
import {
  AnswerAttentionResponse,
  type AnswerAttentionRequest,
  type EventPayload,
  type HookReply,
} from "@bazhen/protocol";
import { APPROVAL_WAIT_MS, approvalReply, isMainAgentTool } from "@bazhen/harness-claude-code";
import type { OpenAttention, Store } from "../store/store.ts";
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
  /** Each agent's tool calls that have started, have no request yet and haven't finished. */
  private readonly started = new Map<string, { tool: string; useId: string }[]>();

  constructor(store: Store, waitMs = APPROVAL_WAIT_MS) {
    this.store = store;
    this.waitMs = waitMs;
  }

  /** A tool call is about to run; a permission request for it may follow. */
  toolStarted(agentId: string, tool: string, useId: string): void {
    this.started.set(agentId, [...(this.started.get(agentId) ?? []), { tool, useId }]);
  }

  request(agentId: string, summary: string, tool: string, signal: AbortSignal): Promise<HookReply> {
    const id = newId("attn");
    this.store.append({
      type: "attention.opened",
      entityId: id,
      actor: "system",
      payload: {
        agentId,
        summary,
        toolUseId: this.claim(agentId, tool),
        mainAgent: isMainAgentTool(tool),
      },
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
  toolSettled(agentId: string, useId: string): void {
    this.keepStarted(agentId, (c) => c.useId !== useId);
    this.settleWhere(agentId, (item) => item.toolUseId === useId);
  }

  /**
   * The agent's turn ended: its own requests are over. A subagent's may outlive the turn, so
   * they wait for their own result.
   */
  turnEnded(agentId: string): void {
    this.keepStarted(agentId, (c) => !isMainAgentTool(c.tool));
    this.settleWhere(agentId, (item) => item.mainAgent);
  }

  /**
   * The call a request is for: the earliest started one with the same key that has no request
   * yet, so identical calls made in parallel are matched in the order they started.
   */
  private claim(agentId: string, tool: string): string | null {
    const calls = this.started.get(agentId) ?? [];
    const call = calls.find((c) => c.tool === tool);
    if (call === undefined) return null;
    this.keepStarted(agentId, (c) => c !== call);
    return call.useId;
  }

  private keepStarted(agentId: string, keep: (call: { tool: string; useId: string }) => boolean) {
    const calls = (this.started.get(agentId) ?? []).filter(keep);
    if (calls.length === 0) this.started.delete(agentId);
    else this.started.set(agentId, calls);
  }

  private settleWhere(agentId: string, matches: (item: OpenAttention) => boolean): void {
    for (const item of this.store.openAttention(agentId)) {
      if (!matches(item)) continue;
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
