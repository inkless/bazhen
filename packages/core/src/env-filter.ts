/**
 * What an agent must not inherit from the environment `bazhen start` ran in. Everything else is
 * kept, so agents see what a new terminal tab would (foundation-design §9.5). Harness session
 * variables are listed by name, so the user's own harness configuration (CLAUDE_CODE_USE_BEDROCK,
 * CODEX_HOME) passes through. A trailing `*` matches a prefix.
 */
export const ENV_DENYLIST: readonly string[] = [
  // Bazhen and tmux: Bazhen sets its own afresh for each agent.
  "BAZHEN_*",
  "TMUX",
  "TMUX_PANE",
  // Harness sessions: a nested harness would believe it runs inside its parent, or send its
  // messages to the parent's socket.
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PROJECT_DIR",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  // Terminal presentation: tmux sets its own, and a foreign value cost Codex its true colour.
  "TERM",
  "TERMINFO",
  "TERM_PROGRAM*",
  "TERM_SESSION_ID",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "ITERM_*",
  "KITTY_*",
  "WEZTERM_*",
  "VSCODE_*",
  // Shell internals.
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
];

export interface EnvRules {
  /** Always removed, whatever the passthrough says (`agents.env.deny`). */
  readonly deny?: readonly string[];
  /** Re-allowed despite the built-in denylist (`agents.env.passthrough`). */
  readonly passthrough?: readonly string[];
}

export interface FilteredEnv {
  readonly env: Readonly<Record<string, string>>;
  /** How many variables each denying pattern removed, for `bazhen doctor`. */
  readonly removed: Readonly<Record<string, number>>;
}

/** A user rule names one variable, or a prefix ending in `*`; anything looser could strip all. */
export class InvalidEnvRule extends Error {
  readonly rule: string;

  constructor(rule: string) {
    super(`not a variable name or NAME_* prefix: ${JSON.stringify(rule)}`);
    this.rule = rule;
  }
}

/** An `agents.env` rule: a variable name, or a prefix ending in `*`. */
export const ENV_RULE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

const matches = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

export function filterEnv(
  source: Readonly<Record<string, string | undefined>>,
  rules: EnvRules = {},
): FilteredEnv {
  const { deny = [], passthrough = [] } = rules;
  const invalid = [...deny, ...passthrough].find((r) => !ENV_RULE.test(r));
  if (invalid !== undefined) throw new InvalidEnvRule(invalid);
  const denyingPattern = (name: string) =>
    deny.find((p) => matches(name, p)) ??
    (passthrough.some((p) => matches(name, p))
      ? undefined
      : ENV_DENYLIST.find((p) => matches(name, p)));
  const env: Record<string, string> = {};
  const removed: Record<string, number> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const pattern = denyingPattern(name);
    if (pattern === undefined) env[name] = value;
    else removed[pattern] = (removed[pattern] ?? 0) + 1;
  }
  return { env, removed };
}
