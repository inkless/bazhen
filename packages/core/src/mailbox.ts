import type { MailboxState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

/**
 * - `offer`: a waiter or a PostToolUse hook takes the message; `ack`: the hook client wrote it.
 * - `seen`: a wake's UserPromptSubmit carried its id; `confirm`: the receiving turn's Stop, or,
 *   for Codex, the turn that carries its label. A wake held back (a dialog open in the TUI) can
 *   land after its message went back to the queue or out again: its prompt still means the
 *   agent has it, so it is seen from those states too, and never offered again.
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
    seen: "seen",
    give_up: "undeliverable",
    agent_closed: "undeliverable",
  },
  offered: { ack: "emitted", seen: "seen", requeue: "queued", agent_closed: "undeliverable" },
  emitted: { seen: "seen", confirm: "delivered", requeue: "queued", agent_closed: "undeliverable" },
  seen: { confirm: "delivered", requeue: "queued", agent_closed: "undeliverable" },
  queued_in_codex: { confirm: "delivered", agent_closed: "undeliverable" },
  delivered: {},
  undeliverable: {},
});

const LABEL_PREFIX = "Message for you from Bazhen (";

/**
 * How Bazhen introduces a message to an agent. A harness confirms a message by finding its label
 * in the turn that took it, so a label must only ever be one Bazhen wrote: see `quoteLabels`.
 */
export const mailLabel = (id: string) => `${LABEL_PREFIX}${id}):`;

/**
 * A body as an agent reads it, with every label it quotes marked as a quote. Marking the prefix
 * rather than whole labels catches every label whatever id it names, so a quoted one can neither
 * confirm another message nor pass for one to the agent. The stored body keeps what was written.
 */
export const quoteLabels = (body: string) =>
  body.replaceAll(LABEL_PREFIX, "Message for you from Bazhen [quoted] (");

/** The id of the message `text` starts with, labelled as Bazhen labels it, or null. */
export function leadingMailId(text: string): string | null {
  if (!text.startsWith(LABEL_PREFIX)) return null;
  return /^(msg_[0-9a-zA-Z]+)\):\n/.exec(text.slice(LABEL_PREFIX.length))?.[1] ?? null;
}
