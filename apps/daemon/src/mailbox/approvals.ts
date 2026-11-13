import { isId, newId, type AttentionId } from "@bazhen/core";
import {
  AnswerAttentionResponse,
  type AnswerAttentionRequest,
  type ApprovalDecision,
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

/** An answer for an item whose harness can't take it right now; it may be given again. */
export class AttentionUnavailable extends Error {
  constructor(attentionId: string) {
    super(`attention item ${attentionId} can't be answered while its harness is unreachable`);
  }
}

/** Items a harness request stands behind, which only that request, or the TUI, settles. */
export const isRequest = (item: OpenAttention) =>
  item.kind === "approval" || item.kind === "question";

export type CloseReason = EventPayload<"attention.closed">["reason"];

/** Hands the inbox's decision to the harness, or null when the request ended without one. */
export type Reply = (decision: ApprovalDecision | null) => void;

/**
 * A harness asking to run a tool becomes an attention item while it waits for an answer (§5.6,
 * §5.8). The first answer wins: the inbox's goes to the harness, which dismisses the TUI's
 * prompt; one given in the TUI closes the item, however the harness reports it.
 *
 * Claude Code asks through a hook that waits. One answered in the TUI shows only as that tool
 * call's result, or the turn ending; Esc kills the hook. Past the wait the hook gives up with no
 * decision, so the TUI prompt decides, never an automatic allow.
 */
export class Approvals {
  private readonly store: Store;
  private readonly waitMs: number;
  private readonly pending = new Map<AttentionId, Reply>();
  /** Whether an item's harness can take an answer now; one without is always answerable. */
  private readonly answerable = new Map<AttentionId, () => boolean>();
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

  /** Claude Code's PermissionRequest hook, answered when the inbox decides or the wait ends. */
  request(agentId: string, summary: string, tool: string, signal: AbortSignal): Promise<HookReply> {
    return new Promise((resolve) => {
      const id = this.open(
        agentId,
        summary,
        this.claim(agentId, tool),
        isMainAgentTool(tool),
        (d) => {
          clearTimeout(timer);
          resolve(d === null ? QUIET : { ...QUIET, stdout: approvalReply(d) });
        },
      );
      const timer = setTimeout(() => this.withdraw(id, "timed_out"), this.waitMs);
      // The hook was killed, as Esc does: the TUI took the request back.
      signal.addEventListener("abort", () => this.withdraw(id, "answered_in_tui"), { once: true });
    });
  }

  /**
   * An item for a request the harness holds open itself, such as Codex's approval requests, for
   * the tool call `toolUseId`; `reply` gets the inbox's answer.
   */
  ask(
    agentId: string,
    summary: string,
    toolUseId: string | null,
    reply: Reply,
    answerable: () => boolean,
  ): AttentionId {
    const id = this.open(agentId, summary, toolUseId, true, reply);
    this.answerable.set(id, answerable);
    return id;
  }

  /** The request behind an item ended without the inbox's answer, for `reason`. */
  withdraw(id: AttentionId, reason: CloseReason): void {
    const reply = this.take(id);
    // An item answered or closed already stays as it is.
    if (reply === undefined && !this.openIds().includes(id)) return;
    this.close(id, reason);
    reply?.(null);
  }

  private open(
    agentId: string,
    summary: string,
    toolUseId: string | null,
    mainAgent: boolean,
    reply: Reply,
  ): AttentionId {
    const id = newId("attn");
    this.store.append({
      type: "attention.opened",
      entityId: id,
      actor: "system",
      payload: { agentId, summary, toolUseId, mainAgent, kind: "approval" },
    });
    this.pending.set(id, reply);
    return id;
  }

  /** Whether an answer to the item would reach the harness now. */
  canAnswer(id: AttentionId): boolean {
    return this.pending.has(id) && this.answerable.get(id)?.() !== false;
  }

  answer(id: string, req: AnswerAttentionRequest): AnswerAttentionResponse {
    const response = this.store.once(
      req.idempotencyKey,
      { attention: id, decision: req.decision },
      (r) => AnswerAttentionResponse.parse(r),
      () => {
        if (!isId("attn", id) || !this.openIds().includes(id)) throw new AttentionClosed(id);
        if (this.answerable.get(id)?.() === false) throw new AttentionUnavailable(id);
        const eventId = this.record("attention.answered", id, { decision: req.decision });
        return { eventIds: [eventId] };
      },
    );
    if (isId("attn", id)) this.take(id)?.(req.decision);
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
      if (isRequest(item) && matches(item)) this.withdraw(item.id, "answered_in_tui");
    }
  }

  /**
   * The hooks behind open requests died with the daemon; their requests are gone. Items no
   * request stands behind, such as a failure, still need the human.
   */
  closeAbandoned(): void {
    for (const item of this.store.openAttention()) {
      if (isRequest(item)) this.close(item.id, "stale");
    }
  }

  /** The reply still waiting for an item's answer, which only the first answer gets. */
  private take(id: AttentionId): Reply | undefined {
    const reply = this.pending.get(id);
    this.pending.delete(id);
    this.answerable.delete(id);
    return reply;
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
