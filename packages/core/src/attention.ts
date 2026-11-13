import type { AttentionCloseReason, AttentionState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

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
    replied: "closed",
    dismissed: "closed",
    resent: "closed",
  },
  closed: {},
});
