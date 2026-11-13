import type { Store } from "../store/store.ts";
import type { AttachmentLog } from "./hub.ts";

/** Attachments and leases are evented for audit; payloads carry no terminal bytes (§4.2, §9.1). */
export function storeLog(store: Store): AttachmentLog {
  return {
    theme: (terminal) => store.terminalTheme(terminal),
    started: (attachment, terminalId, mode) =>
      void store.append({
        type: "attachment.started",
        entityId: attachment,
        actor: "system",
        payload: { terminalId, mode },
      }),
    ended: (attachment, reason) =>
      void store.append({
        type: "attachment.ended",
        entityId: attachment,
        actor: "system",
        payload: { reason },
      }),
    granted: (terminalId, attachmentId, epoch) =>
      void store.append({
        type: "lease.granted",
        entityId: terminalId,
        actor: "system",
        payload: { attachmentId, epoch },
      }),
    epoch: (terminalId) => store.leaseEpoch(terminalId),
    closing: (terminalId) => {
      const state = store.terminalState(terminalId);
      return state === "closing" || state === "closed";
    },
  };
}

/**
 * At boot no browser is attached any more: every attachment left open is ended, which releases
 * its lease, and browsers reattach for a fresh screen (foundation-design §7 step 2).
 */
export function endOpenAttachments(store: Store): void {
  const log = storeLog(store);
  for (const id of store.openAttachments()) log.ended(id, "daemon_restart");
}
