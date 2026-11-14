// Server-wide settings outlive the daemon that set them: the next daemon puts its own on a server
// an older one started, and a hook can never leave a pane in a mode no key leaves.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { filterEnv, newId, type TerminalSpec } from "@bazhen/core";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { testServer, tmuxOut } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "bz-hooks-"));
const servers: ConfiguredTmuxServer[] = [];
let made = 0;
afterAll(() => {
  for (const server of servers) if (server.alive()) server.kill();
  rmSync(dir, { recursive: true, force: true });
});

const newServer = () => {
  const server = testServer(`hooks-${++made}`);
  servers.push(server);
  return server;
};

const runtimeOn = (server: ConfiguredTmuxServer, onPaneTitle?: [string, ...string[]]) =>
  new TmuxRuntime({
    server,
    pty: nodePtySpawner,
    env: filterEnv(process.env).env,
    ...(onPaneTitle === undefined ? {} : { onPaneTitle }),
  });

/** A terminal that titles itself with each line typed into it, as a Codex TUI titles its pane. */
const titler = (): TerminalSpec => ({
  terminalId: newId("term"),
  tags: { kind: "agent", agentId: newId("agent") },
  argv: ["sh", "-c", "while read t; do printf '\\033]2;%s\\007' \"$t\"; done"],
  cwd: dir,
  env: {},
  size: { cols: 80, rows: 24 },
  generation: 0,
});

/** A hook client that does `first`, then logs the pane it was run for, then does `last`. */
function client(name: string, first = "", last = ""): { path: string; log: string } {
  const path = join(dir, `${name}.sh`);
  const log = join(dir, `${name}.log`);
  writeFileSync(path, `#!/bin/sh\n${first}echo "$1" >> '${log}'\n${last}`, { mode: 0o755 });
  return { path, log };
}

const logged = (log: string) => (existsSync(log) ? readFileSync(log, "utf8") : "");

const title = (server: ConfiguredTmuxServer, pane: string, text: string) =>
  tmuxOut(server, "send-keys", "-t", pane, "-l", `${text}\r`);

const inMode = (server: ConfiguredTmuxServer, pane: string) =>
  tmuxOut(server, "display-message", "-p", "-t", pane, "#{pane_in_mode}").trim();

describe("the pane-title hook on a server an older daemon started", () => {
  it("runs this daemon's client once its settings are applied", async () => {
    const server = newServer();
    const before = client("before");
    const after = client("after");
    const ref = await runtimeOn(server, [before.path]).create(titler());
    const pane = String(ref.locator.paneId);
    title(server, pane, "one");
    await expect.poll(() => logged(before.log), { timeout: 5_000 }).toBe(`${pane}\n`);

    await runtimeOn(server, [after.path]).applyServerSettings();
    title(server, pane, "two");
    await expect.poll(() => logged(after.log), { timeout: 5_000 }).toBe(`${pane}\n`);
    expect(logged(before.log)).toBe(`${pane}\n`);
  });

  it("is removed by a daemon with no pane-title client", async () => {
    const server = newServer();
    const before = client("removed");
    // A pane hook set with -g is a global window option, which -g alone doesn't show.
    const hooks = () => tmuxOut(server, "show-hooks", "-gw");
    await runtimeOn(server, [before.path]).create(titler());
    const set = hooks();
    await runtimeOn(server).applyServerSettings();
    expect([set, hooks()]).toEqual([
      expect.stringContaining(before.path),
      expect.not.stringContaining(before.path),
    ]);
  });

  it("is removed by a terminal a daemon with no pane-title client creates", async () => {
    const server = newServer();
    const before = client("removed-by-create");
    const hooks = () => tmuxOut(server, "show-hooks", "-gw");
    await runtimeOn(server, [before.path]).create(titler());
    const set = hooks();
    await runtimeOn(server).create(titler());
    expect([set, hooks()]).toEqual([
      expect.stringContaining(before.path),
      expect.not.stringContaining(before.path),
    ]);
  });

  it("is put on by a health check that reaches the server, when settings at start found none", async () => {
    const server = newServer();
    const before = client("health-before");
    const after = client("health-after");
    const daemon = runtimeOn(server, [after.path]);
    await daemon.applyServerSettings();
    const ref = await runtimeOn(server, [before.path]).create(titler());
    const pane = String(ref.locator.paneId);
    await daemon.health();
    title(server, pane, "four");
    await expect.poll(() => logged(after.log), { timeout: 5_000 }).toBe(`${pane}\n`);
  });

  it("is not applied, and no server started, when none runs", async () => {
    const server = newServer();
    await runtimeOn(server).applyServerSettings();
    expect(server.alive()).toBe(false);
  });
});

describe("a pane-title hook that fails", () => {
  it("leaves the pane out of view mode, whatever it printed or returned", async () => {
    const server = newServer();
    const failing = client("failing", "echo printed\necho complained >&2\n", "exit 127\n");
    const ref = await runtimeOn(server, [failing.path]).create(titler());
    const pane = String(ref.locator.paneId);
    title(server, pane, "three");
    await expect.poll(() => logged(failing.log), { timeout: 5_000 }).toBe(`${pane}\n`);
    // The hook has printed by now and only exits after; a job of its own gives tmux time to
    // finish the hook's.
    tmuxOut(server, "run-shell", "true");
    expect(inMode(server, pane)).toBe("0");
  });
});

describe("a pane in view mode", () => {
  const cases = ["emacs", "vi"].flatMap((modeKeys) =>
    ["q", "Escape", "C-c"].map((key) => ({ modeKeys, key })),
  );

  it.each(cases)("leaves it on $key, with $modeKeys mode keys", async ({ modeKeys, key }) => {
    const server = newServer();
    const ref = await runtimeOn(server).create(titler());
    const pane = String(ref.locator.paneId);
    tmuxOut(server, "set-option", "-g", "mode-keys", modeKeys);
    tmuxOut(server, "run-shell", "-t", pane, "echo shown");
    expect(inMode(server, pane)).toBe("1");
    tmuxOut(server, "send-keys", "-t", pane, key);
    await expect.poll(() => inMode(server, pane)).toBe("0");
  });

  it("leaves it on q on a server an older daemon left with no keys in its modes", async () => {
    const server = newServer();
    const runtime = runtimeOn(server);
    const ref = await runtime.create(titler());
    const pane = String(ref.locator.paneId);
    // tmux takes vi keys from an EDITOR naming vi, so the table in use is fixed, and both emptied.
    tmuxOut(server, "set-option", "-g", "mode-keys", "emacs");
    tmuxOut(server, "unbind-key", "-a", "-T", "copy-mode");
    tmuxOut(server, "unbind-key", "-a", "-T", "copy-mode-vi");
    await runtime.applyServerSettings();
    tmuxOut(server, "run-shell", "-t", pane, "echo shown");
    expect(inMode(server, pane)).toBe("1");
    tmuxOut(server, "send-keys", "-t", pane, "q");
    await expect.poll(() => inMode(server, pane)).toBe("0");
  });
});
