// `node sleeper.ts <label> <seconds> <exitCode>`: sleep, then exit with that code (writing a
// marked message to stderr first when the code is 2). Logs start, signals and exit to
// sleeper.jsonl, so a kill by Claude Code at the hook's timeout is visible.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BZ_SPIKE_DIR;
if (!dir) process.exit(0);
const [label = "?", secStr = "10", codeStr = "0"] = process.argv.slice(2);
try {
  readFileSync(0, "utf8");
} catch {}
const started = Date.now();
const log = (what: string, extra: Record<string, unknown> = {}) =>
  appendFileSync(
    join(dir, "sleeper.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), label, pid: process.pid, what, ms: Date.now() - started, ...extra }) + "\n",
  );
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(sig, () => {
    log("signal", { signal: sig });
    process.exit(0);
  });
log("start");
setTimeout(() => {
  const code = Number(codeStr);
  log("done", { code });
  if (code === 2) process.stderr.write(`SLEEPER-${label} woke after ${secStr}s`, () => process.exit(2));
  else process.exit(code);
}, Number(secStr) * 1000);
