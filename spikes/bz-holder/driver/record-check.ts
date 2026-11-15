// Checks record.ts end to end: `node driver/record-check.ts [path/to/record.ts]`. Runs the recorder
// inside an outer holder that stands in for the user's terminal, on a probe program that turns on
// mouse, paste, focus, cursor-key, keypad and keyboard protocols, and ends it each way a user can.
// After each, the outer terminal must have every mode off, the recorder must have exited with the
// expected code, and neither the inner holder nor its program may be left alive.
import fs from "node:fs";
import path from "node:path";
import { Conn, K, PROGRAMS, SPIKE, alive, bytesOf, frame, makeHome, newTerm, ptyGuard, reap, sleep, spawnHolder, u64, write, type Hello } from "./lib.ts";
import { RESTORE } from "./tty.ts";

const RECORD = path.resolve(process.argv[2] ?? path.join(SPIKE, "driver", "record.ts"));
const PROBE = "rc-probe";
const ENABLE = "\\033[?1000h\\033[?1002h\\033[?1006h\\033[?2004h\\033[?1004h\\033[?1h\\033=\\033[?25l\\033[>1u\\033[>4;2m\\033[?1049h";
const SCRIPT = `#!/bin/sh
printf '${ENABLE}'
trap 'echo cancelled' INT
echo ready
while :; do if read line; then [ "$line" = q ] && exit 0; fi; done
`;

interface Case {
  name: string;
  end: (run: Run) => Promise<void>;
  code: number;
  partial: boolean;
}

interface Run {
  outer: Conn;
  recorderPid: number;
  inner: { holderPid: number; childPid: number };
  screen: () => string;
}

const cases: Case[] = [
  { name: "Ctrl-] as 0x1d", end: async (r) => r.outer.send(frame(K.INPUT, "\x1d")), code: 0, partial: false },
  { name: "Ctrl-] as kitty CSI 93;5u", end: async (r) => r.outer.send(frame(K.INPUT, "\x1b[93;5u")), code: 0, partial: false },
  { name: "the program exits", end: async (r) => r.outer.send(frame(K.INPUT, "q\r")), code: 0, partial: false },
  {
    name: "Ctrl-C the program traps, then it exits",
    end: async (r) => {
      r.outer.send(frame(K.INPUT, "\x03"));
      await until(() => r.screen().includes("cancelled"), 3000, "the program to print cancelled");
      await sleep(300);
      if (!alive(r.recorderPid)) throw new Error("the recorder ended on Ctrl-C");
      r.outer.send(frame(K.INPUT, "q\r"));
    },
    code: 0,
    partial: false,
  },
  { name: "SIGTERM to the recorder", end: async (r) => process.kill(r.recorderPid, "SIGTERM"), code: 143, partial: false },
  { name: "the inner holder is killed", end: async (r) => process.kill(r.inner.holderPid, "SIGKILL"), code: 1, partial: true },
];

ptyGuard(2 * cases.length);
const results = [];
for (const c of cases) results.push({ case: c.name, ...(await runCase(c)) });
const pass = results.every((r) => r.problems.length === 0);
console.log(JSON.stringify({ record: RECORD, result: pass ? "PASS" : "FAIL", results }, null, 1));
process.exit(pass ? 0 : 1);

async function runCase(c: Case): Promise<{ problems: string[]; exit: Hello["exit"]; leftAlive: number[] }> {
  const problems: string[] = [];
  const home = makeHome("rc");
  const probe = path.join(home, PROBE);
  fs.writeFileSync(probe, SCRIPT, { mode: 0o755 });
  const before = recHomes();
  const outerRef = await spawnHolder(home, "outer", [process.execPath, RECORD, probe], { cwd: SPIKE });
  const outer = await Conn.connect(outerRef.socket);
  let stream = "";
  const term = newTerm(120, 40);
  outer.onFrame = (f) => {
    if (f.kind !== K.R_DATA) return;
    stream += bytesOf(f).toString("latin1");
    void write(term, bytesOf(f));
  };
  outer.send(frame(K.SUBSCRIBE, u64(0)));
  const screen = () => stream;
  let inner = { holderPid: 0, childPid: 0 };
  let exit: Hello["exit"] = null;
  try {
    inner = await findInner(before);
    await until(() => stream.includes("ready"), 5000, "the probe to start");
    await c.end({ outer, recorderPid: outerRef.childPid, inner, screen });
    exit = await until(async () => (await helloOf(outerRef.socket))?.exit ?? null, 8000, "the recorder to exit");
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  await sleep(100);
  await write(term, "");

  if (exit && exit.code !== c.code) problems.push(`exit code ${exit.code}, want ${c.code}`);
  const m = term.modes;
  const on = Object.entries({
    mouse: m.mouseTrackingMode !== "none",
    bracketedPaste: m.bracketedPasteMode,
    focus: m.sendFocusMode,
    applicationCursorKeys: m.applicationCursorKeysMode,
    applicationKeypad: m.applicationKeypadMode,
    alternateScreen: term.buffer.active.type !== "normal",
    cursorHidden: (term as unknown as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden,
  }).filter(([, v]) => v).map(([k]) => k);
  if (on.length > 0) problems.push(`left on in the outer terminal: ${on.join(", ")}`);
  if (stream.lastIndexOf(RESTORE) < stream.lastIndexOf("\x1b[>4;2m")) problems.push("no RESTORE after the keyboard protocols went on");

  const leftAlive = inner.holderPid === 0 ? [] : [inner.holderPid, inner.childPid, -inner.childPid].filter(alive);
  if (leftAlive.length > 0) problems.push(`left alive: ${leftAlive.join(" ")}`);

  const recordings = path.join(PROGRAMS, "recordings");
  const want = path.join(recordings, `${PROBE}${c.partial ? ".partial" : ""}.bin`);
  if (exit && !fs.existsSync(want)) problems.push(`no ${path.basename(want)}`);
  for (const f of [`${PROBE}.bin`, `${PROBE}.partial.bin`]) fs.rmSync(path.join(recordings, f), { force: true });

  outer.close();
  const outerReap = await reap([outerRef]);
  if (leftAlive.length > 0) {
    // Close what a failing recorder left, so one failed case can't leak into the next.
    await reap([{ id: PROBE, pid: inner.holderPid, childPid: inner.childPid, socket: "/nonexistent" }]);
  }
  for (const h of recHomes().filter((h) => !before.includes(h))) fs.rmSync(h, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  if (outerReap.leftAlive.length > 0) problems.push(`outer left alive: ${outerReap.leftAlive.join(" ")}`);
  return { problems, exit, leftAlive };
}

function recHomes(): string[] {
  return fs.readdirSync("/tmp").filter((n) => n.startsWith("bzh-rec-")).map((n) => path.join("/tmp", n));
}

/** The recorder's own holder, found by the home it creates, so the check doesn't rely on what the recorder prints. */
async function findInner(before: string[]): Promise<{ holderPid: number; childPid: number }> {
  const homes = await until(() => {
    const fresh = recHomes().filter((h) => !before.includes(h));
    return fresh.length > 0 ? fresh : null;
  }, 5000, "the recorder's home");
  if (homes.length !== 1) throw new Error(`can't tell the recorder's holder apart: new homes ${homes.join(" ")}`);
  const socket = path.join(homes[0]!, "run", "holders", `${PROBE}.sock`);
  const hello = await until(() => helloOf(socket), 5000, `a holder at ${socket}`);
  return { holderPid: hello.holderPid, childPid: hello.childPid };
}

async function helloOf(socket: string): Promise<Hello | null> {
  try {
    const c = await Conn.connect(socket);
    const h = await Promise.race([c.hello(), sleep(1000).then(() => null)]);
    c.close();
    return h;
  } catch {
    return null;
  }
}

async function until<T>(get: () => T | null | false | Promise<T | null | false>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
