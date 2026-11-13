import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { statusLineChoice } from "./status-line.ts";

/** Writes a settings file's JSON, or raw text, unless there is none. */
function write(file: string, body: unknown): void {
  if (body !== undefined)
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

/** A project, a Claude Code config dir and a managed settings file, with the settings given. */
function choiceFor(files: {
  local?: unknown;
  project?: unknown;
  user?: unknown;
  managed?: unknown;
}) {
  const root = mkdtempSync(join(tmpdir(), "bz-statusline-"));
  const cwd = join(root, "project");
  const config = join(root, "claude");
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  mkdirSync(config, { recursive: true });
  write(join(cwd, ".claude", "settings.local.json"), files.local);
  write(join(cwd, ".claude", "settings.json"), files.project);
  write(join(config, "settings.json"), files.user);
  write(join(root, "managed.json"), files.managed);
  return statusLineChoice(cwd, config, join(root, "managed.json"));
}

const line = (command: string, padding?: number) => ({
  statusLine: { type: "command", command, ...(padding === undefined ? {} : { padding }) },
});

describe("which status line Bazhen wraps", () => {
  it("wraps the user's own, with its padding, or none when they have none", () => {
    expect([choiceFor({ user: line("user", 2) }), choiceFor({})]).toEqual([
      { wrap: { command: "user", padding: 2 } },
      { wrap: null },
    ]);
  });

  it("leaves a project's status line to Claude Code, which gates it on the folder's trust", () => {
    expect([
      choiceFor({ local: line("local"), user: line("user") }),
      choiceFor({ project: line("project"), user: line("user") }),
    ]).toEqual(["leave", "leave"]);
  });

  it("leaves a managed status line, which outranks every other, and a user's of another kind", () => {
    expect([
      choiceFor({ managed: line("managed"), user: line("user") }),
      choiceFor({ user: { statusLine: { type: "static" } } }),
    ]).toEqual(["leave", "leave"]);
  });

  it("reads past a file that is missing, isn't JSON or sets no status line", () => {
    expect(
      choiceFor({ local: "{not json", project: { theme: "dark" }, user: line("user") }),
    ).toEqual({ wrap: { command: "user" } });
  });
});
