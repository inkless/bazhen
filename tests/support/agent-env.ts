// The environment for tests that run a real daemon and real agent CLIs. It starts from what a
// login session provides, never the developer's whole environment, so no real model credential
// or provider switch (CLAUDE_CODE_USE_BEDROCK, …) reaches an agent. Claude Code gets a throwaway
// configuration: onboarding done, the work directory trusted, a dummy key approved, the default
// permission mode, and a model endpoint where nothing listens. Never a different HOME (it
// reaches the keychain).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** The fake provider's dummy key, read by Codex from the environment; never a `BAZHEN_` name, which §9.5 strips. */
const CODEX_KEY_VAR = "FAKE_RESPONSES_KEY";

/**
 * Writes a Codex home under `dir` for the fake Responses provider at `providerUrl`, and returns
 * the environment that points Codex at it. Credentials are file-backed, so nothing reaches the
 * keychain. Update checks are off, and with auto-update off the managed daemon runs no update loop
 * at all, so nothing fetches a release. No proxy variable is set: every agent shares the daemon's
 * environment, and one changes how Claude Code starts.
 */
export function codexHome(
  dir: string,
  trusted: string,
  providerUrl: string,
): Record<string, string> {
  mkdirSync(join(dir, "app-server-daemon"), { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    [
      `model = "fake-model"`,
      `model_provider = "fake"`,
      `approval_policy = "on-request"`,
      `sandbox_mode = "read-only"`,
      `check_for_update_on_startup = false`,
      `cli_auth_credentials_store = "file"`,
      `mcp_oauth_credentials_store = "file"`,
      ``,
      `[model_providers.fake]`,
      `name = "fake"`,
      `base_url = "${providerUrl}/v1"`,
      `wire_api = "responses"`,
      `env_key = "${CODEX_KEY_VAR}"`,
      `requires_openai_auth = false`,
      ``,
      `[projects."${trusted}"]`,
      `trust_level = "trusted"`,
      ``,
    ].join("\n"),
  );
  // The managed daemon updates itself unless this says not to.
  writeFileSync(
    join(dir, "app-server-daemon", "settings.json"),
    JSON.stringify({ updater: { autoUpdateEnabled: false } }),
  );
  return {
    CODEX_HOME: dir,
    [CODEX_KEY_VAR]: "dummy",
  };
}

/** A dead port, for a model endpoint a run never means to reach. */
const NOWHERE = "http://127.0.0.1:9";

/**
 * Every harness's throwaway home under `dir`, and the environment that points each harness at
 * it. A daemon that a test starts gets its agents' environment only from here, so none of them
 * can fall back to the user's real Claude Code or Codex home.
 */
export function agentHomes(
  dir: string,
  trusted: string,
  urls: { readonly anthropic?: string | undefined; readonly responses?: string | undefined } = {},
): Record<string, string> {
  return {
    ...claudeHome(join(dir, "claude"), trusted),
    ...(urls.anthropic === undefined ? {} : { ANTHROPIC_BASE_URL: urls.anthropic }),
    ...codexHome(join(dir, "codex"), trusted, urls.responses ?? NOWHERE),
  };
}

/** Whether a Codex managed daemon was started on a home that `agentHomes` made. */
export function codexDaemonStarted(dir: string): boolean {
  return existsSync(join(dir, "codex", "app-server-daemon", "daemon.pid"));
}
