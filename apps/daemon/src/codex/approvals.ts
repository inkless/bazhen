import type { AttentionId } from "@bazhen/core";
import { approvalResult, readApproval, readResolved, type RequestId } from "@bazhen/harness-codex";
import type { Approvals, CloseReason } from "../mailbox/approvals.ts";
import type { ChannelListener } from "./channel.ts";

/** One open item, and how to answer the request behind it on the connection it last came on. */
interface Asked {
  readonly item: AttentionId;
  readonly threadId: string;
  respond: ((result: unknown) => void) | undefined;
}

/**
 * Codex's approval requests, as attention items (foundation-design §5.8). Every subscribed
 * client receives the request and the TUI shows its own prompt; the first answer wins. The
 * inbox's goes back as the request's result. One given in the TUI arrives as
 * `serverRequest/resolved`, as it does when the turn that asked is interrupted.
 *
 * An item outlives its connection. A server still running sends a resumed thread's pending
 * requests again, and each finds its item by its thread and tool call. Until then the inbox
 * can't answer it: an answer with no connection to carry it would be recorded and lost. One a
 * resumed thread doesn't send again was lost with a server that restarted, and goes stale; one
 * whose agent no longer runs closes with it.
 */
export function codexApprovals(
  approvals: Approvals,
  agentOf: (threadId: string) => string | undefined,
): ChannelListener {
  const asked = new Map<string, Asked>();
  /** The current connection's request ids, to the tool call each is for. */
  let requests = new Map<RequestId, string>();
  const close = (key: string, reason: CloseReason) => {
    const a = asked.get(key);
    asked.delete(key);
    if (a !== undefined) approvals.withdraw(a.item, reason);
  };
  return {
    request(method, params, id, respond) {
      // Not an approval, or not for an agent Bazhen runs: the TUI answers it.
      const request = readApproval(method, params);
      if (request === null) return;
      const agentId = agentOf(request.threadId);
      if (agentId === undefined) return;
      const key = JSON.stringify([request.threadId, request.itemId]);
      requests.set(id, key);
      const known = asked.get(key);
      if (known !== undefined) {
        known.respond = respond;
        return;
      }
      const a: Asked = {
        threadId: request.threadId,
        respond,
        item: approvals.ask(
          agentId,
          request.summary,
          request.itemId,
          (decision) => {
            asked.delete(key);
            if (decision !== null) a.respond?.(approvalResult(decision));
          },
          () => a.respond !== undefined,
        ),
      };
      asked.set(key, a);
    },
    notification(method, params) {
      const resolved = readResolved(method, params);
      const key = resolved === null ? undefined : requests.get(resolved);
      if (key !== undefined) close(key, "answered_in_tui");
    },
    disconnected() {
      requests = new Map();
      for (const [key, a] of asked) {
        a.respond = undefined;
        if (agentOf(a.threadId) === undefined) close(key, "agent_closed");
      }
    },
    resumed(threads) {
      // Resumed, and not asked again: the server that held it is gone.
      for (const [key, a] of asked) {
        if (a.respond === undefined && threads.includes(a.threadId)) close(key, "stale");
      }
    },
  };
}
