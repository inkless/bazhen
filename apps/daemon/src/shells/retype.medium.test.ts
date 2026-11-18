import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type RuntimeRef } from "@bazhen/core";
import { FakeRuntime, type Pasted } from "@bazhen/core/testing";
import { LocalEnvironment } from "@bazhen/env-local";
import { localEnvironmentId } from "../agents/launch.ts";
import { AgentQueue } from "../agents/queue.ts";
import { Store } from "../store/store.ts";
import { testView, unlimited } from "../testing/fixtures.ts";
import { ShellLifecycle, ShellOpenFailed } from "./lifecycle.ts";
import { ShellReports } from "./reports.ts";
import { PendingRetypes, RETYPE_WITHIN_MS, type After } from "./retype.ts";

const INTEGRATION = { hook: "/state/hook/bazhen-hook", dir: "/state/shell-integration" };
const LINE = `echo "$HOME" 'a  b' TOKEN=s3cret`;
/** What the daemon logs for a shell whose integration said it won't take a line typed back. */
const DECLINED = "the shell's integration said it can't take a line typed back";

/** A clock that runs what is scheduled on it only as a test lets time pass. */
function testClock() {
  let now = 0;
  const due: { at: number; run: () => void; cancelled: boolean }[] = [];
  const after: After = (ms, run) => {
    const timer = { at: now + ms, run, cancelled: false };
    due.push(timer);
    return () => (timer.cancelled = true);
  };
  /**
   * Lets `ms` pass, running what falls due in that time in order, each once what was running has
   * settled, so a wait that schedules the next one sees it come due too.
   */
  const pass = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await new Promise((settled) => setImmediate(settled));
      const next = due
        .filter((t) => !t.cancelled && t.at <= end)
        .toSorted((x, y) => x.at - y.at)[0];
      if (next === undefined) break;
      now = next.at;
      next.cancelled = true;
      next.run();
    }
    now = end;
  };
  return { after, pass };
}

/** A lost shell whose integration kept `line`, on a fake runtime, with what restarts it. */
async function lostShell({
  line = LINE,
  restartedReporting = true,
}: {
  line?: string | null;
  /** Whether the daemon that restarts the shell has the integration, as one without its hook doesn't. */
  restartedReporting?: boolean;
} = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "bz-retype-")), "bazhen.db");
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
  let opensFail = false;
  const openShell = environment.openShell.bind(environment);
  environment.openShell = async (open) => {
    if (opensFail) throw new Error("tmux refused");
    return openShell(open);
  };
  // Seen as the daemon asks for each paste, so a test needn't wait to know none was asked for.
  const pasted: Pasted[] = [];
  const pasteShell = environment.pasteShell.bind(environment);
  environment.pasteShell = (ref, text, brackets) => {
    pasted.push({ text, brackets });
    return pasteShell(ref, text, brackets);
  };
  const clock = testClock();
  const logs: string[] = [];
  const lifecycle = (reporting: boolean) =>
    new ShellLifecycle({
      store,
      environment,
      queue: new AgentQueue(),
      size: { cols: 80, rows: 24 },
      home: tmpdir(),
      budget: unlimited,
      retypeAfter: clock.after,
      log: (message) => logs.push(message),
      ...(reporting && { integration: INTEGRATION }),
    });
  const opener = lifecycle(true);
  const shells = restartedReporting ? opener : lifecycle(false);
  const reports = new ShellReports(store, shells);
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
  const prompt = (id: string, token = tokenOf(id), brackets?: boolean) =>
    reports.prompt(id, { token, ...(brackets !== undefined && { brackets }) });
  /** The new shell's integration says, with `token`, that it won't take a line typed back. */
  const decline = (id: string, token = tokenOf(id)) => reports.decline(id, { token });
  const retypeable = (id: string, shellsReport = true) =>
    store.snapshot({ ...testView, shellsReport }).shells.find((s) => s.id === id)?.retypeable;
  return {
    path,
    store,
    runtime,
    shells,
    terminalId,
    lostToken,
    logs,
    pasted,
    clock,
    reports,
    tokenOf,
    restart,
    prompt,
    decline,
    retypeable,
    refOf,
    failOpens: (fail: boolean) => (opensFail = fail),
  };
}

describe("restarting a lost shell with its last line typed back", () => {
  it("offers it only for a lost shell whose line was kept, while new shells can report", async () => {
    const kept = await lostShell();
    const none = await lostShell({ line: null });
    const offered = [
      kept.retypeable(kept.terminalId),
      none.retypeable(none.terminalId),
      kept.retypeable(kept.terminalId, false),
    ];
    const { terminalId: running } = await kept.restart(false);
    kept.reports.report(running, { token: kept.tokenOf(running), at: 2, command: "make" });
    expect([...offered, kept.store.lastShellCommand(running), kept.retypeable(running)]).toEqual([
      true,
      false,
      false,
      "make",
      false,
    ]);
  });

  it("types the line, exactly, only once the new shell reports its first prompt, and once", async () => {
    const { runtime, restart, prompt, refOf, pasted } = await lostShell();
    const { terminalId } = await restart();
    const before = [...pasted];
    expect(prompt(terminalId)).toBe(true);
    prompt(terminalId);
    const typed = { text: LINE, brackets: false };
    await expect.poll(() => runtime.pasted(refOf(terminalId))).toEqual([typed]);
    expect([before, pasted]).toEqual([[], [typed]]);
  });

  it("marks the paste itself only where the shell's own prompt report says its editor reads one", async () => {
    const marked = await lostShell();
    const unmarked = await lostShell();
    const a = await marked.restart();
    const b = await unmarked.restart();
    marked.prompt(a.terminalId, marked.tokenOf(a.terminalId), true);
    unmarked.prompt(b.terminalId, unmarked.tokenOf(b.terminalId), false);
    await expect
      .poll(() => [marked.pasted, unmarked.pasted])
      .toEqual([[{ text: LINE, brackets: true }], [{ text: LINE, brackets: false }]]);
  });

  it("types nothing while a program other than the shell keeps its foreground, and says so", async () => {
    const { runtime, restart, prompt, refOf, pasted, logs, clock } = await lostShell();
    const { terminalId } = await restart();
    runtime.runInForeground(refOf(terminalId), "vim");
    prompt(terminalId);
    await clock.pass(2_900);
    const early = [...logs];
    await clock.pass(200);
    expect([early, pasted, logs]).toEqual([
      [],
      [],
      [`shell ${terminalId}: last command not retyped: vim kept the shell's foreground`],
    ]);
  });

  it("types nothing behind input typed ahead of it, which whatever it starts would read", async () => {
    const { runtime, restart, prompt, refOf, logs } = await lostShell();
    const { terminalId } = await restart();
    runtime.typeAhead(refOf(terminalId), "cat > notes\r");
    prompt(terminalId);
    await expect
      .poll(() => logs)
      .toEqual([
        `shell ${terminalId}: last command not retyped: the shell isn't reading at its prompt`,
      ]);
    expect(runtime.pasted(refOf(terminalId))).toEqual([]);
  });

  it("waits for the shell to hold its foreground again, as after a program its prompt runs", async () => {
    const { runtime, restart, prompt, refOf, pasted, clock } = await lostShell();
    const { terminalId } = await restart();
    runtime.runInForeground(refOf(terminalId), "git");
    prompt(terminalId);
    await clock.pass(500);
    const waiting = [...pasted];
    runtime.runInForeground(refOf(terminalId), null);
    await clock.pass(100);
    expect([waiting, pasted]).toEqual([[], [{ text: LINE, brackets: false }]]);
  });

  it("types nothing into a shell restarted without asking to retype", async () => {
    const { restart, prompt, pasted } = await lostShell();
    const { terminalId } = await restart(false);
    prompt(terminalId);
    expect(pasted).toEqual([]);
  });

  it("types nothing for a prompt report that isn't the new shell's own", async () => {
    const { restart, prompt, pasted, terminalId: lost, lostToken } = await lostShell();
    const { terminalId } = await restart();
    const refused = [
      prompt(terminalId, ""),
      prompt(terminalId, "forged"),
      prompt(terminalId, lostToken),
      prompt(lost, lostToken),
    ];
    expect([refused, pasted]).toEqual([[false, false, false, false], []]);
  });

  it("types nothing once its time to report a prompt has passed, and logs that without the line", async () => {
    const { restart, prompt, pasted, logs, clock } = await lostShell();
    const { terminalId } = await restart();
    await clock.pass(RETYPE_WITHIN_MS - 1);
    const early = [...logs];
    await clock.pass(1);
    prompt(terminalId);
    expect([early, pasted, logs]).toEqual([
      [],
      [],
      [`shell ${terminalId}: last command not retyped: no prompt reported within 30 s`],
    ]);
  });

  it("reads a prompt report with no word on retyping as one to type into, as before", async () => {
    const plain = await lostShell();
    const marked = await lostShell();
    const a = await plain.restart();
    const b = await marked.restart();
    plain.reports.prompt(a.terminalId, { token: plain.tokenOf(a.terminalId) });
    marked.reports.prompt(b.terminalId, { token: marked.tokenOf(b.terminalId), brackets: true });
    await expect
      .poll(() => [plain.pasted, marked.pasted, plain.logs, marked.logs])
      .toEqual([[{ text: LINE, brackets: false }], [{ text: LINE, brackets: true }], [], []]);
  });

  it("drops the line as soon as the new shell says it won't take one, and logs that without the line", async () => {
    const { restart, decline, prompt, pasted, logs, clock } = await lostShell();
    const { terminalId } = await restart();
    expect(decline(terminalId)).toBe(true);
    const at = [...logs];
    prompt(terminalId);
    await clock.pass(RETYPE_WITHIN_MS);
    expect([at, pasted, logs]).toEqual([
      [`shell ${terminalId}: last command not retyped: ${DECLINED}`],
      [],
      [`shell ${terminalId}: last command not retyped: ${DECLINED}`],
    ]);
  });

  it("keeps the line for a word that it won't take one that isn't the new shell's own", async () => {
    const {
      restart,
      decline,
      prompt,
      pasted,
      logs,
      terminalId: lost,
      lostToken,
    } = await lostShell();
    const { terminalId } = await restart();
    const refused = [
      decline(terminalId, "forged"),
      decline(terminalId, lostToken),
      decline(lost, lostToken),
    ];
    prompt(terminalId);
    await expect.poll(() => pasted).toEqual([{ text: LINE, brackets: false }]);
    expect([refused, logs]).toEqual([[false, false, false], []]);
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
    await expect
      .poll(() => runtime.pasted(refOf(terminalId)))
      .toEqual([{ text: LINE, brackets: false }]);
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
function held() {
  const pasted: string[] = [];
  const marked: boolean[] = [];
  const logs: string[] = [];
  const retypes = new PendingRetypes({
    paste: async (_ref, line, brackets) => {
      pasted.push(line);
      marked.push(brackets);
    },
    log: (message) => logs.push(message),
    after: testClock().after,
  });
  return { retypes, pasted, marked, logs };
}

describe("the lines held for restarted shells", () => {
  const id = newId("term");
  const ref: RuntimeRef = { terminalId: id, runtime: "fake", locator: {} };
  it("types a line whose prompt came before its shell's start returned, once it returns", async () => {
    const { retypes, pasted } = held();
    retypes.hold(id, "make");
    retypes.prompted(id, false);
    const early = [...pasted];
    retypes.opened(id, ref);
    expect([early, pasted]).toEqual([[], ["make"]]);
  });

  it("marks the paste as its shell's first prompt report asked, not a later one", () => {
    const { retypes, marked } = held();
    retypes.hold(id, "make");
    retypes.prompted(id, true);
    retypes.prompted(id, false);
    retypes.opened(id, ref);
    expect(marked).toEqual([true]);
  });

  it("drops a line its shell won't take before the shell's start returns, and types nothing", () => {
    const { retypes, pasted, logs } = held();
    retypes.hold(id, "make");
    retypes.declined(id);
    retypes.opened(id, ref);
    retypes.prompted(id, false);
    expect([pasted, logs]).toEqual([[], [`shell ${id}: last command not retyped: ${DECLINED}`]]);
  });

  it("goes by its shell's first report, so a word that it won't take a line after a prompt changes nothing", () => {
    const { retypes, pasted, logs } = held();
    retypes.hold(id, "make");
    retypes.prompted(id, false);
    retypes.declined(id);
    retypes.opened(id, ref);
    expect([pasted, logs]).toEqual([["make"], []]);
  });

  it("logs nothing for a shell with no line held that says it won't take one", () => {
    const { retypes, logs } = held();
    retypes.declined(id);
    expect(logs).toEqual([]);
  });

  it.each(["make\n", "make\r", "make\u001b[D"])("never types a line holding a key: %j", (line) => {
    const { retypes, pasted, logs } = held();
    retypes.hold(id, line);
    retypes.opened(id, ref);
    retypes.prompted(id, false);
    expect([pasted, logs]).toEqual([
      [],
      [`shell ${id}: last command not retyped: it is not a line that can be typed safely`],
    ]);
  });

  it("types nothing for a shell whose line was dropped, as one that failed to open", async () => {
    const { retypes, pasted } = held();
    retypes.hold(id, "make");
    retypes.drop(id);
    retypes.opened(id, ref);
    retypes.prompted(id, false);
    expect(pasted).toEqual([]);
  });

  it("logs a failed paste by the runtime's message, which names no part of the line", async () => {
    const logs: string[] = [];
    const retypes = new PendingRetypes({
      paste: () => Promise.reject(new Error("tmux paste-buffer -t %3 failed")),
      log: (message) => logs.push(message),
      after: testClock().after,
    });
    retypes.hold(id, "make");
    retypes.opened(id, ref);
    retypes.prompted(id, false);
    await expect
      .poll(() => logs)
      .toEqual([`shell ${id}: last command not retyped: tmux paste-buffer -t %3 failed`]);
  });
});
