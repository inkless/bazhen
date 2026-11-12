import type { HarnessAdapter, HarnessLaunch } from "@bazhen/core";

/**
 * Claude Code, reached through its hooks (foundation-design §5.6). Bazhen picks the session id
 * itself, so the agent's first binding is known before any hook fires (§3.1).
 */
export class ClaudeCodeHarness implements HarnessAdapter {
  readonly id = "claude-code";
  private readonly newSessionId: () => string;

  constructor(newSessionId: () => string) {
    this.newSessionId = newSessionId;
  }

  launchSpec(): HarnessLaunch {
    const id = this.newSessionId();
    return {
      argv: ["claude", "--session-id", id],
      env: {},
      externalRef: { kind: "claude-session", id },
    };
  }
}
