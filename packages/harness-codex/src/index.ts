import type {
  AgentLaunchRequest,
  HarnessAdapter,
  HarnessChannelPort,
  HarnessLaunch,
} from "@bazhen/core";
import type { ExternalRef } from "@bazhen/protocol";
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
