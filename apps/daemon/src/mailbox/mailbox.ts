import { randomBytes } from "node:crypto";
import { newId, type AgentSessionId, type MessageId } from "@bazhen/core";
import {
  HOOK_REPLY_MAX_BYTES,
  SendMessageResponse,
  offerToken,
  type OfferToken,
  type EventPayload,
  type HookReply,
  type SendMessageRequest,
} from "@bazhen/protocol";
import { wakeText } from "@bazhen/harness-claude-code";
import { UnknownAgent, type Store } from "../store/store.ts";

/** A reply that lets the hook go with no effect on the harness. */
export const QUIET: HookReply = { exitCode: 0, stdout: "", stderr: "", offered: [] };

/** How long the hook client has to write what it was handed and ack it. */
const ACK_DEADLINE_MS = 10_000;

type Step =
  | "mailbox.offered"
  | "mailbox.emitted"
  | "mailbox.seen"
  | "mailbox.delivered"
  | "mailbox.requeued"
  | "mailbox.undeliverable";

/**
 * A message is given up once the agent's side has failed it this often: its first offer, then
 * three re-offers (§5.6, step 5). Only the agent's failures count (`AGENT_FAILURES`), never a
 * daemon restart, a session starting over or a client that didn't write it.
 */
export const MAX_FAILURES = 4;
const AGENT_FAILURES: ReadonlySet<string> = new Set(["stop_failed", "interrupted", "not_seen"]);

/**
 * How long a written wake may go unseen while the agent is idle before it is offered again. Long,
 * since the TUI holds a wake back while a dialog or menu is open; one that lands later is still
 * taken as seen. While a turn is under way the turn boundaries decide, for at most
 * `UNSEEN_TURN_CHECKS` more deadlines, in case the turn's end was never heard.
 */
const UNSEEN_DEADLINE_MS = 10 * 60_000;
const UNSEEN_TURN_CHECKS = 3;

export interface MailboxOptions {
  /** How long the hook client has to write what it was handed and ack it. */
  readonly ackDeadlineMs?: number;
  /** How long a written wake may go unseen while the agent is idle. */
  readonly unseenDeadlineMs?: number;
  /** Hands a queued message to a Codex agent's own queue (foundation-design §5.8). */
  readonly codex?: (messageId: string, agentId: string) => void;
}

/**
 * Mail for agents, never typed. Claude Code's is delivered at least once through its own hooks
 * (foundation-design §4.7, §5.6): one waiter per agent holds the hook that wakes an idle session;
 * a message is offered to it, written by the hook client, seen in the prompt that carries its id,
 * and delivered when that prompt's turn stops. Codex's goes to Codex's own queue (§5.8).
 */
export class Mailbox {
  private readonly store: Store;
  private readonly ackDeadlineMs: number;
  private readonly unseenDeadlineMs: number;
  private readonly codex: MailboxOptions["codex"];
  private readonly waiters = new Map<string, (reply: HookReply) => void>();
  /**
   * Per agent, the prompt id of the turn under way. Claude Code 2.1.322 gives every turn one: a
   * prompt the human types mid-turn carries it too, and a wake that lands mid-turn starts the
   * next turn, after this one's Stop.
   */
  private readonly turns = new Map<string, string>();
  /**
   * Per agent, the prompt id of the last turn heard to end. Two hooks report each end, the Stop
   * report and the waiter that runs beside it, so one lost or timed out still ends the turn, and
   * the second to arrive changes nothing.
   */
  private readonly ended = new Map<string, string>();
  /** Per agent, messages already handed over and unseen when its last turn ended. */
  private readonly unseenAtTurnEnd = new Map<string, Set<MessageId>>();
  /** Each written wake not yet seen, with the timer that offers it again if it stays unseen. */
  private readonly unseen = new Map<MessageId, ReturnType<typeof setTimeout>>();
  /** The agent each handed-over message is for. */
  private readonly owners = new Map<MessageId, string>();
  /** Each message handed to a hook and not yet written: its offer's token, and the timer. */
  private readonly unacked = new Map<
    MessageId,
    { token: OfferToken; timer: ReturnType<typeof setTimeout> }
  >();
  /** Offer ids: this daemon's own prefix, then a count, so no two offers share one. */
  private readonly offerPrefix = randomBytes(4).toString("hex");
  private offers = 0;

  constructor(store: Store, opts: MailboxOptions = {}) {
    this.store = store;
    this.ackDeadlineMs = opts.ackDeadlineMs ?? ACK_DEADLINE_MS;
    this.unseenDeadlineMs = opts.unseenDeadlineMs ?? UNSEEN_DEADLINE_MS;
    this.codex = opts.codex;
  }

  send(agentId: string, req: SendMessageRequest): SendMessageResponse {
    const harness = this.store.agent(agentId)?.harness;
    const routes: Record<string, ((id: string, agent: string) => void) | undefined> = {
      "claude-code": () => this.offer(agentId),
      codex: this.codex,
    };
    const deliver = harness === undefined ? undefined : routes[harness];
    let created = false;
    const response = this.store.once(
      req.idempotencyKey,
      { agentId, body: req.body },
      (r) => SendMessageResponse.parse(r),
      () => {
        if (deliver === undefined) throw new UnknownAgent(agentId, "that takes mail");
        // A Codex agent with no thread has nowhere to take it; the sender hears so now.
        if (harness === "codex" && this.store.codexThread(agentId) === undefined) {
          throw new UnknownAgent(agentId, "bound to a Codex thread");
        }
        const messageId = newId("msg");
        created = true;
        const eventId = this.store.append({
          type: "mailbox.queued",
          entityId: messageId,
          actor: "system",
          payload: { agentId, body: req.body },
        });
        return { messageId, eventIds: [eventId] };
      },
    );
    // A repeat of the same send gets the first answer, and hands nothing over again.
    if (created) deliver?.(response.messageId, agentId);
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

  /**
   * The hook client wrote what it was handed. Only the offer it names is confirmed: an ack from a
   * client whose offer was since taken back and made again confirms nothing.
   */
  ack(offered: readonly OfferToken[]): void {
    for (const [id, { token, timer }] of this.unacked) {
      if (!offered.includes(token)) continue;
      clearTimeout(timer);
      this.unacked.delete(id);
      this.record("mailbox.emitted", id, {});
      const agentId = this.owners.get(id);
      if (agentId !== undefined) this.watchUnseen(agentId, id);
    }
  }

  /**
   * A written wake that never shows up in a prompt, with no turn boundary to say so (a wake
   * Claude Code dropped while idle), goes back to the queue after a deadline. While a turn is
   * under way the turn boundaries decide, so the deadline waits for the turn to end.
   */
  private watchUnseen(agentId: string, id: MessageId, checks = UNSEEN_TURN_CHECKS): void {
    clearTimeout(this.unseen.get(id));
    const timer = setTimeout(() => {
      this.unseen.delete(id);
      if (!this.store.mail(agentId, ["emitted"]).some((m) => m.id === id)) return;
      if (this.turns.has(agentId) && checks > 0) this.watchUnseen(agentId, id, checks - 1);
      else this.requeue(agentId, id, "not_seen");
    }, this.unseenDeadlineMs);
    this.unseen.set(id, timer);
  }

  /**
   * A prompt started. A wake's prompt carries each message's id: those have been seen. A prompt
   * with a new prompt id while a turn is still under way means that turn ended with no Stop or
   * StopFailure, as Esc ends one (or the TUI died): what it saw is requeued (§5.6, step 4).
   */
  promptStarted(agentId: string, prompt: string, promptId: string | null): void {
    if (promptId === null) return;
    const current = this.turns.get(agentId);
    if (current !== undefined && current !== promptId) {
      for (const m of this.store.mail(agentId, ["seen"])) {
        if (m.promptId === current) this.requeue(agentId, m.id, "interrupted");
      }
    }
    this.turns.set(agentId, promptId);
    // Written, or a wake held back past its deadline and since requeued or offered again: the
    // prompt carrying its label means the agent has it, and the re-offer is called off.
    for (const m of this.store.mail(agentId, ["emitted", "queued", "offered"])) {
      if (!prompt.includes(m.id) || m.firstOffered === null) continue;
      clearTimeout(this.unacked.get(m.id)?.timer);
      this.unacked.delete(m.id);
      clearTimeout(this.unseen.get(m.id));
      this.unseen.delete(m.id);
      this.record("mailbox.seen", m.id, { promptId });
    }
  }

  /** Whether this is the second report of a turn's end, and if not, notes the first. */
  private heardEnd(agentId: string, promptId: string | null): boolean {
    if (promptId === null) return false;
    if (this.ended.get(agentId) === promptId) return true;
    this.ended.set(agentId, promptId);
    return false;
  }

  /** A turn stopped: what it saw is delivered. */
  turnEnded(agentId: string, promptId: string | null): void {
    if (this.heardEnd(agentId, promptId)) return;
    this.turns.delete(agentId);
    for (const m of this.store.mail(agentId, ["seen"])) {
      if (m.promptId === promptId) this.record("mailbox.delivered", m.id, {});
    }
    this.turnBoundary(agentId);
  }

  /** A turn ended in an API error instead of a Stop: what it saw goes back. */
  turnFailed(agentId: string, promptId: string | null): void {
    if (this.heardEnd(agentId, promptId)) return;
    this.turns.delete(agentId);
    for (const m of this.store.mail(agentId, ["seen"])) {
      if (m.promptId === promptId) this.requeue(agentId, m.id, "stop_failed");
    }
    this.turnBoundary(agentId);
  }

  /**
   * A message handed over during a turn is woken into the next one, so its prompt comes after
   * that turn ends: one still unseen when a second turn has ended never reached the agent
   * (foundation-design §5.6, step 4).
   */
  private turnBoundary(agentId: string): void {
    const before = this.unseenAtTurnEnd.get(agentId);
    const still = new Set<MessageId>();
    for (const m of this.store.mail(agentId, ["emitted"])) {
      if (before?.has(m.id)) this.requeue(agentId, m.id, "not_seen");
      else still.add(m.id);
    }
    this.unseenAtTurnEnd.set(agentId, still);
  }

  /**
   * The agent's session started over, as /clear, fork or a resume start one: nothing handed over
   * and not yet seen can reach it. The waiter that held it may belong to the old session, so it
   * goes first, and the requeued mail waits for the new session's waiter. Unless the session only
   * compacted, the turn under way is over too, and with it what it saw, as when its TUI died.
   */
  sessionStarted(agentId: string, compacted = false): void {
    this.waiters.get(agentId)?.(QUIET);
    const lost = compacted ? (["offered", "emitted"] as const) : IN_FLIGHT;
    for (const m of this.store.mail(agentId, lost)) {
      this.requeue(agentId, m.id, "session_started");
    }
    if (!compacted) this.turns.delete(agentId);
  }

  /** The hooks holding mail died with the daemon's socket (§7 step 2). */
  requeueInFlight(): void {
    for (const { id, agentId } of this.store.inFlight())
      this.requeue(agentId, id, "daemon_restart");
  }

  private offer(agentId: string): void {
    const waiter = this.waiters.get(agentId);
    if (waiter === undefined) return;
    const queued = fitting(this.store.mail(agentId, ["queued"]));
    if (queued.length === 0) return;
    this.store.transaction(() => {
      for (const m of queued) this.record("mailbox.offered", m.id, {});
    });
    const tokens = queued.map((m) => {
      const token = offerToken(m.id, `${this.offerPrefix}${(++this.offers).toString(36)}`);
      const timer = setTimeout(
        () => this.requeue(agentId, m.id, "not_written"),
        this.ackDeadlineMs,
      );
      this.unacked.set(m.id, { token, timer });
      this.owners.set(m.id, agentId);
      return token;
    });
    waiter({ exitCode: 2, stdout: "", stderr: wakeText(queued), offered: tokens });
  }

  /**
   * Back to the queue, and straight to a waiter if one is already waiting. A message the agent's
   * side has now failed `MAX_FAILURES` times is given up instead (§5.6, step 5).
   */
  private requeue(
    agentId: string,
    id: MessageId,
    reason: EventPayload<"mailbox.requeued">["reason"],
  ): void {
    clearTimeout(this.unacked.get(id)?.timer);
    this.unacked.delete(id);
    clearTimeout(this.unseen.get(id));
    this.unseen.delete(id);
    this.unseenAtTurnEnd.get(agentId)?.delete(id);
    const failed = this.store.mail(agentId, IN_FLIGHT).find((m) => m.id === id)?.failures ?? 0;
    const givesUp = AGENT_FAILURES.has(reason) && failed + 1 >= MAX_FAILURES;
    this.store.transaction(() => {
      this.record("mailbox.requeued", id, { reason });
      if (givesUp) this.record("mailbox.undeliverable", id, { reason: "gave_up" });
    });
    if (givesUp) {
      console.error(`bazhen: gave up on ${id} for ${agentId} after ${MAX_FAILURES} failed offers`);
    }
    this.offer(agentId);
  }

  private record<T extends Step>(type: T, id: MessageId, payload: EventPayload<T>): number {
    return this.store.append({ type, entityId: id, actor: "system", payload });
  }
}

const IN_FLIGHT = ["offered", "emitted", "seen"] as const;

/** A wake's offered IDs travel in a header, which clients cap; this keeps it to a few KB. */
const MAX_WAKE_MESSAGES = 100;

/**
 * The oldest messages whose wake fits one hook reply: a client refuses a larger one, which would
 * hold back all of them. The rest stay queued for the agent's next waiter. One message always fits,
 * since a body is at most 20,000 characters.
 */
function fitting<M extends Parameters<typeof wakeText>[0][number]>(queued: readonly M[]): M[] {
  const fit: M[] = [];
  // Each message's own wake, plus the blank line wakeText puts between two.
  let bytes = -2;
  for (const m of queued.slice(0, MAX_WAKE_MESSAGES)) {
    bytes += Buffer.byteLength(wakeText([m])) + 2;
    if (fit.length > 0 && bytes > HOOK_REPLY_MAX_BYTES) break;
    fit.push(m);
  }
  return fit;
}
