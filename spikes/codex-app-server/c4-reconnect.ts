// C4 follow-up: does a `--remote` TUI recover by itself once its app-server comes back?
import { Run, sleep } from "./harness.ts";

const run = await Run.start("c4reconnect");
try {
  const h = run.makeHome();
  const { proc, sock } = await run.startAppServer(h);
  const bz = await run.client("bazhen", h, sock);
  const s = await bz.request("thread/start", { cwd: h.work });
  const threadId = (s.result as { thread: { id: string } }).thread.id;
  await bz.request("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "bz-agent-d2" }] }],
  });
  run.startTui(h, "tui", ["resume", threadId, "--remote", `unix://${sock}`]);
  await sleep(5000);
  proc.kill("SIGTERM");
  await sleep(3000);
  const restarted = await run.startAppServer(h);
  const t0 = Date.now();
  let screen = "";
  while (Date.now() - t0 < 90000) {
    screen = run.capture("tui");
    if (!/Reconnecting/.test(screen)) break;
    await sleep(2000);
  }
  run.log("reconnect.reconnect", { recovered: !/Reconnecting/.test(screen), afterMs: Date.now() - t0 });
  run.snapshot("tui", "reconnect-final");
  run.type("tui", "hello after restart");
  await sleep(4000);
  run.snapshot("tui", "reconnect-typed");
  const bz2 = await run.client("bazhen-2", h, restarted.sock);
  const list = await bz2.request("thread/list", {});
  run.log("reconnect.threads.after", {
    boundThread: threadId,
    threads: (list.result as { data: { id: string; preview: string }[] }).data.map((t) => ({ id: t.id, preview: t.preview })),
  });
  run.log("reconnect.provider", { last: run.providerTurns().map((t) => t.reply) });
} catch (error) {
  run.log("error", { message: (error as Error).message });
} finally {
  run.cleanup();
}
