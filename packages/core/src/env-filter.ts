/**
 * What an agent must not inherit from the environment `bazhen start` ran in. Everything else is
 * kept, so agents see what a new terminal tab would (foundation-design §9.5). A trailing `*`
 * matches a prefix.
 */
export const ENV_DENYLIST: readonly string[] = [
  // Bazhen and tmux: Bazhen sets its own afresh for each agent.
  "BAZHEN_*",
  "TMUX",
  "TMUX_PANE",
  // Harness sessions: a nested harness would believe it runs inside its parent.
  "CLAUDECODE",
  "CLAUDE_CODE_*",
  "CODEX_*",
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

/** Kept despite the denylist: the user's Codex home is configuration, not session state. */
export const ENV_PASSTHROUGH: readonly string[] = ["CODEX_HOME"];

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

const matches = (name: string, pattern: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

export function filterEnv(
  source: Readonly<Record<string, string | undefined>>,
  rules: EnvRules = {},
): FilteredEnv {
  const passthrough = [...ENV_PASSTHROUGH, ...(rules.passthrough ?? [])];
  const denyingPattern = (name: string) =>
    rules.deny?.find((p) => matches(name, p)) ??
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
