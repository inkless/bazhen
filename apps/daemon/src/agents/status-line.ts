import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StatusLineChoice } from "@bazhen/harness-claude-code";

/** Where an organisation's managed Claude Code settings live, on this platform. */
export const MANAGED_SETTINGS =
  process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";

/**
 * Which status line Bazhen's wraps for a session started in `cwd` (foundation-design §11.2). Only
 * the user's own, from their settings in `configDir`, is lifted into the launch's settings. A
 * project's settings (`.claude/settings.local.json`, `.claude/settings.json`) are left to Claude
 * Code, which gates them on the folder's trust, and so are managed settings, which outrank every
 * other: when either sets a status line, or the user's isn't a command, Bazhen sets none, and
 * that agent reports no usage. A file that is missing or isn't JSON sets nothing.
 */
export function statusLineChoice(
  cwd: string,
  configDir: string,
  managed: string = MANAGED_SETTINGS,
): StatusLineChoice {
  const theirs = [
    managed,
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
  ];
  if (theirs.some((file) => statusLineIn(file) !== undefined)) return "leave";
  const user = statusLineIn(join(configDir, "settings.json"));
  // One Bazhen can't run inside its own is left as it is, too.
  return user === null ? "leave" : { wrap: user ?? null };
}

/** The command status line a settings file sets, null for another kind, or undefined for none. */
function statusLineIn(file: string): { command: string; padding?: number } | null | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const line: unknown =
    typeof settings === "object" && settings !== null
      ? Reflect.get(settings, "statusLine")
      : undefined;
  if (typeof line !== "object" || line === null) return undefined;
  const command: unknown = Reflect.get(line, "command");
  const padding: unknown = Reflect.get(line, "padding");
  if (Reflect.get(line, "type") !== "command" || typeof command !== "string" || command === "") {
    return null;
  }
  return typeof padding === "number" ? { command, padding } : { command };
}
