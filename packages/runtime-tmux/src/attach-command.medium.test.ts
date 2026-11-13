import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type RuntimeRef } from "@bazhen/core";
import { TmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime } from "./index.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const terminalId = newId("term");

/** A runtime on a server that never starts: formatting a command runs nothing. */
function runtime() {
  const root = mkdtempSync("/tmp/bz-attach it's-");
  made.push(root);
  const server = TmuxServer.at(join(root, "tmux.sock"), {
    root,
    config: join(root, "tmux.conf"),
  });
  const pty = {
    spawn: () => {
      throw new Error("no PTY here");
    },
  };
  return { root, runtime: new TmuxRuntime({ server, pty, env: {} }) };
}

const quoted = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;

const ref = (locator: Record<string, string>): RuntimeRef => ({
  terminalId,
  runtime: "tmux",
  locator,
});

describe("TmuxRuntime.attachCommand", () => {
  it("attaches to the session by id on the daemon's own server, outside the user's tmux", () => {
    const { root, runtime: tmux } = runtime();
    expect(tmux.attachCommand(ref({ session: "bz-aaaaaaaaaaaa", sessionId: "$7" }))).toBe(
      `env -u TMUX tmux -u -S ${quoted(join(realpathSync(root), "tmux.sock"))} -f ${quoted(join(root, "tmux.conf"))} attach-session -t '$7'`,
    );
  });

  it("falls back to the session name for a ref recorded without an id", () => {
    const { runtime: tmux } = runtime();
    expect(tmux.attachCommand(ref({ session: "bz-aaaaaaaaaaaa" }))).toMatch(
      / attach-session -t bz-aaaaaaaaaaaa$/,
    );
  });
});
