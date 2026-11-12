import { machine } from "./machine.ts";

export type AttentionState = "open" | "closed";

/** Why an attention item closed (foundation-design §4.6, §5.6, §5.8). */
export type AttentionCloseReason =
  | "answered"
  | "answered_in_tui"
  | "timed_out"
  | "superseded"
  | "agent_closed"
  | "stale";

// Every close is final, so an answer that arrives after any of them is refused rather than
// applied to a request that no longer exists (foundation-design §5.6, §5.8).
export const attention = machine<AttentionState, AttentionCloseReason>("attention item", {
  open: {
    answered: "closed",
    answered_in_tui: "closed",
    timed_out: "closed",
    superseded: "closed",
    agent_closed: "closed",
    stale: "closed",
  },
  closed: {},
});
