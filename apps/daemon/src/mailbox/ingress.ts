import { Hono } from "hono";
import { isId } from "@bazhen/core";
import {
  HookAck,
  HookRequest,
  frameHookReply,
  isCompatible,
  type HookReply,
} from "@bazhen/protocol";
import { readHook } from "@bazhen/harness-claude-code";
import type { Approvals } from "./approvals.ts";
import { QUIET, type Mailbox } from "./mailbox.ts";

export interface IngressDeps {
  readonly mailbox: Mailbox;
  readonly approvals: Approvals;
  /** Whether the daemon runs this agent; a hook from any other is ignored, never adopted. */
  readonly knows: (agentId: string) => boolean;
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
    const { agentId, event, payload } = hook.data;
    if (!isId("agent", agentId) || !deps.knows(agentId)) return framed(QUIET);
    const read = readHook(event, payload);
    switch (read.kind) {
      case "wait":
        return framed(await deps.mailbox.wait(agentId, c.req.raw.signal));
      case "permission":
        return framed(
          await deps.approvals.request(agentId, read.summary, read.tool, c.req.raw.signal),
        );
      case "promptStarted":
        deps.mailbox.promptStarted(agentId, read.prompt, read.promptId);
        break;
      case "turnEnded":
        deps.mailbox.turnEnded(agentId, read.promptId);
        deps.approvals.turnEnded(agentId);
        break;
      case "toolStarted":
        deps.approvals.toolStarted(agentId, read.tool, read.useId);
        break;
      case "toolSettled":
        deps.approvals.toolSettled(agentId, read.useId);
        break;
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
