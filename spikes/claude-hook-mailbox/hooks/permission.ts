// A PermissionRequest hook driven by $BZ_SPIKE_DIR/perm-mode:
//   silent      exit 0 with no output (no decision)
//   allow|deny  return that decision
//   sleep:<s>   sleep <s> seconds, then exit 0 with no output
//   sleep:<s>:allow|deny   sleep <s> seconds, then return that decision
// Logs start, outcome and any signal to perm.jsonl.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BZ_SPIKE_DIR;
if (!dir) process.exit(0);
let payload: Record<string, unknown> = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
} catch {}
const modeFile = join(dir, "perm-mode");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "silent";
const started = Date.now();
const log = (what: string, extra: Record<string, unknown> = {}) =>
  appendFileSync(
    join(dir, "perm.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      mode,
      what,
      ms: Date.now() - started,
      tool_use_id: payload.tool_use_id ?? null,
      ...extra,
    }) + "\n",
  );
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(sig, () => {
    log("signal", { signal: sig });
    process.exit(0);
  });
log("start", { keys: Object.keys(payload) });

const decide = (behavior: "allow" | "deny") => {
  const decision = behavior === "allow" ? { behavior } : { behavior, message: "denied by probe hook" };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
  log("decided", { behavior });
};

if (mode === "allow" || mode === "deny") decide(mode);
else if (mode.startsWith("sleep:")) {
  const [, secStr, then] = mode.split(":");
  setTimeout(() => {
    if (then === "allow" || then === "deny") decide(then);
    else log("woke-silent");
    process.exit(0);
  }, Number(secStr) * 1000);
} else log("silent");
