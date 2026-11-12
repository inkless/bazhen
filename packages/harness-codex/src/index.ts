import type { HarnessAdapter, HarnessChannelPort, HarnessLaunch } from "@bazhen/core";
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
