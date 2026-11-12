import type { MailboxState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

/**
 * - `offer`: a waiter or a PostToolUse hook takes the message; `ack`: the hook client wrote it.
 * - `seen`: a wake's UserPromptSubmit carried its id; `confirm`: the receiving turn's Stop, or,
 *   for Codex, the turn that carries its label.
 * - `accept`: `codex queue` stored it, with or without a live app-server; only the turn that
 *   carries it delivers it, and that turn may start before the queue command has returned.
 */
export type MailboxEvent =
  | "offer"
  | "ack"
  | "seen"
  | "confirm"
  | "accept"
  | "requeue"
  | "give_up"
  | "agent_closed";

// Delivery is at least once; a delivered message is final, so it is never offered again
// (foundation-design §4.7, §5.6).
export const mailbox = machine<MailboxState, MailboxEvent>("mailbox message", {
  queued: {
    offer: "offered",
    accept: "queued_in_codex",
    confirm: "delivered",
    give_up: "undeliverable",
    agent_closed: "undeliverable",
  },
  offered: { ack: "emitted", requeue: "queued", agent_closed: "undeliverable" },
  emitted: { seen: "seen", confirm: "delivered", requeue: "queued", agent_closed: "undeliverable" },
  seen: { confirm: "delivered", requeue: "queued", agent_closed: "undeliverable" },
  queued_in_codex: { confirm: "delivered", agent_closed: "undeliverable" },
  delivered: {},
  undeliverable: {},
});
