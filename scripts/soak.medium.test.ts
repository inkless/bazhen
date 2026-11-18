import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main, readRun } from "./soak.ts";

const root = mkdtempSync(join(tmpdir(), "bz-soak-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A run's directory holding `files`, each a list of lines. */
function runDir(name: string, files: Record<string, readonly string[]>): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "workers"), { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    writeFileSync(join(dir, file), lines.join("\n"));
  }
  return dir;
}

describe("readRun", () => {
  it("reads the driver's, echo timer's and workers' records, and stops at an attach not in runs", async () => {
    const attach = { kind: "attach", t: 3, name: "f1", snapshot: [[1, 900_000]], stream: [] };
    const dir = runDir("whole", {
      "events.jsonl": [
        JSON.stringify({ kind: "open", t: 1, name: "f1", load: "flood" }),
        JSON.stringify(attach),
      ],
      "echo.jsonl": [JSON.stringify({ kind: "echo", t: 2, ms: 4, flooding: true })],
      "workers/f1.jsonl": [
        JSON.stringify({ kind: "marker", t: 4, name: "f1", n: 9 }),
        '{"kind":"probe","t":5,',
      ],
    });
    expect((await readRun(dir)).map((e) => [e.kind, e.t])).toEqual([
      ["open", 1],
      ["attach", 3],
      ["echo", 2],
      ["marker", 4],
    ]);

    const old = runDir("numbers", {
      "events.jsonl": [
        JSON.stringify({ kind: "open", t: 1, name: "f1", load: "flood" }),
        JSON.stringify({ ...attach, snapshot: [1, 2, 3], stream: [4] }),
      ],
    });
    await expect(readRun(old)).rejects.toThrow(
      `${join(old, "events.jsonl")}:2 is an attach whose markers aren't runs`,
    );
  });

  it("refuses an attach whose runs aren't whole marker numbers", async () => {
    const dir = runDir("fractions", {
      "events.jsonl": [
        JSON.stringify({ kind: "attach", t: 3, name: "f1", snapshot: [[1.5, 3]], stream: [] }),
      ],
    });
    await expect(readRun(dir)).rejects.toThrow(
      `${join(dir, "events.jsonl")}:1 is an attach whose markers aren't runs`,
    );
  });
});

/** What judging `dir` again prints for daemon-memory, its profile.json naming `name`. */
async function daemonMemory(name: string): Promise<string | undefined> {
  const dir = runDir(`judged-${name}`, {
    "profile.json": [JSON.stringify({ name, hours: 24, faults: [] })],
    "events.jsonl": [
      JSON.stringify({ kind: "daemon", t: 0, up: false, why: "it was killed by SIGKILL" }),
    ],
  });
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: string) => printed.push(line));
  try {
    expect(await main(["--judge", dir])).toBe(1);
  } finally {
    log.mockRestore();
  }
  return printed
    .join("\n")
    .split("\n")
    .find((line) => line.includes("daemon-memory"));
}

describe("main --judge", () => {
  it("judges a long-life run's one daemon, which died, by the profile its directory names", async () => {
    expect(await daemonMemory("long-life")).toMatch(
      /^FAIL +daemon-memory +the daemon went down at 1970-01-01T00:00:00.000Z: it was killed by SIGKILL$/,
    );
    expect(await daemonMemory("gate")).toMatch(/^UNMEASURED +daemon-memory /);
  });
});
