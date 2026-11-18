import { z } from "zod";
import { Agent, AgentState } from "./agents.ts";
import { Id } from "./ids.ts";
import { MESSAGE_WAIT_MAX_MS } from "./mail.ts";
import { Shell, TerminalState } from "./shells.ts";
import { Task } from "./tasks.ts";

/**
 * What an agent is waited on to be: a lifecycle state; `ended`, closed or failed; `ready`, its
 * harness up, as `running` says; or `idle`, its harness reporting an ended turn that came after
 * every message sent to it reached it.
 */
export const AgentCondition = z.union([AgentState, z.enum(["ended", "ready", "idle"])]);
export type AgentCondition = z.infer<typeof AgentCondition>;

/** What a shell is waited on to be: a lifecycle state, or `ended`, closed or failed. */
export const ShellCondition = z.union([TerminalState, z.enum(["ended"])]);
export type ShellCondition = z.infer<typeof ShellCondition>;

/**
 * What a wait is on. A task is `done` once it is finished done, or once no one is still on it
 * and someone completed their part. A reply is the first message the recipient of `messageId`
 * queued back to its sender after it, which only that sender may wait on.
 */
export const WaitCondition = z.discriminatedUnion("on", [
  z.object({ on: z.literal("agent"), agentId: Id("agent"), until: AgentCondition }),
  z.object({ on: z.literal("shell"), shellId: Id("term"), until: ShellCondition }),
  z.object({ on: z.literal("task"), taskId: Id("task"), until: z.literal("done") }),
  z.object({ on: z.literal("reply"), messageId: Id("msg") }),
]);
export type WaitCondition = z.infer<typeof WaitCondition>;

/** The most one wait holds its request, as a wait for mail does; a client asks again for more. */
export const WAIT_MAX_MS = MESSAGE_WAIT_MAX_MS;

/** `POST /v1/waits`: answered once the condition is met or can't be, or at `timeoutMs`. */
export const WaitRequest = z.object({
  condition: WaitCondition,
  timeoutMs: z.number().int().nonnegative().max(WAIT_MAX_MS),
});
export type WaitRequest = z.infer<typeof WaitRequest>;

/**
 * `met`, `never` (it ended otherwise, or the task was cancelled), `bounced` (a reply's message
 * will never reach its recipient), or `pending` at the timeout.
 */
export const WaitVerdict = z.enum(["met", "never", "bounced", "pending"]);
export type WaitVerdict = z.infer<typeof WaitVerdict>;

/**
 * Where the condition stands, `said` as one line for a person, with what it is on as the caller's
 * `/v1/state` shows it: the agent (for a reply, its message's recipient), the shell or the task.
 */
export const WaitResponse = z.object({
  verdict: WaitVerdict,
  said: z.string(),
  agent: Agent.optional(),
  shell: Shell.optional(),
  task: Task.optional(),
  /** The reply, once one is queued. */
  replyId: Id("msg").optional(),
});
export type WaitResponse = z.infer<typeof WaitResponse>;
