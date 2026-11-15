import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newId, type RuntimeRef } from "@bazhen/core";
import { FakeRuntime } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { Store } from "../store/store.ts";
import { testView, unlimited } from "../testing/fixtures.ts";
import { ShellLifecycle, ShellOpenFailed } from "./lifecycle.ts";
import { ShellReports } from "./reports.ts";
import { PendingRetypes } from "./retype.ts";

const INTEGRATION = { hook: "/state/hook/bazhen-hook", dir: "/state/shell-integration" };
const LINE = `echo "$HOME" 'a  b' TOKEN=s3cret`;

/** A lost shell whose integration kept `line`, on a fake runtime, with what restarts it. */
async function lostShell({
  line = LINE,
  restartedReporting = true,
  retypeWithinMs = 30_000,
}: {
  line?: string | null;
  /** Whether the daemon that restarts the shell has the integration, as one without its hook doesn't. */
  restartedReporting?: boolean;
  retypeWithinMs?: number;
} = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "bz-retype-")), "bazhen.db");
  const store = Store.open(path);
  const runtime = new FakeRuntime();
  const environment = new LocalEnvironment({
    id: localEnvironmentId(store),
    runtime,
    harnesses: [],
    socket: "/run/b.sock",
    shell: "/bin/zsh",
  });
  let opensFail = false;
  const openShell = environment.openShell.bind(environment);
  environment.openShell = async (open) => {
    if (opensFail) throw new Error("tmux refused");
    return openShell(open);
  };
  const logs: string[] = [];
  const lifecycle = (reporting: boolean) =>
    new ShellLifecycle({
      store,
      environment,
      queue: new AgentQueue(),
      size: { cols: 80, rows: 24 },
      home: tmpdir(),
      budget: unlimited,
      retypeWithinMs,
      log: (message) => logs.push(message),
      ...(reporting && { integration: INTEGRATION }),
    });
  const opener = lifecycle(true);
  const shells = restartedReporting ? opener : lifecycle(false);
  const reports = new ShellReports(store, (terminalId) => shells.prompted(terminalId));
  const refOf = (terminalId: string): RuntimeRef => {
    const ref = store.shell(terminalId)?.runtime;
    if (ref == null) throw new Error(`shell ${terminalId} has no terminal`);
    return ref;
  };
  const tokenOf = (terminalId: string) =>
    String(runtime.specOf(refOf(terminalId)).env.BAZHEN_SHELL_TOKEN);
  const { terminalId } = await opener.open({ idempotencyKey: "open" });
  const lostToken = tokenOf(terminalId);
  if (line !== null) reports.report(terminalId, { token: lostToken, at: 1, command: line });
  runtime.reboot();
  store.append({ type: "terminal.lost", entityId: terminalId, actor: "system", payload: {} });
  let keys = 0;
  const restart = (retype = true) =>
    shells.restart(terminalId, {
      idempotencyKey: `restart-${++keys}`,
      generation: 0,
      ...(retype && { retype: true as const }),
    });
  /** The new shell's integration reports its first prompt with `token`, its own by default. */
  const prompt = (id: string, token = tokenOf(id)) => reports.prompt(id, { token });
  const retypeable = (id: string) =>
    store.snapshot(testView).shells.find((s) => s.id === id)?.retypeable;
  return {
    path,
    store,
    runtime,
    shells,
    terminalId,
    lostToken,
    logs,
    reports,
    tokenOf,
    restart,
    prompt,
    retypeable,
    refOf,
    failOpens: (fail: boolean) => (opensFail = fail),
  };
}

describe("restarting a lost shell with its last line typed back", () => {
  it("offers it only for a lost shell whose line was kept", async () => {
    const kept = await lostShell();
    const none = await lostShell({ line: null });
    const offered = [kept.retypeable(kept.terminalId), none.retypeable(none.terminalId)];
    const { terminalId: running } = await kept.restart(false);
    kept.reports.report(running, { token: kept.tokenOf(running), at: 2, command: "make" });
    expect([...offered, kept.store.lastShellCommand(running), kept.retypeable(running)]).toEqual([
      true,
      false,
      "make",
      false,
    ]);
  });

  it("types the line, exactly, only once the new shell reports its first prompt, and once", async () => {
    const { runtime, restart, prompt, refOf } = await lostShell();
    const { terminalId } = await restart();
    const before = [...runtime.pasted(refOf(terminalId))];
    expect(prompt(terminalId)).toBe(true);
    await vi.waitFor(() => expect(runtime.pasted(refOf(terminalId))).toHaveLength(1));
    prompt(terminalId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([before, runtime.pasted(refOf(terminalId))]).toEqual([[], [LINE]]);
  });

  it("types nothing into a shell restarted without asking to retype", async () => {
    const { runtime, restart, prompt, refOf } = await lostShell();
    const { terminalId } = await restart(false);
    prompt(terminalId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.pasted(refOf(terminalId))).toEqual([]);
  });

  it("types nothing for a prompt report that isn't the new shell's own", async () => {
    const { runtime, restart, prompt, refOf, terminalId: lost, lostToken } = await lostShell();
    const { terminalId } = await restart();
    const refused = [
      prompt(terminalId, ""),
      prompt(terminalId, "forged"),
      prompt(terminalId, lostToken),
      prompt(lost, lostToken),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([refused, runtime.pasted(refOf(terminalId))]).toEqual([
      [false, false, false, false],
      [],
    ]);
  });

  it("types nothing once its time to report a prompt has passed, and logs that without the line", async () => {
    const { runtime, restart, prompt, refOf, logs } = await lostShell({ retypeWithinMs: 20 });
    const { terminalId } = await restart();
    await new Promise((resolve) => setTimeout(resolve, 60));
    prompt(terminalId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.pasted(refOf(terminalId))).toEqual([]);
    expect(logs).toEqual([
      `shell ${terminalId}: last command not retyped: no prompt reported within 0.02 s`,
    ]);
  });

  it("refuses to retype a shell with no line kept, or with the integration off, and stays lost", async () => {
    const none = await lostShell({ line: null });
    const off = await lostShell({ restartedReporting: false });
    await expect(none.restart()).rejects.toThrow("no last command kept");
    await expect(off.restart()).rejects.toThrow("shell integration is off");
    expect([
      none.store.shell(none.terminalId)?.state,
      off.store.shell(off.terminalId)?.state,
    ]).toEqual(["lost", "lost"]);
  });

  it("keeps the line on the lost shell when its restart fails, for the next restart", async () => {
    const { restart, failOpens, retypeable, terminalId, store } = await lostShell();
    failOpens(true);
    await expect(restart()).rejects.toThrow(ShellOpenFailed);
    failOpens(false);
    expect([store.lastShellCommand(terminalId), retypeable(terminalId)]).toEqual([LINE, true]);
  });

  it("forgets the line from the lost shell's row, and writes it nowhere else", async () => {
    const {
      path,
      store,
      restart,
      prompt,
      runtime,
      refOf,
      terminalId: lost,
      logs,
    } = await lostShell();
    const { terminalId } = await restart();
    prompt(terminalId);
    await vi.waitFor(() => expect(runtime.pasted(refOf(terminalId))).toEqual([LINE]));
    const snapshot = JSON.stringify(store.snapshot(testView));
    expect([store.lastShellCommand(lost), store.lastShellCommand(terminalId)]).toEqual([
      null,
      null,
    ]);
    store.close();
    const raw = new DatabaseSync(path);
    const events = raw.prepare("SELECT count(*) AS n FROM events WHERE payload LIKE '%s3cret%'");
    expect([events.get()?.n, snapshot.includes("s3cret"), logs]).toEqual([0, false, []]);
    raw.close();
    expect(readFileSync(path).includes("s3cret")).toBe(false);
  });
});

/** Lines held for restarted shells, with what they pasted and logged. */
function held(withinMs = 30_000) {
  const pasted: string[] = [];
  const logs: string[] = [];
  const retypes = new PendingRetypes({
    paste: async (_ref, line) => void pasted.push(line),
    log: (message) => logs.push(message),
    withinMs,
  });
  return { retypes, pasted, logs };
}

describe("the lines held for restarted shells", () => {
  const id = newId("term");
  const ref: RuntimeRef = { terminalId: id, runtime: "fake", locator: {} };
  it("types a line whose prompt came before its shell's start returned, once it returns", async () => {
    const { retypes, pasted } = held();
    retypes.hold(id, "make");
    retypes.prompted(id);
    const early = [...pasted];
    retypes.opened(id, ref);
    await Promise.resolve();
    expect([early, pasted]).toEqual([[], ["make"]]);
  });

  it.each(["make\n", "make\r", "make\u001b[D"])(
    "never types a line holding a key: %j",
    async (line) => {
      const { retypes, pasted, logs } = held();
      retypes.hold(id, line);
      retypes.opened(id, ref);
      retypes.prompted(id);
      await Promise.resolve();
      expect([pasted, logs]).toEqual([
        [],
        [`shell ${id}: last command not retyped: it is not a line that can be typed safely`],
      ]);
    },
  );

  it("types nothing for a shell whose line was dropped, as one that failed to open", async () => {
    const { retypes, pasted } = held();
    retypes.hold(id, "make");
    retypes.drop(id);
    retypes.opened(id, ref);
    retypes.prompted(id);
    await Promise.resolve();
    expect(pasted).toEqual([]);
  });

  it("logs a failed paste by the runtime's message, which names no part of the line", async () => {
    const logs: string[] = [];
    const retypes = new PendingRetypes({
      paste: () => Promise.reject(new Error("tmux paste-buffer -t %3 failed")),
      log: (message) => logs.push(message),
    });
    retypes.hold(id, "make");
    retypes.opened(id, ref);
    retypes.prompted(id);
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs).toEqual([`shell ${id}: last command not retyped: tmux paste-buffer -t %3 failed`]);
  });
});
