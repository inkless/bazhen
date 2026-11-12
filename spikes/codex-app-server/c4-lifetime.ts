// C4: app-server lifetime and isolation.
// A. `proxy` with no server behind the socket.
// B. The server outlives a client: kill the proxy mid-turn, reconnect, re-read the thread.
// C. A pending approval across a proxy restart: is it re-sent after reconnecting?
// D. The TUI when the app-server dies under it.
// E. Two Codex homes: two servers, and neither sees the other's threads.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Run, sleep } from "./harness.ts";
import type { RpcMessage } from "./rpc-client.ts";

const exec = promisify(execFile);
const APPROVAL = /requestApproval$/;

const run = await Run.start("c4");
try {
  const h = run.makeHome();

  // --- A: proxy with nothing listening.
  const missing = join(h.root, "nothing.sock");
  const a = await exec("codex", ["app-server", "proxy", "--sock", missing], { env: h.env, timeout: 10000 }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code?: number; stderr?: string; killed?: boolean }) => ({ code: e.code, killed: e.killed, stderr: e.stderr }),
  );
  run.log("A.proxy.no.server", a);

  const { proc: server, sock } = await run.startAppServer(h);
  const c1 = await run.client("bazhen-1", h, sock);
  c1.serverRequestHandler = () => undefined;
  const started = await c1.request("thread/start", { cwd: h.work });
  const threadId = (started.result as { thread: { id: string } }).thread.id;
  await c1.request("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "bz-agent-c4" }] }],
  });

  // --- B: kill the proxy mid-turn.
  const tB = Date.now();
  await c1.request("turn/start", { threadId, input: [{ type: "text", text: "SLOW c4-B" }] });
  await c1.waitFor((m) => m.method === "turn/started", 10000, tB);
  await sleep(2000);
  c1.close();
  await sleep(500);
  run.log("B.proxy.killed", { serverAlive: server.exitCode === null && !server.killed });
  await sleep(1500);
  const c2 = await run.client("bazhen-2", h, sock);
  c2.serverRequestHandler = () => undefined;
  const loaded = await c2.request("thread/loaded/list", {});
  const read = await c2.request("thread/read", { threadId, includeTurns: false });
  run.log("B.reconnect.before.resume", {
    loaded: loaded.result,
    status: (read.result as { thread?: { status?: unknown } })?.thread?.status,
  });
  const resumed = await c2.request("thread/resume", { threadId, excludeTurns: true });
  run.log("B.resume", { error: resumed.error });
  const done = await c2
    .waitFor((m) => m.method === "turn/completed", 20000, tB)
    .then((m) => (m.params as { turn: { status: string; items: { type: string; text?: string }[] } }).turn)
    .catch((e: Error) => `timeout: ${e.message}`);
  run.log("B.turn.after.reconnect", { done });

  // --- C: pending approval across a proxy restart.
  const tC = Date.now();
  await c2.request("turn/start", { threadId, input: [{ type: "text", text: "RUN_CMD c4-C" }] });
  const req = await c2.waitFor((m) => m.id !== undefined && APPROVAL.test(m.method ?? ""), 15000, tC);
  run.log("C.approval.pending", { id: req.id, itemId: (req.params as { itemId: string }).itemId });
  c2.close();
  await sleep(2000);
  const c3 = await run.client("bazhen-3", h, sock);
  let reSent: RpcMessage | undefined;
  c3.serverRequestHandler = (m) => {
    if (APPROVAL.test(m.method ?? "")) reSent = m;
    return undefined;
  };
  const read3 = await c3.request("thread/read", { threadId, includeTurns: false });
  run.log("C.status.after.reconnect", { status: (read3.result as { thread?: { status?: unknown } })?.thread?.status });
  const tR = Date.now();
  await c3.request("thread/resume", { threadId, excludeTurns: true });
  await sleep(3000);
  run.log("C.after.resume", {
    approvalReSent: reSent ? { id: reSent.id, itemId: (reSent.params as { itemId: string }).itemId } : null,
    methods: c3.messages.filter((e) => e.dir === "in" && e.ts >= tR).map((e) => e.msg.method ?? `reply#${e.msg.id}`),
  });
  if (reSent?.id !== undefined) {
    c3.respond(reSent.id, { decision: "accept" });
    const end = await c3
      .waitFor((m) => m.method === "turn/completed", 15000, tR)
      .then(() => "completed")
      .catch(() => "timeout");
    run.log("C.answered.after.reconnect", { end });
  } else {
    await c3.request("turn/interrupt", { threadId, turnId: (req.params as { turnId: string }).turnId });
  }

  // --- D: the TUI when the app-server dies.
  run.startTui(h, "tui", ["resume", threadId, "--remote", `unix://${sock}`]);
  await sleep(5000);
  run.snapshot("tui", "D-before-server-death");
  server.kill("SIGTERM");
  await sleep(4000);
  run.snapshot("tui", "D-after-server-death");
  run.type("tui", "hello after server death");
  await sleep(3000);
  run.snapshot("tui", "D-typed-after-server-death");
  // Restart the server on the same socket path: does the TUI recover by itself?
  await run.startAppServer(h);
  await sleep(6000);
  run.snapshot("tui", "D-after-server-restart");

  // --- E: two homes.
  const h2 = run.makeHome("h2");
  const { sock: sock2 } = await run.startAppServer(h2);
  const e2 = await run.client("home2", h2, sock2);
  const init2 = e2.messages.find((m) => m.dir === "in" && m.msg.id === 1)?.msg.result as { codexHome?: string };
  const list2 = await e2.request("thread/list", {});
  const read2 = await e2.request("thread/read", { threadId, includeTurns: false });
  run.log("E.second.home", {
    codexHome: init2?.codexHome,
    threads: (list2.result as { data: { id: string }[] }).data.map((t) => t.id),
    readHome1Thread: read2.error ?? "visible!",
  });
} catch (error) {
  run.log("error", { message: (error as Error).message, stack: (error as Error).stack });
} finally {
  run.cleanup();
}
