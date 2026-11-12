// An asyncRewake mail waiter: `node waiter.ts <EventName>`.
// Connects to $BZ_SPIKE_SOCK and waits. On {"mail": text} it writes text to stderr and exits 2,
// which wakes the session. On {"release": true} it exits 0. It reconnects with backoff if the
// socket drops, and limits its own life to $BZ_WAITER_MAX_SEC. Every step is logged to
// $BZ_SPIKE_DIR/waiter.jsonl, including signals, so a kill by Claude Code is visible.
import { appendFileSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

const dir = process.env.BZ_SPIKE_DIR;
const sockPath = process.env.BZ_SPIKE_SOCK;
if (!dir || !sockPath) process.exit(0);
const event = process.argv[2] ?? "?";
const maxSec = Number(process.env.BZ_WAITER_MAX_SEC ?? 21600);
const heartbeatSec = Number(process.env.BZ_WAITER_HEARTBEAT_SEC ?? 300);
const started = Date.now();

let payload: Record<string, unknown> = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
} catch {}
const ids = {
  session_id: payload.session_id ?? null,
  prompt_id: payload.prompt_id ?? null,
  source: payload.source ?? null,
  agent_id: payload.agent_id ?? null,
};

function log(what: string, extra: Record<string, unknown> = {}) {
  appendFileSync(
    join(dir!, "waiter.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      event,
      what,
      alive_sec: Math.round((Date.now() - started) / 1000),
      ...ids,
      ...extra,
    }) + "\n",
  );
}

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT", "SIGPIPE"] as const) {
  process.on(sig, () => {
    log("signal", { signal: sig });
    process.exit(0);
  });
}
process.on("exit", (code) => log("exit", { code }));

log("start");
setInterval(() => log("heartbeat"), heartbeatSec * 1000);
setTimeout(() => {
  log("expired");
  process.exit(0);
}, maxSec * 1000);

let backoff = 500;
function open() {
  const sock: Socket = connect(sockPath!);
  let buf = "";
  sock.on("connect", () => {
    backoff = 500;
    log("connected");
    sock.write(JSON.stringify({ hello: true, pid: process.pid, event, ...ids }) + "\n");
  });
  sock.on("data", (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line) as { mail?: string; release?: boolean };
      if (msg.release) {
        log("released");
        process.exit(0);
      }
      if (typeof msg.mail === "string") {
        log("wake", { bytes: msg.mail.length });
        process.stderr.write(msg.mail, () => {
          sock.write(JSON.stringify({ emitted: true, pid: process.pid }) + "\n", () => process.exit(2));
        });
      }
    }
  });
  sock.on("error", (e) => log("socket-error", { error: (e as NodeJS.ErrnoException).code }));
  sock.on("close", () => {
    log("socket-closed", { retry_ms: backoff });
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}
open();
