// The environment for tests that run a real daemon and real agent CLIs. It starts from what a
// login session provides, never the developer's whole environment, so no real model credential
// or provider switch (CLAUDE_CODE_USE_BEDROCK, …) reaches an agent. Claude Code gets a throwaway
// configuration: onboarding done, the work directory trusted, a dummy key approved, the default
// permission mode, and a model endpoint where nothing listens. Never a different HOME (it
// reaches the keychain).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DUMMY_KEY = "sk-ant-api-tests-00000000000000000000000000";
const LOGIN_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TMUX_TMPDIR"];

/** Only the variables a login session provides, from this process's environment. */
export function loginEnv(): Record<string, string> {
  return Object.fromEntries(
    LOGIN_ENV.flatMap((k) => {
      const v = process.env[k];
      return v === undefined ? [] : [[k, v]];
    }),
  );
}

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
    // Ask before tools run, even where a machine's managed settings pick another mode.
    BAZHEN_CLAUDE_PERMISSION_MODE: "default",
  };
}
