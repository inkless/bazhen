import { Hono } from "hono";
import { isId } from "@bazhen/core";
import {
  HookAck,
  HookRequest,
  frameHookReply,
  isCompatible,
  type HookReply,
} from "@bazhen/protocol";
import { hookOrigin, readHook } from "@bazhen/harness-claude-code";
import type { ActivityTracker } from "./activity.ts";
import type { Approvals } from "./approvals.ts";
import type { SessionBinding } from "./binding.ts";
import { QUIET, type Mailbox } from "./mailbox.ts";

export interface IngressDeps {
  readonly mailbox: Mailbox;
  readonly approvals: Approvals;
  /** Whether the daemon runs this agent; a hook from any other is ignored, never adopted. */
  readonly knows: (agentId: string) => boolean;
  /** Which hooks are the agent's own session's, the only ones that take or confirm mail. */
  readonly binding: SessionBinding;
  /** What the agent's hooks say it is doing (foundation-design §4.6). */
  readonly activity: ActivityTracker;
}

/**
 * Hook ingress on the daemon's 0600 Unix socket, where filesystem permission is the
 * authentication (foundation-design §5.6, §9.1). Every failure answers QUIET, so the hook client
 * exits 0 and the harness carries on as it would without Bazhen.
 */
export function hookApp(deps: IngressDeps): Hono {
  const app = new Hono();

  app.post("/v1/hooks", async (c) => {
    const hook = HookRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!hook.success || !isCompatible(hook.data.protocolVersion)) return framed(QUIET);
    const { agentId, event, payload, ppid } = hook.data;
    if (!isId("agent", agentId) || !deps.knows(agentId)) return framed(QUIET);
    const read = readHook(event, payload);
    const origin = hookOrigin(payload);
    // Subagents' hooks say what the agent is doing too; another session's never do.
    const observe = () => {
      if (deps.binding.inSession(agentId, origin)) deps.activity.observe(agentId, origin, read);
    };
    // A waiter's SessionStart may move the binding first, so it is observed once it has.
    if (read.kind !== "wait") observe();
    // Subagents and other sessions may still raise approvals, but never take or confirm mail.
    const own = () =>
      deps.binding.owns(agentId, origin, {
        sessionStarted: read.kind === "wait" && read.sessionStarted,
        ppid,
      });
    switch (read.kind) {
      case "wait":
        if (!(await own())) return framed(QUIET);
        if (read.sessionStarted) deps.mailbox.sessionStarted(agentId, read.compacted);
        if (read.sessionStarted && !read.compacted) deps.activity.sessionStarted(agentId);
        observe();
        // The waiter runs beside each Stop and StopFailure report, so either ends the turn.
        if (read.turnEnd?.failed === true) deps.mailbox.turnFailed(agentId, read.turnEnd.promptId);
        else if (read.turnEnd) deps.mailbox.turnEnded(agentId, read.turnEnd.promptId);
        return framed(await deps.mailbox.wait(agentId, c.req.raw.signal));
      case "permission":
        return framed(
          await deps.approvals.request(agentId, read.summary, read.tool, c.req.raw.signal),
        );
      case "promptStarted":
        if (await own()) deps.mailbox.promptStarted(agentId, read.prompt, read.promptId);
        break;
      case "turnEnded":
        if (await own()) deps.mailbox.turnEnded(agentId, read.promptId);
        deps.approvals.turnEnded(agentId);
        break;
      case "turnFailed":
        if (await own()) deps.mailbox.turnFailed(agentId, read.promptId);
        deps.approvals.turnEnded(agentId);
        break;
      case "toolStarted":
        deps.approvals.toolStarted(agentId, read.tool, read.useId);
        break;
      case "toolSettled":
        deps.approvals.toolSettled(agentId, read.useId);
        if (read.fold !== null && (await own())) {
          return framed(deps.mailbox.fold(agentId, read.fold.promptId));
        }
        break;
      case "subagentStarted":
      case "subagentStopped":
      case "ignored":
        break;
    }
    return framed(QUIET);
  });

  app.post("/v1/hooks/ack", async (c) => {
    const ack = HookAck.safeParse(await c.req.json().catch(() => undefined));
    if (ack.success) deps.mailbox.ack(ack.data.offered);
    return c.json({});
  });

  return app;
}

function framed(reply: HookReply): Response {
  const { headers, body } = frameHookReply(reply);
  return new Response(body, { headers });
}
