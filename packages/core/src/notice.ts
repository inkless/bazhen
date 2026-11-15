import type { NoticeCloseReason, NoticeState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

/** A notice closes once: a dismissal after a revocation, or the reverse, is refused. */
export const notice = machine<NoticeState, NoticeCloseReason>("notice", {
  open: { dismissed: "closed", revoked: "closed" },
  closed: {},
});
