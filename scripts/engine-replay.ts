// What the holder's terminal engine costs: resident memory with 10,000 rows of history at
// 160x50, for one engine and for 25, and how fast it takes a flood. It replays generated streams
// through `bazhen-holder-replay` and reads each run's resident set from `ps`. Run:
// `moon run :bench-engine`, which builds the bin first.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentStream, sgrStream } from "../tests/support/agent-stream.ts";
import { isMain } from "./is-main.ts";

const BINARY = fileURLToPath(new URL("../target/release/bazhen-holder-replay", import.meta.url));
const COLS = 160;
const ROWS = 50;
const HISTORY_ROWS = 10_000;

/** About `megabytes` of `line`, repeated. */
export function flood(line: string, megabytes: number): string {
  return line.repeat(Math.ceil((megabytes * 1_048_576) / line.length));
}

/** Writes about `megabytes` of `line` to `file` a megabyte at a time, never holding it all. */
function writeFlood(file: string, line: string, megabytes: number): void {
  const piece = flood(line, 1);
  const fd = openSync(file, "w");
  try {
    for (let i = 0; i < megabytes; i++) writeSync(fd, piece);
  } finally {
    closeSync(fd);
  }
}

export interface Run {
  stream: string;
  engines: number;
  rssMb: number;
  historyRows: number;
  historyMb: number;
  engineMb: number;
  overflows: number;
  mbPerSecond: number;
}

interface Report {
  engineBytes: number;
  historyBytes: number;
  historyRows: number;
  overflows: number;
  mbPerSecond: number;
}

/** The replay bin's report line, or a throw naming the field it lacks. */
export function replayReport(parsed: unknown): Report {
  const number = (field: keyof Report): number => {
    const value: unknown =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, field) : undefined;
    if (typeof value !== "number") throw new Error(`replay report lacks a number for ${field}`);
    return value;
  };
  return {
    engineBytes: number("engineBytes"),
    historyBytes: number("historyBytes"),
    historyRows: number("historyRows"),
    overflows: number("overflows"),
    mbPerSecond: number("mbPerSecond"),
  };
}

const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;

/**
 * What one engine of a stream costs, from a run of `engines` of them and the process floor: the
 * resident set over the floor, shared out. Rounded to a tenth of a megabyte.
 */
export function perEngine(run: Run, floor: Run): string {
  const each = Math.round(((run.rssMb - floor.rssMb) / run.engines) * 10) / 10;
  return (
    `${run.stream}: ${each} MB per engine = (${run.rssMb} MB for ${run.engines} engines` +
    ` - ${floor.rssMb} MB process floor) / ${run.engines}`
  );
}

async function replay(name: string, file: string, engines: number): Promise<Run> {
  const child = spawn(BINARY, [`${COLS}`, `${ROWS}`, `${HISTORY_ROWS}`, `${engines}`, file], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(out.trim());
    });
    child.on("exit", (code) => reject(new Error(`${BINARY} exited ${code}`)));
  });
  const rss = spawnSync("ps", ["-o", "rss=", "-p", `${child.pid}`], { encoding: "utf8" });
  child.stdin.end();
  const stats = replayReport(JSON.parse(line));
  return {
    stream: name,
    engines,
    rssMb: mb(Number(rss.stdout.trim()) * 1024),
    historyRows: stats.historyRows,
    historyMb: mb(stats.historyBytes),
    engineMb: mb(stats.engineBytes),
    overflows: stats.overflows,
    mbPerSecond: stats.mbPerSecond,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "engine-replay-"));
  try {
    // Each stream is made when it's replayed, and the floods a megabyte at a time.
    const streams: [string, (file: string) => void][] = [
      ["agent", (file) => writeFileSync(file, agentStream(HISTORY_ROWS + ROWS))],
      ["sgr160", (file) => writeFileSync(file, sgrStream(HISTORY_ROWS + ROWS))],
      // A PTY turns `yes`'s LF into CRLF (onlcr).
      ["yes", (file) => writeFlood(file, "y\r\n", 64)],
      ["100-byte lines", (file) => writeFlood(file, `${"x".repeat(98)}\r\n`, 256)],
    ];
    const runs: Run[] = [];
    const empty = join(dir, "empty");
    writeFileSync(empty, "");
    const floor = await replay("none (process floor)", empty, 1);
    runs.push(floor);
    const headlines: string[] = [];
    for (const [name, write] of streams) {
      const file = join(dir, name);
      write(file);
      const counts = name === "agent" || name === "sgr160" ? [1, 25] : [1];
      for (const engines of counts) {
        const run = await replay(name, file, engines);
        runs.push(run);
        if (engines > 1) headlines.push(perEngine(run, floor));
      }
      rmSync(file);
    }
    console.table(runs);
    for (const headline of headlines) console.log(headline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta)) await main();
