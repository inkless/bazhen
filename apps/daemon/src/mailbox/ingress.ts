import { Hono } from "hono";
import { isId } from "@bazhen/core";
import { HookAck, HookRequest, isCompatible } from "@bazhen/protocol";
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
    if (!hook.success || !isCompatible(hook.data.protocolVersion)) return c.json(QUIET);
    const { agentId, event, payload } = hook.data;
    if (!isId("agent", agentId) || !deps.knows(agentId)) return c.json(QUIET);
    const read = readHook(event, payload);
    switch (read.kind) {
      case "wait":
        return c.json(await deps.mailbox.wait(agentId, c.req.raw.signal));
      case "permission":
        return c.json(
          await deps.approvals.request(agentId, read.summary, read.tool, c.req.raw.signal),
        );
      case "promptStarted":
        deps.mailbox.promptStarted(agentId, read.prompt, read.promptId);
        return c.json(QUIET);
      case "turnEnded":
        deps.mailbox.turnEnded(agentId, read.promptId);
        deps.approvals.turnEnded(agentId);
        return c.json(QUIET);
      case "toolSettled":
        deps.approvals.toolSettled(agentId, read.tool);
        return c.json(QUIET);
      case "ignored":
        break;
    }
    return c.json(QUIET);
  });

  app.post("/v1/hooks/ack", async (c) => {
    const ack = HookAck.safeParse(await c.req.json().catch(() => undefined));
    if (ack.success) deps.mailbox.ack(ack.data.offered);
    return c.json({});
  });

  return app;
}
