import type {
  AgentLaunchRequest,
  HarnessAdapter,
  HarnessChannelPort,
  HarnessLaunch,
  LaunchOptions,
} from "@bazhen/core";
import type { Activity, ApprovalDecision, ExternalRef } from "@bazhen/protocol";
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

/**
 * Codex has no light or dark of its own: `tui.theme` picks only its syntax highlighting, from the
 * themes it bundles, and its other colours follow the background the terminal reports.
 */
const SYNTAX_THEME = { light: "one-half-light", dark: "one-half-dark" } as const;

/**
 * The theme a Codex TUI draws for, whatever was asked: it asks the terminal's background as it
 * starts, before any client of the terminal can answer, and draws for dark when nobody does. Its
 * syntax highlighting and its terminal follow that, so every client gets one consistent Codex.
 */
const STARTS_IN = "dark";

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
  readonly themes = [STARTS_IN] as const;
  private readonly channel: HarnessChannelPort;
  /** The same server, as the TUI reaches it with `--remote`. */
  private readonly remote: string;

  constructor(channel: HarnessChannelPort, remote: string) {
    this.channel = channel;
    this.remote = remote;
  }

  async launchSpec(
    request: { readonly cwd: string },
    options: LaunchOptions,
  ): Promise<HarnessLaunch> {
    const started = await this.channel.request("thread/start", { cwd: request.cwd });
    const threadId = ThreadStarted.parse(started).thread.id;
    await this.channel.request("thread/inject_items", { threadId, items: [BINDING] });
    return this.tui(threadId, options);
  }

  /**
   * The TUI again, on the agent's own thread. A thread with no subscriber unloads within half an
   * hour, so it is resumed first, which loads it from disk (foundation-design §5.8).
   */
  async resumeSpec(
    _request: AgentLaunchRequest,
    session: Omit<ExternalRef, "environmentId">,
    options: LaunchOptions,
  ): Promise<HarnessLaunch> {
    const resumed = await this.channel.request("thread/resume", {
      threadId: session.id,
      excludeTurns: true,
    });
    // The agent stays on its own thread; a server that answered with another would rebind it.
    const threadId = ThreadStarted.parse(resumed).thread.id;
    if (threadId !== session.id) throw new ThreadMismatch(session.id, threadId);
    return this.tui(threadId, options);
  }

  private tui(threadId: string, { theme }: LaunchOptions): HarnessLaunch {
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
        ...(theme === undefined ? [] : ["-c", `tui.theme="${SYNTAX_THEME[STARTS_IN]}"`]),
      ],
      env: {},
      ...(theme && { theme: STARTS_IN }),
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

/** What a Codex thread is doing, as an activity signal's value (foundation-design §5.8). */
export type CodexActivity = Exclude<Activity["value"], "done">;

const ThreadStatus = z.object({
  type: z.string(),
  activeFlags: z.array(z.string()).optional(),
});

/**
 * A `ThreadStatus` as activity: `active` is working unless a flag says it waits on the human.
 * `notLoaded`, and a status this build doesn't know, are unknown, so a stale one isn't left
 * showing. Null for something that is no status at all.
 */
export function activityOf(status: unknown): CodexActivity | null {
  const s = ThreadStatus.safeParse(status);
  if (!s.success) return null;
  const flags = s.data.activeFlags ?? [];
  switch (s.data.type) {
    case "active":
      if (flags.includes("waitingOnApproval")) return "needs_approval";
      if (flags.includes("waitingOnUserInput")) return "waiting_input";
      return "working";
    case "idle":
      return "idle";
    case "systemError":
      return "failed";
    default:
      return "unknown";
  }
}

/** Whether a `ThreadStatus` says the thread is not loaded, and must be resumed to be followed. */
export const isNotLoaded = (status: unknown) =>
  ThreadStatus.safeParse(status).data?.type === "notLoaded";

const StatusChanged = z.object({ threadId: z.string(), status: z.unknown() });

/**
 * A thread's new activity, from `thread/status/changed`, and whether it unloaded; null for any
 * other notification.
 */
export function readThreadStatus(
  method: string,
  params: unknown,
): {
  readonly threadId: string;
  readonly activity: CodexActivity;
  readonly notLoaded: boolean;
} | null {
  if (method !== "thread/status/changed") return null;
  const p = StatusChanged.safeParse(params);
  const activity = p.success ? activityOf(p.data.status) : null;
  if (!p.success || activity === null) return null;
  return { threadId: p.data.threadId, activity, notLoaded: isNotLoaded(p.data.status) };
}

const statusIn = (result: unknown) =>
  z.object({ thread: z.object({ status: z.unknown() }) }).safeParse(result).data?.thread.status;

/** The activity of a thread as `thread/start` or `thread/resume` answers with it. */
export const resultActivity = (result: unknown): CodexActivity | null =>
  activityOf(statusIn(result));

/** Whether a `thread/resume` answered that the thread is still not loaded. */
export const resultNotLoaded = (result: unknown): boolean => isNotLoaded(statusIn(result));

const TurnEvent = z.object({
  threadId: z.string(),
  turn: z.object({ status: z.string().optional() }).optional(),
});

/**
 * A turn that started, or one that ended and how (`completed`, `interrupted`, `failed`, or null
 * when it doesn't say, which the thread's status then tells), from `turn/started` and
 * `turn/completed`; null for any other notification.
 */
export function readTurn(
  method: string,
  params: unknown,
): {
  readonly threadId: string;
  readonly started: boolean;
  readonly ended: string | null;
} | null {
  if (method !== "turn/started" && method !== "turn/completed") return null;
  const p = TurnEvent.safeParse(params);
  if (!p.success) return null;
  const started = method === "turn/started";
  return {
    threadId: p.data.threadId,
    started,
    ended: started ? null : (p.data.turn?.status ?? null),
  };
}

const ItemStarted = z.object({ threadId: z.string(), item: z.object({ type: z.string() }) });

/** An item a turn started, and whether it is the user's input; null for any other notification. */
export function readItemStarted(
  method: string,
  params: unknown,
): { readonly threadId: string; readonly userInput: boolean } | null {
  if (method !== "item/started") return null;
  const p = ItemStarted.safeParse(params);
  return p.success
    ? { threadId: p.data.threadId, userInput: p.data.item.type === "userMessage" }
    : null;
}

const StartedThread = z.object({
  id: z.string(),
  ephemeral: z.boolean().nullish(),
  threadSource: z.string().nullish(),
});

/** A thread a human could be shown: not one Codex makes to write a title, which is ephemeral. */
const shown = (t: z.infer<typeof StartedThread>) =>
  t.ephemeral !== true && t.threadSource !== "thread_title";

/**
 * A new thread's id, from `thread/started`, as a TUI's `/new` or `/fork` makes; null for a
 * title thread or any other notification.
 */
export function readThreadStarted(method: string, params: unknown): string | null {
  if (method !== "thread/started") return null;
  const p = z.object({ thread: StartedThread }).safeParse(params);
  return p.success && shown(p.data.thread) ? p.data.thread.id : null;
}

/** The shown threads in a `thread/list` answer, newest first as the server sorts them. */
export function readThreadList(result: unknown): string[] {
  const p = z.object({ data: z.array(z.unknown()) }).safeParse(result);
  if (!p.success) return [];
  return p.data.data.flatMap((t) => {
    const thread = StartedThread.safeParse(t);
    return thread.success && shown(thread.data) ? [thread.data.id] : [];
  });
}

/** A thread id, whole or cut short with `...` or `…`, as the TUI's terminal title shows it. */
const TITLE = /^([0-9a-f]{8}-[0-9a-f-]{20,27})(?:\.\.\.|…)?$/;

/**
 * The thread id a TUI's terminal title names, as the prefix every id it could be starts with;
 * null for a title that isn't one, as the user's own title config makes (foundation-design §5.8).
 */
export function titlePrefix(title: string): string | null {
  const m = TITLE.exec(title.trim());
  return m?.[1] ?? null;
}

/** The ids among `ids` that start with `prefix`, each once. */
export const matching = (prefix: string, ids: Iterable<string>): string[] => [
  ...new Set([...ids].filter((id) => id.startsWith(prefix))),
];
