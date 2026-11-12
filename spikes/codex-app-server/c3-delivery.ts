// C3: delivering a message to a thread while its TUI is live.
// Paths: the app-server's `turn/start`, `turn/steer`, and the CLI's `codex queue --thread`.
// Each runs on an idle thread and mid-turn (the TUI's prompt starts a SLOW turn of ~10 s).
// Recorded: does the TUI show it, does it start a turn, steer the running one or wait for the
// turn boundary, and when does it reach the model (the fake provider's request log)?
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Run, sleep } from "./harness.ts";
import type { RpcClient, RpcMessage } from "./rpc-client.ts";

const exec = promisify(execFile);

const run = await Run.start("c3");
try {
  const h = run.makeHome();
  const { sock } = await run.startAppServer(h);
  const remote = `unix://${sock}`;
  const bz = await run.client("bazhen", h, sock);
  const started = await bz.request("thread/start", { cwd: h.work });
  const threadId = (started.result as { thread: { id: string } }).thread.id;
  await bz.request("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "bz-agent-c3" }] }],
  });
  run.startTui(h, "tui", ["resume", threadId, "--remote", remote]);
  await sleep(5000);

  const turnEvents = (c: RpcClient, since: number) =>
    c.messages
      .filter((e) => e.dir === "in" && e.ts >= since)
      .map((e) => e.msg)
      .filter((m: RpcMessage) =>
        /^turn\/(started|completed)$|^thread\/queue\/changed$|^thread\/status\/changed$/.test(m.method ?? "") ||
        (m.method === "item/started" && (m.params as { item?: { type?: string } }).item?.type === "userMessage"),
      )
      .map((m) => ({
        method: m.method,
        turnId: (m.params as { turn?: { id?: string } }).turn?.id,
        status: (m.params as { status?: unknown }).status,
        item: m.method === "item/started" ? (m.params as { item?: unknown }).item : undefined,
      }));
  const providerSince = (n: number) =>
    run.providerTurns().slice(n).map((t) => ({ last: t.userMessages.slice(-3), reply: t.reply }));
  const idle = () =>
    bz.waitFor(
      (m) => m.method === "thread/status/changed" && (m.params as { status?: { type?: string } }).status?.type === "idle",
      30000,
      Date.now(),
    );
  const queue = (text: string, extra: string[] = []) =>
    exec("codex", ["queue", "--thread", threadId, "--message", text, "--remote", remote, ...extra], {
      env: h.env,
      cwd: h.work,
    }).then(
      (r) => ({ code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
    );

  async function scenario(label: string, midTurn: boolean, deliver: (turnId?: string) => Promise<unknown>) {
    const n = run.providerTurns().length;
    const t0 = Date.now();
    let turnId: string | undefined;
    if (midTurn) {
      run.type("tui", `SLOW ${label}`);
      const st = await bz.waitFor((m) => m.method === "turn/started", 15000, t0);
      turnId = (st.params as { turn: { id: string } }).turn.id;
      await sleep(2500);
    }
    const tDeliver = Date.now();
    const result = await deliver(turnId);
    run.log(`${label}.deliver.result`, { result });
    await sleep(2500);
    run.snapshot("tui", `${label}-soon-after`);
    // Wait for everything to settle: idle, then a little more for any follow-up turn.
    await idle().catch(() => run.log(`${label}.never.idle`));
    await sleep(4000);
    run.snapshot("tui", `${label}-settled`);
    run.log(`${label}.events`, { sinceDeliverMs: Date.now() - tDeliver, events: turnEvents(bz, t0) });
    run.log(`${label}.provider`, { turns: providerSince(n) });
  }

  // 1. turn/start on an idle thread.
  await scenario("S1-turnstart-idle", false, () =>
    bz.request("turn/start", { threadId, input: [{ type: "text", text: "BZMSG-1 turn/start idle" }] }),
  );
  // 2. turn/start while the TUI's turn runs.
  await scenario("S2-turnstart-midturn", true, () =>
    bz.request("turn/start", { threadId, input: [{ type: "text", text: "BZMSG-2 turn/start mid-turn" }] }),
  );
  // 3. turn/steer while the TUI's turn runs.
  await scenario("S3-steer-midturn", true, (turnId) =>
    bz.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: "BZMSG-3 turn/steer mid-turn" }],
    }),
  );
  // 4. codex queue on an idle thread (without, then with --resume).
  await scenario("S4-queue-idle", false, () => queue("BZMSG-4 queue idle"));
  await scenario("S4b-queue-idle-resume", false, () => queue("BZMSG-4b queue idle --resume", ["--resume"]));
  // 5. codex queue while the TUI's turn runs.
  await scenario("S5-queue-midturn", true, () => queue("BZMSG-5 queue mid-turn"));
} catch (error) {
  run.log("error", { message: (error as Error).message });
} finally {
  run.cleanup();
}
