import { newId, type AttentionId } from "@bazhen/core";
import {
  DismissAttentionResponse,
  EVENTS,
  ReplyAttentionResponse,
  ResendAttentionResponse,
  type AttentionAction,
  type AttentionKind,
  type DismissAttentionRequest,
  type EventPayload,
  type ReplyAttentionRequest,
  type ResendAttentionRequest,
  type SendMessageRequest,
  type SendMessageResponse,
} from "@bazhen/protocol";
import { AttentionClosed, type Approvals } from "../mailbox/approvals.ts";
import type { Recorded } from "../store/projections.ts";
import { UnknownAgent, type OpenAttention, type Store } from "../store/store.ts";

/** An action the item doesn't offer, such as dismissing an approval its harness waits on. */
export class AttentionRefused extends Error {
  readonly attentionId: string;
  readonly action: AttentionAction;

  constructor(attentionId: string, action: AttentionAction) {
    super(`attention item ${attentionId} can't be answered with ${action}`);
    this.attentionId = attentionId;
    this.action = action;
  }
}

/** What an agent or its task raises for the human (foundation-design §4.6). */
export interface Raised {
  readonly agentId: string;
  readonly kind: Extract<AttentionKind, "escalation" | "task_done">;
  readonly summary: string;
  readonly taskId?: string;
}

/** Kinds a harness request stands behind: only that request, or the TUI, settles them. */
const HARNESS_HELD: ReadonlySet<AttentionKind> = new Set(["approval", "question"]);

const parseReply = (r: unknown) => ReplyAttentionResponse.parse(r);

/** Agents that are gone for good: mail can't reach them, so a reply can't either. */
const GONE = new Set(["closing", "closed", "failed"]);

/**
 * The attention queue beyond approvals (foundation-design §4.6, §4.7): a failed turn, mail
 * given up on, and what an agent or a task raises. Undelivered mail opens its item in the
 * transaction that gives it up. A failed turn is the harness's own report of the agent's turn,
 * never an activity signal, which a subagent's work or a daemon restart moves too. The human
 * replies, which reaches the agent as mail, sends undelivered mail again, or dismisses;
 * approvals stay `Approvals`'s to answer.
 */
export class Inbox {
  private readonly store: Store;
  private readonly approvals: Approvals;
  private readonly send: (agentId: string, req: SendMessageRequest) => SendMessageResponse;

  constructor(
    store: Store,
    approvals: Approvals,
    send: (agentId: string, req: SendMessageRequest) => SendMessageResponse,
  ) {
    this.store = store;
    this.approvals = approvals;
    this.send = send;
  }

  /** Opens and closes items as the events that cause them are recorded; returns the stop function. */
  follow(): () => void {
    return this.store.react((e) => this.react(e));
  }

  raise(raised: Raised): AttentionId {
    if (this.store.agent(raised.agentId) === undefined) throw new UnknownAgent(raised.agentId);
    const about = raised.taskId === undefined ? {} : { taskId: raised.taskId };
    return this.open(raised.agentId, raised.kind, raised.summary, about);
  }

  /** What the human can do about an open item now. */
  actions(item: OpenAttention): AttentionAction[] {
    if (item.kind === "approval") {
      return this.approvals.canAnswer(item.id) ? ["allow", "deny"] : [];
    }
    if (item.kind === "question") return [];
    const state = this.store.agent(item.agentId)?.state;
    if (state === undefined || GONE.has(state)) return ["dismiss"];
    return item.kind === "undeliverable" ? ["reply", "resend", "dismiss"] : ["reply", "dismiss"];
  }

  /** The agent's own turn failed, as its harness reports it: one item while turns keep failing. */
  turnFailed(agentId: string, error: string | null): void {
    if (this.openOf(agentId, "failed").length > 0) return;
    this.open(agentId, "failed", error ?? "A turn failed", {});
  }

  /** The agent started a turn of its own, so the failure before it no longer holds it up. */
  turnStarted(agentId: string): void {
    for (const item of this.openOf(agentId, "failed")) this.close(item.id, "superseded", "system");
  }

  // The mail goes in the same transaction as the close, so a crash between them can't leave a
  // reply sent and its item open, or the item closed with nothing sent.
  reply(id: string, req: ReplyAttentionRequest): ReplyAttentionResponse {
    return this.store.once(
      req.idempotencyKey,
      { attention: id, reply: req.body },
      parseReply,
      () => {
        const item = this.offering(id, "reply");
        const sent = this.send(item.agentId, {
          idempotencyKey: `reply:${req.idempotencyKey}`,
          body: req.body,
        });
        return {
          messageId: sent.messageId,
          eventIds: [...sent.eventIds, this.close(item.id, "replied", "user")],
        };
      },
    );
  }

  resend(id: string, req: ResendAttentionRequest): ResendAttentionResponse {
    return this.store.once(req.idempotencyKey, { attention: id, resend: true }, parseReply, () => {
      const item = this.offering(id, "resend");
      const body = this.store
        .mail(item.agentId, ["undeliverable"])
        .find((m) => m.id === item.messageId)?.body;
      if (body === undefined) throw new AttentionRefused(id, "resend");
      const sent = this.send(item.agentId, {
        idempotencyKey: `resend:${req.idempotencyKey}`,
        body,
      });
      return {
        messageId: sent.messageId,
        eventIds: [...sent.eventIds, this.close(item.id, "resent", "user")],
      };
    });
  }

  dismiss(id: string, req: DismissAttentionRequest): DismissAttentionResponse {
    return this.store.once(
      req.idempotencyKey,
      { attention: id, dismiss: true },
      (r) => DismissAttentionResponse.parse(r),
      () => ({ eventIds: [this.close(this.offering(id, "dismiss").id, "dismissed", "user")] }),
    );
  }

  /** The open item, if it offers `action` now. */
  private offering(id: string, action: AttentionAction): OpenAttention {
    const item = this.store.openAttention().find((i) => i.id === id);
    if (item === undefined) throw new AttentionClosed(id);
    if (!this.actions(item).includes(action)) throw new AttentionRefused(id, action);
    return item;
  }

  private react(e: Recorded): void {
    if (e.type === "mailbox.undeliverable") {
      // Mail for an agent that closed goes with it; the close already says so.
      if (EVENTS[e.type].payload.parse(e.payload).reason !== "gave_up") return;
      const agentId = this.store.messageAgent(e.entityId);
      if (agentId === undefined) return;
      this.open(agentId, "undeliverable", "A message could not be delivered", {
        messageId: e.entityId,
      });
    } else if (e.type === "agent.closed") {
      for (const item of this.store.openAttention(e.entityId)) {
        if (!HARNESS_HELD.has(item.kind)) this.close(item.id, "agent_closed", "system");
      }
    }
  }

  private openOf(agentId: string, kind: AttentionKind): OpenAttention[] {
    return this.store.openAttention(agentId).filter((i) => i.kind === kind);
  }

  private open(
    agentId: string,
    kind: AttentionKind,
    summary: string,
    about: { taskId?: string; messageId?: string },
  ): AttentionId {
    const id = newId("attn");
    this.store.append({
      type: "attention.opened",
      entityId: id,
      actor: "system",
      payload: { agentId, summary, toolUseId: null, mainAgent: true, kind, ...about },
    });
    return id;
  }

  private close(
    id: AttentionId,
    reason: EventPayload<"attention.closed">["reason"],
    actor: "user" | "system",
  ): number {
    return this.store.append({
      type: "attention.closed",
      entityId: id,
      actor,
      payload: { reason },
    });
  }
}
