import type { Socket } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import {
  HookAck,
  HookRequest,
  type Usage,
  frameHookReply,
  HOOK_PROTOCOL_VERSION,
  isCompatible,
  type HookReply,
} from "@bazhen/protocol";
import { hookOrigin, readHook, type SentMessage } from "@bazhen/harness-claude-code";
import { AGENT_TOKEN_HEADER } from "../auth/agent-token.ts";
import { identify, type AgentCredentials } from "../auth/callers.ts";
import type { PeerReading } from "../auth/peer.ts";
import type { ActivityTracker } from "./activity.ts";
import type { Approvals } from "./approvals.ts";
import type { SessionBinding } from "./binding.ts";
import { QUIET, type Mailbox } from "./mailbox.ts";

export interface IngressDeps {
  readonly mailbox: Mailbox;
  readonly approvals: Approvals;
  /** The agent's own turns, as the inbox follows them for failures (foundation-design §4.6). */
  readonly turns: {
    started(agentId: string): void;
    failed(agentId: string, error: string | null): void;
  };
  /** Whether the daemon runs this agent; a hook from any other is ignored, never adopted. */
  readonly knows: (agentId: string) => boolean;
  /** A hook of the agent's own session: its harness is up (foundation-design §4.5). */
  readonly ready: (agentId: string) => void;
  /** A hook names its agent; its agent token must be that agent's (foundation-design §9.1). */
  readonly credentials: AgentCredentials;
  /** Whose process made the hook's call, which must be that agent's too; absent when unread. */
  readonly peer?: (connection: Socket) => Promise<PeerReading>;
  /** Which hooks are the agent's own session's, the only ones that take or confirm mail. */
  readonly binding: SessionBinding;
  /** What the agent's hooks say it is doing (foundation-design §4.6). */
  readonly activity: ActivityTracker;
  /** Records the model the agent runs and its context use (§11.2). */
  readonly recordUsage: (agentId: string, usage: Usage) => void;
  /** Records a message the agent sent through its harness's own channel (§5.6). */
  readonly observeSend: (agentId: string, toolUseId: string, sent: SentMessage) => void;
}

/**
 * Hook ingress on the daemon's 0600 Unix socket, where filesystem permission is the
 * authentication (foundation-design §5.6, §9.1). Every failure answers QUIET, so the hook client
 * exits 0 and the harness carries on as it would without Bazhen.
 */
export function hookApp(deps: IngressDeps): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const peerOf = async (c: Context<{ Bindings: HttpBindings }>) =>
    deps.peer === undefined ? undefined : deps.peer(c.env.incoming.socket);

  app.post("/v1/hooks", async (c) => {
    const hook = HookRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!hook.success || !isCompatible(hook.data.protocolVersion, HOOK_PROTOCOL_VERSION))
      return framed(QUIET);
    const { event, payload, ppid } = hook.data;
    const who = identify(
      deps.credentials,
      { token: c.req.header(AGENT_TOKEN_HEADER), said: hook.data.agentId },
      await peerOf(c),
    );
    if (who.kind !== "agent" || !deps.knows(who.agentId)) return framed(QUIET);
    const { agentId } = who;
    const read = readHook(event, payload);
    const origin = hookOrigin(payload);
    // Subagents' hooks say what the agent is doing too; another session's never do.
    const observe = () => {
      if (deps.binding.inSession(agentId, origin)) deps.activity.observe(agentId, origin, read);
    };
    // A waiter's SessionStart may move the binding first, so it is observed once it has.
    if (read.kind !== "wait") observe();
    // Subagents and other sessions may still raise approvals, but never take or confirm mail.
    const own = async () => {
      const owned = await deps.binding.owns(agentId, origin, {
        sessionStarted: read.kind === "wait" && read.sessionStarted,
        ppid,
      });
      if (owned) deps.ready(agentId);
      return owned;
    };
    switch (read.kind) {
      case "wait":
        if (!(await own())) return framed(QUIET);
        if (read.sessionStarted) deps.mailbox.sessionStarted(agentId, read.compacted);
        if (read.sessionStarted && !read.compacted) deps.activity.sessionStarted(agentId);
        observe();
        // The waiter runs beside each Stop and StopFailure report, so either ends the turn.
        if (read.turnEnd?.failed === true) {
          deps.mailbox.turnFailed(agentId, read.turnEnd.promptId);
          deps.turns.failed(agentId, read.turnEnd.error);
        } else if (read.turnEnd) deps.mailbox.turnEnded(agentId, read.turnEnd.promptId);
        return framed(await deps.mailbox.wait(agentId, c.req.raw.signal));
      case "permission":
        return framed(
          await deps.approvals.request(agentId, read.summary, read.tool, c.req.raw.signal),
        );
      case "question":
        // No decision: the TUI shows its own prompt, and takes the answer.
        deps.approvals.question(agentId, read.summary, read.tool);
        break;
      case "promptStarted":
        if (await own()) {
          deps.mailbox.promptStarted(agentId, read.prompt, read.promptId);
          deps.turns.started(agentId);
          deps.approvals.promptStarted(agentId, read.promptId);
        }
        break;
      case "turnEnded":
        if (await own()) deps.mailbox.turnEnded(agentId, read.promptId);
        deps.approvals.turnEnded(agentId);
        break;
      case "turnFailed":
        if (await own()) {
          deps.mailbox.turnFailed(agentId, read.promptId);
          deps.turns.failed(agentId, read.error);
        }
        deps.approvals.turnEnded(agentId);
        break;
      case "toolStarted":
        deps.approvals.toolStarted(agentId, read.tool, read.useId);
        break;
      case "toolSettled":
        deps.approvals.toolSettled(agentId, read.useId);
        if (read.fold !== null && (await own())) {
          if (read.sent) deps.observeSend(agentId, read.useId, read.sent);
          return framed(deps.mailbox.fold(agentId, read.fold.promptId));
        }
        break;
      case "statusline":
        if (deps.binding.inSession(agentId, origin)) deps.recordUsage(agentId, read.usage);
        break;
      case "subagentStopped":
        deps.approvals.subagentStopped(agentId, read.subagentId);
        break;
      case "subagentStarted":
      case "ignored":
        break;
    }
    return framed(QUIET);
  });

  app.post("/v1/hooks/ack", async (c) => {
    const ack = HookAck.safeParse(await c.req.json().catch(() => undefined));
    if (!ack.success) return c.json({});
    const who = identify(
      deps.credentials,
      { token: c.req.header(AGENT_TOKEN_HEADER), said: ack.data.agentId },
      await peerOf(c),
    );
    if (who.kind === "agent") deps.mailbox.ack(who.agentId, ack.data.offered);
    return c.json({});
  });

  return app;
}

function framed(reply: HookReply): Response {
  const { headers, body } = frameHookReply(reply);
  return new Response(body, { headers });
}
