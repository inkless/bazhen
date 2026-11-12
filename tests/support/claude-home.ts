// A throwaway Claude Code configuration for tests that run the real TUI: onboarding done, the
// work directory trusted and a dummy key approved, so it starts without a prompt; the default
// permission mode whatever a machine's managed settings pick; and a model endpoint where nothing
// listens, so no agent ever reaches a model. Never a different HOME (it reaches the keychain).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DUMMY_KEY = "sk-ant-api-tests-00000000000000000000000000";

/** Writes the configuration under `dir` and returns the environment that points Claude Code at it. */
export function claudeHome(dir: string, trusted: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
      // Trust is keyed by the real path.
      projects: {
        [trusted]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default" } }),
  );
  return {
    CLAUDE_CONFIG_DIR: dir,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    DISABLE_AUTOUPDATER: "1",
  };
}
