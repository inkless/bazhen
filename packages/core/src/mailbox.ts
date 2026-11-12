import { machine } from "./machine.ts";

export type MailboxState =
  | "queued"
  | "offered"
  | "emitted"
  | "seen"
  | "queued_in_codex"
  | "delivered"
  | "undeliverable";

/**
 * - `offer`: a waiter or a PostToolUse hook takes the message; `ack`: the hook client wrote it.
 * - `seen`: a wake's UserPromptSubmit carried its id; `confirm`: the receiving turn's Stop, or,
 *   for Codex, the turn that carries its label.
 * - `accept` / `accept_offline`: `codex queue` took it with or without a live app-server.
 */
export type MailboxEvent =
  | "offer"
  | "ack"
  | "seen"
  | "confirm"
  | "accept"
  | "accept_offline"
  | "requeue"
  | "give_up"
  | "agent_closed";

// Delivery is at least once; a delivered message is final, so it is never offered again
// (foundation-design §4.7, §5.6).
export const mailbox = machine<MailboxState, MailboxEvent>("mailbox message", {
  queued: {
    offer: "offered",
    accept: "delivered",
    accept_offline: "queued_in_codex",
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
