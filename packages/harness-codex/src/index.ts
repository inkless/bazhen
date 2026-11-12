import type {
  AgentLaunchRequest,
  HarnessAdapter,
  HarnessChannelPort,
  HarnessLaunch,
} from "@bazhen/core";
import type { ApprovalDecision, ExternalRef } from "@bazhen/protocol";
import { z } from "zod";

const ThreadStarted = z.object({ thread: z.object({ id: z.string() }) });

/**
 * The first item of every agent's thread. A thread with no history can't be resumed, and a
 * developer message makes one without a model call (foundation-design §5.8).
 */
const BINDING = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "This thread belongs to an agent that Bazhen runs." }],
};

/** The app-server resumed a thread other than the agent's own. */
export class ThreadMismatch extends Error {
  constructor(expected: string, got: string) {
    super(`asked to resume thread ${expected}, the app-server resumed ${got}`);
  }
}

/**
 * Codex, reached through its app-server (foundation-design §5.8). Bazhen starts the agent's
 * thread itself, so the agent is bound to it before the TUI starts, and the TUI joins that thread
 * as another client of the same server.
 */
export class CodexHarness implements HarnessAdapter {
  readonly id = "codex";
  private readonly channel: HarnessChannelPort;
  /** The same server, as the TUI reaches it with `--remote`. */
  private readonly remote: string;

  constructor(channel: HarnessChannelPort, remote: string) {
    this.channel = channel;
    this.remote = remote;
  }

  async launchSpec(request: { readonly cwd: string }): Promise<HarnessLaunch> {
    const started = await this.channel.request("thread/start", { cwd: request.cwd });
    const threadId = ThreadStarted.parse(started).thread.id;
    await this.channel.request("thread/inject_items", { threadId, items: [BINDING] });
    return this.tui(threadId);
  }

  /**
   * The TUI again, on the agent's own thread. A thread with no subscriber unloads within half an
   * hour, so it is resumed first, which loads it from disk (foundation-design §5.8).
   */
  async resumeSpec(
    _request: AgentLaunchRequest,
    session: Omit<ExternalRef, "environmentId">,
  ): Promise<HarnessLaunch> {
    const resumed = await this.channel.request("thread/resume", {
      threadId: session.id,
      excludeTurns: true,
    });
    // The agent stays on its own thread; a server that answered with another would rebind it.
    const threadId = ThreadStarted.parse(resumed).thread.id;
    if (threadId !== session.id) throw new ThreadMismatch(session.id, threadId);
    return this.tui(threadId);
  }

  private tui(threadId: string): HarnessLaunch {
    return {
      argv: [
        "codex",
        "resume",
        threadId,
        // Without it the TUI picks a server of its own.
        "--remote",
        this.remote,
        // Keeps the transcript in the terminal's scrollback.
        "--no-alt-screen",
        // The TUI keeps its pane's title set to the thread it shows, through /new and /resume.
        "-c",
        'tui.terminal_title=["thread-id"]',
      ],
      env: {},
      externalRef: { kind: "codex-thread", id: threadId },
    };
  }
}

/** A Codex request for the human's approval, as the daemon acts on it. */
export interface CodexApproval {
  readonly threadId: string;
  /** The tool call it is for. */
  readonly itemId: string;
  readonly summary: string;
}

const Approval = z.object({
  threadId: z.string(),
  itemId: z.string(),
  command: z.string().nullish(),
  reason: z.string().nullish(),
});

/** What each approval request asks for, by its method. */
const ASKS = new Map<string, (command: string | null | undefined) => string>([
  ["item/commandExecution/requestApproval", (command) => `Run ${command ?? "a command"}`],
  ["item/fileChange/requestApproval", () => "Change files"],
]);

/**
 * Reads one of the app-server's requests: an approval to run a command or change files becomes
 * one for the inbox (foundation-design §5.8); anything else is not Bazhen's to answer.
 */
export function readApproval(method: string, params: unknown): CodexApproval | null {
  const asks = ASKS.get(method);
  if (asks === undefined) return null;
  const p = Approval.safeParse(params);
  if (!p.success) return null;
  const { threadId, itemId, command, reason } = p.data;
  const what = asks(command);
  return { threadId, itemId, summary: reason ? `${what} (${reason})` : what };
}

/** The result that answers an approval request with the inbox's decision. */
export const approvalResult = (decision: ApprovalDecision) => ({
  decision: decision === "allow" ? "accept" : "decline",
});

/** The id of one of the app-server's own requests, unique on its connection. */
export const RequestId = z.union([z.number(), z.string()]);
export type RequestId = z.infer<typeof RequestId>;

const Resolved = z.object({ requestId: RequestId });

/**
 * The request a `serverRequest/resolved` notification says was answered, by another client or
 * the TUI; null for any other notification.
 */
export function readResolved(method: string, params: unknown): RequestId | null {
  if (method !== "serverRequest/resolved") return null;
  const p = Resolved.safeParse(params);
  return p.success ? p.data.requestId : null;
}

/**
 * A message's text as the agent reads it. It always carries the message's id, so the turn that
 * takes it can be matched to it, whenever and however Codex delivers it (foundation-design §5.8).
 */
export const messageText = (id: string, body: string) =>
  `Message for you from Bazhen (${id}):\n${body}`;

/**
 * `codex queue`'s arguments for one message: to the app-server at `remote`, which wakes an idle
 * thread and otherwise waits for the turn boundary, or, with no server to reach, into the Codex
 * home, which holds it until one comes up. Never `turn/start` or `turn/steer`, which would cut
 * off a running turn's reply.
 */
export function queueArgs(threadId: string, text: string, remote: string | null): string[] {
  return [
    "queue",
    "--thread",
    threadId,
    ...(remote === null ? [] : ["--remote", remote]),
    "--message",
    text,
  ];
}

/** Starts Codex's own managed daemon on the Codex home, installing it from the local CLI. */
export const DAEMON_START_ARGS: readonly string[] = ["app-server", "daemon", "start"];

const UserMessage = z.object({
  threadId: z.string(),
  item: z.object({
    type: z.literal("userMessage"),
    content: z.array(z.object({ text: z.string().optional() })),
  }),
});

/**
 * The label `messageText` starts each message with, and the id it carries. Only where Bazhen
 * puts it counts: a body that quotes another message's label confirms nothing.
 */
const LABEL = /^Message for you from Bazhen \((msg_[0-9a-zA-Z]+)\):\n/;

/**
 * The Bazhen message a turn takes as the user's input, by id, and its thread; a null id for
 * input that isn't one, and null for any other notification.
 */
export function readUserMessage(
  method: string,
  params: unknown,
): { readonly threadId: string; readonly messageId: string | null } | null {
  if (method !== "item/started") return null;
  const p = UserMessage.safeParse(params);
  if (!p.success) return null;
  const first = p.data.item.content[0]?.text ?? "";
  return { threadId: p.data.threadId, messageId: LABEL.exec(first)?.[1] ?? null };
}
