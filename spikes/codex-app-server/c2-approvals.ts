// C2: does every connected client receive an approval request; does the first answer win; what
// do the other clients see; what does a late answer get?
// One thread, three clients: the TUI (resumed on the thread), "bazhen" (started the thread) and
// "other" (resumed it). The fake provider's RUN_CMD turn asks for an escalated shell command.
// Round 1: the TUI answers. Round 2: bazhen answers. Each round ends with a late answer from a
// client that didn't win.
import { Run, sleep } from "./harness.ts";
import type { RpcClient, RpcMessage } from "./rpc-client.ts";

const APPROVAL = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;
const isApproval = (m: RpcMessage) => m.id !== undefined && APPROVAL.test(m.method ?? "");

const run = await Run.start("c2");
try {
  const h = run.makeHome();
  const { sock } = await run.startAppServer(h);
  const bz = await run.client("bazhen", h, sock);
  const other = await run.client("other", h, sock);
  // Neither probe client answers on its own; the scenario decides who answers.
  bz.serverRequestHandler = () => undefined;
  other.serverRequestHandler = () => undefined;

  const started = await bz.request("thread/start", { cwd: h.work });
  const threadId = (started.result as { thread: { id: string } }).thread.id;
  await bz.request("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "bz-agent-c2" }] }],
  });
  const resumed = await other.request("thread/resume", { threadId, excludeTurns: true });
  run.log("other.resume", { error: resumed.error });
  run.startTui(h, "tui", ["resume", threadId, "--remote", `unix://${sock}`]);
  await sleep(5000);

  const statusOf = async (c: RpcClient) => {
    const r = await c.request("thread/read", { threadId, includeTurns: false });
    return (r.result as { thread?: { status?: unknown } } | undefined)?.thread?.status ?? r.error;
  };

  async function round(label: string, answer: "tui" | "bazhen", late: RpcClient) {
    const t0 = Date.now();
    const turn = await bz.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `RUN_CMD ${label}` }],
    });
    run.log(`${label}.turn.start`, { error: turn.error });
    const [reqBz, reqOther] = await Promise.all([
      bz.waitFor(isApproval, 20000, t0).catch(() => undefined),
      other.waitFor(isApproval, 20000, t0).catch(() => undefined),
    ]);
    run.log(`${label}.approval.received`, {
      bazhen: reqBz && { id: reqBz.id, method: reqBz.method, params: reqBz.params },
      other: reqOther && { id: reqOther.id, method: reqOther.method },
    });
    await sleep(1500);
    const tuiScreen = run.snapshot("tui", `${label}-approval-pending`);
    run.log(`${label}.tui.shows.prompt`, { shows: /approv|allow|run|proceed|yes/i.test(tuiScreen) });
    run.log(`${label}.status.pending`, { status: await statusOf(bz) });

    const tAnswer = Date.now();
    if (answer === "tui") {
      run.keys("tui", "y");
    } else if (reqBz?.id !== undefined) {
      bz.respond(reqBz.id, { decision: "accept" });
    }
    await bz
      .waitFor((m) => m.method === "turn/completed", 20000, tAnswer)
      .catch(() => run.log(`${label}.turn.never.completed`));
    await sleep(1000);
    const after = (c: RpcClient) =>
      c.messages
        .filter((e) => e.dir === "in" && e.ts >= tAnswer)
        .map((e) => e.msg)
        .filter((m) => /serverRequest\/resolved|item\/completed|item\/started|turn\/completed/.test(m.method ?? ""))
        .map((m) => ({ method: m.method, params: m.params }));
    run.log(`${label}.after.answer`, { bazhen: after(bz), other: after(other) });
    run.snapshot("tui", `${label}-after-answer`);
    run.log(`${label}.status.after`, { status: await statusOf(bz) });

    // A late answer from a client that didn't win.
    const lateReq = late === bz ? reqBz : reqOther;
    if (lateReq?.id !== undefined) {
      const tLate = Date.now();
      late.respond(lateReq.id, { decision: "decline" });
      await sleep(2000);
      run.log(`${label}.late.answer`, {
        from: late.name,
        received: late.messages.filter((e) => e.dir === "in" && e.ts >= tLate).map((e) => e.msg),
        proxyAlive: !late.exited,
      });
    }
    const turns = run.providerTurns();
    run.log(`${label}.provider.last`, { last: turns.at(-1) });
  }

  await round("R1", "tui", bz);
  await round("R2", "bazhen", other);
} catch (error) {
  run.log("error", { message: (error as Error).message });
} finally {
  run.cleanup();
}
