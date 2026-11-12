// PermissionRequest with no decision, allow, deny, a late decision while the TUI prompt
// is up, and a hook that outlives its timeout. Each case runs in a fresh session (its own tmux
// window) and runs `touch marker-<case> && echo $((6*7))-<case>`; "42-<case>" in a tool result
// proves the tool ran. The hook's timeout is HOOK_TIMEOUT seconds.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { node, recordingHooks, Run, sleep } from "./env.ts";

const HOOK_TIMEOUT = 5;
const run = new Run("perm");
const cases: Record<string, unknown>[] = [];
const PROMPT_RE = /Do you want to proceed/;

function toolRan(tag: string): boolean {
  return run.requests().some((r) => {
    const msgs = (r.body as { messages?: { content: unknown }[] })?.messages ?? [];
    return msgs.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some((b) => b.type === "tool_result" && JSON.stringify(b).includes(`42-${tag}`)),
    );
  });
}

function permLog(since: number) {
  const f = join(run.dir, "perm.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => Date.parse(String(e.at)) >= since)
    .map((e) => `${e.what}${e.behavior ? ":" + e.behavior : ""}${e.signal ? ":" + e.signal : ""}@${e.ms}ms`);
}

/** Run one case in window `tag`. `answer` is pressed `answerAfterMs` after the prompt appears. */
async function runCase(tag: string, mode: string, opts: { answer?: "Escape" | "Enter"; answerAfterMs?: number; watchMs?: number } = {}) {
  writeFileSync(join(run.dir, "perm-mode"), mode);
  const startIdx = run.hooks().length;
  run.launch(tag, []);
  await run.waitEvent("SessionStart", startIdx, 30_000);
  await sleep(800);
  const before = run.hooks().length;
  const t0 = Date.now();
  await run.type(tag, `case ${tag} [[fake:bash:touch marker-${tag} && echo $((6*7))-${tag}]]`);
  const timeline: string[] = [];
  let promptAt: number | null = null;
  let answeredAt: number | null = null;
  let lastPrompt = false;
  const end = Date.now() + (opts.watchMs ?? 12_000);
  while (Date.now() < end) {
    const p = PROMPT_RE.test(run.capture(tag));
    const ms = Date.now() - t0;
    if (p !== lastPrompt) timeline.push(`${p ? "prompt-shown" : "prompt-gone"}@${ms}ms`);
    lastPrompt = p;
    if (p && promptAt === null) {
      promptAt = ms;
      writeFileSync(join(run.dir, `screen-${tag}.txt`), run.capture(tag));
    }
    if (opts.answer && promptAt !== null && answeredAt === null && ms - promptAt >= (opts.answerAfterMs ?? 0)) {
      run.keys(tag, opts.answer);
      answeredAt = ms;
      timeline.push(`pressed-${opts.answer}@${ms}ms`);
    }
    if (run.hooks().slice(before).some((h) => h.event === "Stop") && (answeredAt !== null || !opts.answer)) break;
    await sleep(200);
  }
  await sleep(1500);
  const evs = run.hooks().slice(before);
  const rec = {
    tag,
    mode,
    timeline,
    hook: permLog(t0),
    toolRan: toolRan(tag),
    events: evs.map((h) => `${h.event}${h.payload.notification_type ? ":" + String(h.payload.notification_type) : ""}@${Date.parse(h.received_at) - t0}ms`),
  };
  cases.push(rec);
  console.log(JSON.stringify(rec));
  try {
    run.keys(tag, "C-c");
    await sleep(300);
    run.keys(tag, "C-c");
  } catch {}
}

try {
  await run.startFake();
  run.writeSettings(
    recordingHooks({
      PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: node("hooks/permission.ts"), timeout: HOOK_TIMEOUT }] }],
    }),
  );
  const only = process.argv[2];
  if (only === "race") {
    await runCase("humanthenhook", "sleep:3:deny", { answer: "Enter", answerAfterMs: 800, watchMs: 12_000 });
    await sleep(4000);
    await runCase("human1s", "sleep:5:deny", { answer: "Enter", answerAfterMs: 1000, watchMs: 12_000 });
    await runCase("human2s", "sleep:5:deny", { answer: "Enter", answerAfterMs: 2000, watchMs: 12_000 });
    await runCase("humanno", "sleep:4:allow", { answer: "Escape", answerAfterMs: 1000, watchMs: 12_000 });
    throw new Error("done (race cases only)");
  }
  await runCase("allow", "allow");
  await runCase("deny", "deny");
  await runCase("silent", "silent", { answer: "Enter", answerAfterMs: 1000 });
  await runCase("lateallow", "sleep:3:allow", { watchMs: 12_000 });
  await runCase("latedeny", "sleep:3:deny", { watchMs: 12_000 });
  await runCase("humanfirst", "sleep:4:deny", { answer: "Enter", answerAfterMs: 0, watchMs: 12_000 });
  await runCase("timeout", `sleep:${HOOK_TIMEOUT * 4}`, { answer: "Enter", answerAfterMs: HOOK_TIMEOUT * 4 * 1000 + 3000, watchMs: 40_000 });
  await runCase("timeoutallow", `sleep:${HOOK_TIMEOUT * 2}:allow`, { watchMs: 20_000 });
  await runCase("esc", "silent", { answer: "Escape", answerAfterMs: 500 });
} catch (e) {
  console.log("ERROR", e);
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify({ cases }, null, 2));
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}
