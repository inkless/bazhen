// C1: how is a TUI that Bazhen launched bound to its thread?
// A. Bazhen creates the thread over the app-server, then launches `codex resume <id> --remote`.
//    Tried both before the thread's first turn and after it.
// B. Bazhen launches a plain TUI on the app-server and learns its thread id from notifications.
// C. Bazhen names the thread (thread/name/set) and resumes it by name.
import { Run, sleep } from "./harness.ts";
import type { RpcMessage } from "./rpc-client.ts";

const run = await Run.start("c1");
try {
  if (process.env["C1_SKIP_R1"]) throw new Error("round 1 skipped");
  const h = run.makeHome();
  const { sock } = await run.startAppServer(h);
  const bz = await run.client("bazhen", h, sock);
  const remote = `unix://${sock}`;

  // --- A1: thread/start, no turn yet, then resume it in the TUI.
  const started = await bz.request("thread/start", { cwd: h.work });
  const threadA = (started.result as { thread: { id: string } }).thread.id;
  run.log("A1.thread.start", { threadA, result: started.result });
  run.startTui(h, "a1", ["resume", threadA, "--remote", remote]);
  await sleep(6000);
  run.snapshot("a1", "A1-resume-empty-thread");
  const listA1 = await bz.request("thread/loaded/list", {});
  run.log("A1.loaded", { result: listA1.result });

  // Type into the TUI; does the turn land on threadA, and does Bazhen see it?
  const t0 = Date.now();
  run.type("a1", "hello from tui A1");
  const turnSeen = await bz
    .waitFor((m) => m.method === "turn/started", 15000, t0)
    .catch((e: Error) => ({ method: `timeout: ${e.message}` }) as RpcMessage);
  run.log("A1.turn.seen.by.bazhen", { msg: turnSeen });
  await sleep(3000);
  run.snapshot("a1", "A1-after-turn");

  // --- A2: a thread that already has a turn (started by Bazhen), then resume in a TUI.
  const s2 = await bz.request("thread/start", { cwd: h.work });
  const threadA2 = (s2.result as { thread: { id: string } }).thread.id;
  await bz.request("turn/start", { threadId: threadA2, input: [{ type: "text", text: "first turn from bazhen" }] });
  await bz.waitFor(
    (m) => m.method === "turn/completed" && (m.params as { threadId?: string }).threadId === threadA2,
    20000,
  );
  run.startTui(h, "a2", ["resume", threadA2, "--remote", remote]);
  await sleep(6000);
  run.snapshot("a2", "A2-resume-thread-with-turn");

  // --- C: name a thread and resume by name.
  const s3 = await bz.request("thread/start", { cwd: h.work });
  const threadC = (s3.result as { thread: { id: string } }).thread.id;
  const named = await bz.request("thread/name/set", { threadId: threadC, name: "bz-agent-c" });
  run.log("C.name.set", { threadC, reply: named });
  run.startTui(h, "c", ["resume", "bz-agent-c", "--remote", remote]);
  await sleep(6000);
  run.snapshot("c", "C-resume-by-name");

  // --- B: a plain TUI on the app-server; what does Bazhen learn?
  const tB = Date.now();
  run.startTui(h, "b", ["--remote", remote]);
  await sleep(6000);
  run.snapshot("b", "B-plain-tui");
  const startedB = bz.received("thread/started", tB);
  run.log("B.thread.started.before.prompt", { count: startedB.length, msgs: startedB });
  run.type("b", "hello from plain tui");
  await sleep(5000);
  run.log("B.notifications.after.prompt", {
    methods: bz.messages.filter((e) => e.ts >= tB && e.dir === "in").map((e) => e.msg.method),
    threadStarted: bz.received("thread/started", tB),
  });
  const loaded = await bz.request("thread/loaded/list", {});
  const list = await bz.request("thread/list", {});
  run.log("B.lists", { loaded: loaded.result, list: list.result });
} catch (error) {
  run.log("error", { message: (error as Error).message });
} finally {
  run.cleanup();
}

// ---------------------------------------------------------------------------------------------
// Round 2: ways to bind natively without a model turn.
const run2 = await Run.start("c1r2");
try {
  const h = run2.makeHome();
  const { sock } = await run2.startAppServer(h);
  const bz = await run2.client("bazhen", h, sock);
  const remote = `unix://${sock}`;

  // D: thread/start, then thread/inject_items (no model call), then resume in the TUI.
  const sD = await bz.request("thread/start", { cwd: h.work });
  const threadD = (sD.result as { thread: { id: string } }).thread.id;
  const inj = await bz.request("thread/inject_items", {
    threadId: threadD,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Bazhen agent bz-agent-d" }],
      },
    ],
  });
  run2.log("D.inject", { threadD, reply: inj });
  const named = await bz.request("thread/name/set", { threadId: threadD, name: "bz-agent-d" });
  run2.log("D.name", { reply: named });
  run2.startTui(h, "d", ["resume", threadD, "--remote", remote]);
  await sleep(6000);
  run2.snapshot("d", "D-resume-after-inject");
  run2.startTui(h, "dn", ["resume", "bz-agent-d", "--remote", remote]);
  await sleep(6000);
  run2.snapshot("dn", "D-resume-by-name-after-inject");

  // Typing in the TUI on threadD: Bazhen started the thread, so is it subscribed to its turns?
  const t0 = Date.now();
  run2.type("d", "hello from tui D");
  const seen = await bz
    .waitFor((m) => m.method === "turn/completed", 15000, t0)
    .then((m) => m.params)
    .catch((e: Error) => `timeout: ${e.message}`);
  run2.log("D.bazhen.sees.tui.turn", { seen });
  run2.snapshot("d", "D-after-tui-turn");

  // E: plain TUI with an originator override in its environment; then Bazhen subscribes.
  const tE = Date.now();
  const envBackup = h.env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"];
  h.env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"] = "bazhen_agent_e";
  const startTuiWithEnv = (window: string, args: string[]) => {
    const cmd = `env CODEX_INTERNAL_ORIGINATOR_OVERRIDE=bazhen_agent_e codex ${args.join(" ")}`;
    run2.tmux(
      "new-window", "-d", "-e", `CODEX_HOME=${h.codexHome}`,
      "-e", "BZ_FAKE_KEY=dummy", "-n", window, "-c", h.work, cmd,
    );
  };
  startTuiWithEnv("e", ["--remote", remote]);
  h.env["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"] = envBackup;
  const startedE = await bz.waitFor((m) => m.method === "thread/started", 15000, tE);
  const threadE = (startedE.params as { thread: { id: string; originator: string; source: string } }).thread;
  run2.log("E.thread.started", { id: threadE.id, originator: threadE.originator, source: threadE.source });
  run2.snapshot("e", "E-plain-tui");
  const resumed = await bz.request("thread/resume", { threadId: threadE.id, excludeTurns: true });
  run2.log("E.bazhen.resume", { error: resumed.error, keys: Object.keys((resumed.result as object) ?? {}) });
  const t1 = Date.now();
  run2.type("e", "hello from tui E");
  const seenE = await bz
    .waitFor((m) => m.method === "turn/completed", 15000, t1)
    .then((m) => m.params)
    .catch((e: Error) => `timeout: ${e.message}`);
  run2.log("E.bazhen.sees.tui.turn.after.resume", { seenE });
  run2.snapshot("e", "E-after-turn");
} catch (error) {
  run2.log("error", { message: (error as Error).message });
} finally {
  run2.cleanup();
}
