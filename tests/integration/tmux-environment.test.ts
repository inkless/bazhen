import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterEnv, newId } from "@bazhen/core";
import { TmuxError, TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "bz-environment-"));
const marker = join(dir, "pwned");
const server = testServer("environment");
const base = filterEnv(process.env).env;
/** An exported shell function: a name tmux's parser can't take, with a multi-line value. */
const FUNCTION = "BASH_FUNC_bz%%";
const runtime = new TmuxRuntime({
  server,
  pty: nodePtySpawner,
  env: { ...base, BZ_OLD: "old", [FUNCTION]: "() {  echo hi\n}" },
});
afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Values that would end a command, start another, or be expanded, if tmux's parser ever read
 * them as anything but data: quotes, `;`, `$`, `~`, `#{}`, `#()`, `%if` and backslashes.
 */
const HOSTILE = {
  BZ_QUOTE: "it's",
  BZ_DOUBLE: 'say "hi"',
  BZ_DOLLAR: "$HOME and ${HOME}",
  BZ_TILDE: "~",
  BZ_SEMI: `x; run-shell 'touch ${marker}'`,
  BZ_CLOSE: `'; run-shell "touch ${marker}"; '`,
  BZ_FORMAT: `#{pane_id} #(touch ${marker})`,
  BZ_IF: "%if 1",
  BZ_BACKSLASH: "a\\b",
  BZ_TRAILING: "end\\",
  BZ_EMPTY: "",
};

/** What a terminal started now inherits: its environment, as its process sees it. */
async function newTerminalEnv(): Promise<Record<string, string>> {
  const out = join(dir, `env-${newId("term")}`);
  await runtime.create({
    terminalId: newId("term"),
    tags: { kind: "agent", agentId: newId("agent") },
    argv: ["sh", "-c", `env -0 > '${out}.tmp' && mv '${out}.tmp' '${out}'; sleep 60`],
    cwd: dir,
    env: {},
    size: { cols: 80, rows: 24 },
    generation: 0,
  });
  await expect.poll(() => existsSync(out), { timeout: 10_000 }).toBe(true);
  return Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\0")
      .filter((e) => e.includes("="))
      .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );
}

describe("a terminal's colour depth", () => {
  it("is 24-bit in every terminal, whatever tmux version runs and whatever the spec carries", async () => {
    const out = join(dir, "colorterm");
    await runtime.create({
      terminalId: newId("term"),
      tags: { kind: "agent", agentId: newId("agent") },
      argv: ["sh", "-c", `printf %s "$COLORTERM" > '${out}'; sleep 60`],
      cwd: dir,
      env: { COLORTERM: "16color" },
      size: { cols: 80, rows: 24 },
      generation: 0,
    });
    await expect.poll(() => existsSync(out), { timeout: 10_000 }).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("truecolor");
  });
});

describe("replacing a running tmux server's environment", () => {
  it("gives new terminals hostile values exactly, drops removed names, and runs nothing", async () => {
    expect((await newTerminalEnv())["BZ_OLD"]).toBe("old");
    const { refused } = await runtime.replaceEnv({ ...base, ...HOSTILE });
    // The function, gone from the new environment, can't be unset through the parser.
    expect(refused).toEqual([FUNCTION]);
    // What a new agent's process receives is the oracle: byte for byte, nothing expanded or
    // split. Not show-environment's printout, which escapes `$` as `\$` on some tmux versions.
    const env = await newTerminalEnv();
    expect(env).toMatchObject(HOSTILE);
    expect(env["BZ_OLD"]).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("leaves a value no quoting carries as it was, and names it", async () => {
    const { refused } = await runtime.replaceEnv({ ...base, BZ_MULTI: "one\ntwo", BZ_PLAIN: "p" });
    expect(refused).toEqual(expect.arrayContaining(["BZ_MULTI"]));
    const env = await newTerminalEnv();
    expect([env["BZ_MULTI"], env["BZ_PLAIN"]]).toEqual([undefined, "p"]);
  });

  it("keeps the environment it had when tmux can't take a new one", async () => {
    // tmux isn't on this PATH, so the refresh fails before anything changes.
    await expect(runtime.replaceEnv({ PATH: "/nonexistent", BZ_LOST: "x" })).rejects.toThrow(
      TmuxError,
    );
    const env = await newTerminalEnv();
    expect([env["BZ_PLAIN"], env["BZ_LOST"]]).toEqual(["p", undefined]);
  });
});
