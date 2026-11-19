import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { ShellDecline } from "@bazhen/protocol";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { Store } from "../store/store.ts";
import { hookClient } from "../mailbox/hook-command.ts";
import { unlimited } from "../testing/fixtures.ts";
import { ShellLifecycle } from "./lifecycle.ts";
import { ShellReports } from "./reports.ts";

const INTEGRATION = { hook: "/state/hook/bazhen-hook", dir: "/state/shell-integration" };

/** Shells on a fake runtime, opened with the integration on unless `integration` is null. */
function setup(integration: typeof INTEGRATION | null = INTEGRATION, nowMicros = () => 0) {
  const path = join(mkdtempSync(join(tmpdir(), "bz-reports-")), "bazhen.db");
  const store = Store.open(path);
  const runtime = new FakeRuntime();
  const environment = new LocalEnvironment({
    historyLines: 10_000,
    id: localEnvironmentId(store),
    runtime,
    harnesses: [],
    socket: "/run/b.sock",
    shell: "/bin/zsh",
  });
  const shells = new ShellLifecycle({
    store,
    environment,
    queue: new AgentQueue(),
    size: { cols: 80, rows: 24 },
    home: tmpdir(),
    budget: unlimited,
    ...(integration && { integration }),
  });
  let keys = 0;
  /** Opens a shell, and returns it with the token its environment was given. */
  const open = async () => {
    const { terminalId } = await shells.open({ idempotencyKey: `open-${++keys}` });
    const ref = store.shell(terminalId)?.runtime;
    if (ref == null) throw new Error(`shell ${terminalId} has no terminal`);
    return { terminalId, env: runtime.specOf(ref).env };
  };
  return {
    path,
    store,
    open,
    reports: new ShellReports(store, { prompted: () => {}, declined: () => {} }, () => nowMicros()),
  };
}

const line = (token: string | undefined, at: number, command: string | null) => ({
  token: token ?? "",
  at,
  command,
});

describe("shell reports", () => {
  it("keeps the line a shell reports with its own token, and stores no token itself", async () => {
    const { path, store, open, reports } = setup();
    const { terminalId, env } = await open();
    const token = env.BAZHEN_SHELL_TOKEN;
    const outcome = reports.report(terminalId, line(token, 1, "moon run :dev"));
    expect([outcome, store.lastShellCommand(terminalId)]).toEqual(["kept", "moon run :dev"]);
    expect([env.BAZHEN_HOOK, env.BAZHEN_SHELL_INTEGRATION]).toEqual([
      INTEGRATION.hook,
      INTEGRATION.dir,
    ]);
    store.close();
    expect(readFileSync(path).includes(String(token))).toBe(false);
  });

  it("gives every shell a token of its own, and refuses one shell's token for another", async () => {
    const { store, open, reports } = setup();
    const a = await open();
    const b = await open();
    const outcomes = [
      reports.report(a.terminalId, line(b.env.BAZHEN_SHELL_TOKEN, 1, "rm -rf ~")),
      reports.report(a.terminalId, line("", 2, "rm -rf ~")),
      reports.report(a.terminalId, line(`${a.env.BAZHEN_SHELL_TOKEN}x`, 3, "rm -rf ~")),
    ];
    expect([outcomes, store.lastShellCommand(a.terminalId)]).toEqual([
      ["refused", "refused", "refused"],
      null,
    ]);
    store.close();
  });

  it("refuses every report for a shell opened with the integration off, which has no token", async () => {
    const { store, open, reports } = setup(null);
    const { terminalId, env } = await open();
    const outcome = reports.report(terminalId, line("guess", 1, "make"));
    expect([outcome, env.BAZHEN_SHELL_TOKEN, env.BAZHEN_HOOK]).toEqual([
      "refused",
      undefined,
      undefined,
    ]);
    store.close();
  });

  it("takes no report once a shell is lost, its token gone with it", async () => {
    const { store, open, reports } = setup();
    const { terminalId, env } = await open();
    reports.report(terminalId, line(env.BAZHEN_SHELL_TOKEN, 1, "cargo watch"));
    store.append({ type: "terminal.lost", entityId: terminalId, actor: "system", payload: {} });
    const outcome = reports.report(terminalId, line(env.BAZHEN_SHELL_TOKEN, 2, "ls"));
    expect([outcome, store.lastShellCommand(terminalId)]).toEqual(["refused", "cargo watch"]);
    store.close();
  });

  it("calls a report older than the kept line stale, and keeps the newer", async () => {
    const { store, open, reports } = setup();
    const { terminalId, env } = await open();
    const token = env.BAZHEN_SHELL_TOKEN;
    const outcomes = [
      reports.report(terminalId, line(token, 20, "moon run :dev")),
      reports.report(terminalId, line(token, 10, "ls")),
    ];
    expect([outcomes, store.lastShellCommand(terminalId)]).toEqual([
      ["kept", "stale"],
      "moon run :dev",
    ]);
    store.close();
  });

  it("counts a report from far ahead as a minute ahead at most, so later lines still count", async () => {
    let now = 1_000_000_000;
    const { store, open, reports } = setup(INTEGRATION, () => now);
    const { terminalId, env } = await open();
    const token = env.BAZHEN_SHELL_TOKEN;
    const outcomes = [reports.report(terminalId, line(token, Number.MAX_SAFE_INTEGER, "far"))];
    now += 61_000_000;
    outcomes.push(reports.report(terminalId, line(token, now, "moon run :dev")));
    expect([outcomes, store.lastShellCommand(terminalId)]).toEqual([
      ["kept", "kept"],
      "moon run :dev",
    ]);
    store.close();
  });

  it("forgets every kept line and token when the integration is turned off", async () => {
    const { store, open, reports } = setup();
    const { terminalId, env } = await open();
    reports.report(terminalId, line(env.BAZHEN_SHELL_TOKEN, 1, "moon run :dev"));
    store.forgetShellCommands();
    const outcome = reports.report(terminalId, line(env.BAZHEN_SHELL_TOKEN, 2, "make"));
    expect([outcome, store.lastShellCommand(terminalId)]).toEqual(["refused", null]);
    store.close();
  });
});

describe("the hook client's first-prompt report", () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A socket that records what is posted to it, each body read as the daemon reads a decline. */
  async function listening() {
    dir = mkdtempSync(join(tmpdir(), "bz-prompt-"));
    const socket = join(dir, "bazhen.sock");
    const received: { path: string | undefined; body: unknown }[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        received.push({
          path: req.url,
          body: ShellDecline.strict().safeParse(JSON.parse(raw)).data,
        });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    const terminalId = newId("term");
    /** A shell's environment with the integration on, reporting to this socket. */
    const env = {
      PATH: process.env["PATH"] ?? "",
      BAZHEN_TERMINAL_ID: terminalId,
      BAZHEN_SHELL_TOKEN: "tok-_1",
      BAZHEN_SOCKET: socket,
    };
    return { terminalId, env, received };
  }

  it("says at once, with no terminal to wait on, that a shell won't take a line back", async () => {
    const { terminalId, env, received } = await listening();
    const child = spawn(hookClient(), ["shell-prompt", "--no-retype"], { stdio: "ignore", env });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    await expect
      .poll(() => received, { timeout: 5_000 })
      .toEqual([{ path: `/v1/shells/${terminalId}/decline`, body: { token: "tok-_1" } }]);
    expect(code).toBe(0);
  }, 10_000);
});
