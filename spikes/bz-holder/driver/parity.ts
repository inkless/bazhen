// Parity: each scenario runs live in a holder. Once its output is quiet, the holder's
// snapshot (at offset Z) replayed into @xterm/headless must equal the program's own bytes
// [0, Z) fed straight into @xterm/headless: every cell, wrap flag, cursor and mode.
// Recordings are saved to programs/recordings/ and can be replayed with --replay.
import fs from "node:fs";
import path from "node:path";
import {
  Conn,
  K,
  PROGRAMS,
  REPLAY,
  bytesOf,
  clean,
  diffTerms,
  frame,
  logicalLines,
  makeHome,
  newTerm,
  offsetOf,
  ptyGuard,
  reap,
  sleep,
  spawnHolder,
  u64,
  write,
} from "./lib.ts";

const COLS = 120;
const ROWS = 40;
const REC = path.join(PROGRAMS, "recordings");

interface Scenario {
  name: string;
  argv: (home: string) => string[];
  keys?: [number, string][];
  settle?: number;
  check?: (stream: Buffer, reference: ReturnType<typeof newTerm>) => string | null;
}

const unicodeText = [
  "CJK 漢字かなカナ한국어  emoji 👍🏽 🇯🇵 👨‍👩‍👧 combining é ä ñ",
  "box ┌─┬─┐ │ │ │ └─┴─┘ fullwidth ＡＢＣ１２３",
  "\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m \x1b[3mitalic\x1b[0m \x1b[7minverse\x1b[0m \x1b[2mdim\x1b[0m \x1b[9mstrike\x1b[0m",
  "\x1b[38;2;255;100;0mrgb fg\x1b[0m \x1b[48;2;0;80;160mrgb bg\x1b[0m \x1b[38;5;201m256\x1b[0m \x1b[91mbright\x1b[0m \x1b[31mred\x1b[0m",
  "\x1b[44m erased with bg:\x1b[K\x1b[0m",
].join("\r\n");

const scenarios: Scenario[] = [
  {
    name: "unicode",
    argv: () => ["/bin/sh", "-c", `printf '%s\\r\\n' '${unicodeText.replaceAll("'", "'\\''")}'; exec sleep 600`],
  },
  {
    name: "scroll",
    argv: (home) => [
      "/bin/sh",
      "-c",
      `node ${PROGRAMS}/gen.ts sgr160 ${home}/s.txt 3000 && { ${REPLAY} ${home}/s.txt 400 & p=$!; sleep 2; kill $p; }; exec sleep 600`,
    ],
    settle: 3500,
  },
  {
    name: "wrapped",
    argv: () => ["/bin/sh", "-c", `printf '%0500d|end\\r\\n' 7; printf 'x%.0s' $(seq 1 120); printf 'next\\r\\n'; exec sleep 600`],
    check: (_s, ref) =>
      logicalLines(ref).some((l) => l.endsWith("7|end") && l.length === 504) ? null : "long line not one logical line",
  },
  {
    name: "altscreen",
    argv: () => [
      "/bin/sh",
      "-c",
      "seq 1 300; printf '\\033[?1049h\\033[Hin alt\\033[5;5Hdrawn'; sleep 0.3; printf '\\033[?1049l'; seq 301 400; exec sleep 600",
    ],
    settle: 1500,
    check: (_s, ref) => {
      const lines = logicalLines(ref);
      return lines.includes("1") && lines.includes("300") && lines.includes("400") ? null : "history lost";
    },
  },
  {
    name: "clear",
    argv: () => ["/bin/sh", "-c", "seq 1 300; printf '\\033[H\\033[2J'; seq 301 320; clear; echo after-clear; exec sleep 600"],
    settle: 1000,
  },
  {
    name: "alt-live",
    argv: () => ["/bin/sh", "-c", "seq 1 100; printf '\\033[?1049h\\033[31m\\033[10;10Hstill in alt'; exec sleep 600"],
  },
  {
    name: "nvim",
    argv: (home) => {
      fs.writeFileSync(
        path.join(home, "demo.rs"),
        'fn main() {\n    let greeting = "漢字 and emoji 🎉";\n    println!("{greeting}");\n}\n',
      );
      return ["nvim", "--clean", "demo.rs"];
    },
    keys: [
      [800, ":syntax on\r"],
      [300, ":vsplit\r"],
      [300, "Go// 插入 CJK 🙂 text\x1b"],
      [300, ":set number\r"],
    ],
    settle: 1500,
  },
  {
    name: "htop",
    argv: () => ["htop", "--no-mouse", "-d", "10"],
    keys: [[1500, ""]],
    settle: 0,
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const replayMode = process.argv.includes("--replay");
ptyGuard(2);
const home = makeHome("parity");
let failures = 0;
const holders = [];

// In --replay, any recording can be named, such as the owner's claude or codex.
const known = new Set(scenarios.map((x) => x.name));
const extra: Scenario[] = replayMode ? only.filter((n) => !known.has(n)).map((name) => ({ name, argv: () => [] })) : [];
for (const s of [...scenarios, ...extra].filter((x) => only.length === 0 || only.includes(x.name))) {
  const recording = path.join(REC, `${s.name}.bin`);
  const argv = replayMode
    ? ["/bin/sh", "-c", `stty -opost -echo; cat '${recording}'; exec sleep 600`]
    : s.argv(home);
  const h = await spawnHolder(home, s.name, argv, { cols: COLS, rows: ROWS });
  holders.push(h);
  const c = await Conn.connect(h.socket);
  const chunks: Buffer[] = [];
  let lastData = Date.now();
  c.onFrame = (f) => {
    if (f.kind === K.R_DATA) {
      chunks.push(bytesOf(f));
      lastData = Date.now();
    }
  };
  c.send(frame(K.SUBSCRIBE, u64(0)));
  for (const [delay, keys] of s.keys ?? []) {
    await sleep(delay);
    if (keys) c.send(frame(K.INPUT, keys));
  }
  await sleep(s.settle ?? 500);
  if (s.name !== "htop") while (Date.now() - lastData < 400) await sleep(50);
  const snapReply = c.next(K.R_SNAPSHOT);
  c.send(frame(K.SNAPSHOT));
  const snap = await snapReply;
  const z = Number(offsetOf(snap));
  while (chunks.reduce((n, b) => n + b.length, 0) < z) await sleep(10);
  const stream = Buffer.concat(chunks).subarray(0, z);
  if (!replayMode && s.name !== "htop") fs.writeFileSync(recording, stream);
  if (!replayMode && s.name === "htop") fs.writeFileSync(recording, stream);

  const reference = newTerm(COLS, ROWS);
  await write(reference, stream);
  const replayed = newTerm(COLS, ROWS);
  await write(replayed, bytesOf(snap));
  const d = diffTerms(reference, replayed);
  const extra = s.check?.(stream, reference) ?? null;
  const ok = clean(d) && extra === null;
  if (!ok) failures++;
  console.log(
    JSON.stringify({
      scenario: s.name,
      mode: replayMode ? "replay" : "live",
      streamBytes: z,
      snapshotBytes: bytesOf(snap).length,
      diffCells: d.cells,
      diffRows: d.rows,
      lengths: d.lengths,
      cursor: d.cursor ?? "exact",
      modes: d.modes,
      active: d.active ?? "same",
      check: extra ?? "ok",
      result: ok ? "PASS" : "FAIL",
      samples: d.samples,
    }),
  );
  c.close();
}

const { leftAlive } = await reap(holders);
console.log(JSON.stringify({ failures, leftAlive }));
fs.rmSync(home, { recursive: true, force: true });
process.exit(failures === 0 && leftAlive.length === 0 ? 0 : 1);
