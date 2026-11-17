import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptReader, type TranscriptLimits } from "./transcript.ts";

const SESSION = "165ac0a2-998e-4765-8618-60ab0656318c";
/** What Claude Code 2.1.322 has written of a first turn a moment after its Stop hook. */
const METADATA = [
  `{"type":"mode","mode":"normal","sessionId":"${SESSION}"}`,
  `{"type":"permission-mode","permissionMode":"default","sessionId":"${SESSION}"}`,
  `{"type":"atis-latch","atis":"","sessionId":"${SESSION}"}`,
];
const SNAPSHOT = `{"type":"file-history-snapshot","messageId":"m","snapshot":{"trackedFileBackups":{}}}`;
const USER = `{"parentUuid":null,"type":"user","message":{"role":"user","content":"hello"},"sessionId":"${SESSION}"}`;
const ASSISTANT = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`;
/** A session where only `/model` ran, which `--resume` loads. */
const MODEL_ONLY = [
  METADATA[0] ?? "",
  METADATA[1] ?? "",
  `{"parentUuid":null,"type":"system","subtype":"local_command","content":"<command-name>/model</command-name>","isMeta":false,"sessionId":"${SESSION}"}`,
  METADATA[2] ?? "",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-transcript-"));
  dirs.push(dir);
  return dir;
}
function transcript(text: string): string {
  const path = join(tempDir(), `${SESSION}.jsonl`);
  writeFileSync(path, text);
  return path;
}
const lines = (...l: string[]) => transcript(l.map((x) => `${x}\n`).join(""));

/** A reader, and what it warned of. */
function reader(limits?: TranscriptLimits) {
  const warnings: string[] = [];
  return { holds: transcriptReader((m) => warnings.push(m), limits), warnings };
}

describe("whether a Claude Code transcript holds a conversation --resume can load", () => {
  it("holds none while only its metadata is written, with or without its file snapshot", () => {
    const { holds } = reader();
    expect([holds(lines(...METADATA)), holds(lines(...METADATA, SNAPSHOT))]).toEqual([
      false,
      false,
    ]);
  });

  it("holds one from its first entry: a message, or a command's output where only one ran", () => {
    const { holds } = reader();
    expect([
      holds(lines(...METADATA, SNAPSHOT, USER)),
      holds(lines(...METADATA, ASSISTANT)),
      holds(lines(...MODEL_ONLY)),
    ]).toEqual([true, true, true]);
  });

  it("holds none for a file not there yet, and says nothing of it", () => {
    const { holds, warnings } = reader();
    expect([holds(join(tempDir(), "missing.jsonl")), warnings]).toEqual([false, []]);
  });

  it("holds none for what isn't a regular file, at once for a FIFO, and says so once per path", () => {
    const dir = tempDir();
    const fifo = join(dir, "fifo.jsonl");
    execFileSync("mkfifo", [fifo]);
    const { holds, warnings } = reader();
    expect([holds(fifo), holds(fifo), holds(dir)]).toEqual([false, false, false]);
    expect(warnings).toEqual([
      expect.stringMatching(new RegExp(`${fifo} can't be read.*: it isn't a regular file$`)),
      expect.stringMatching(new RegExp(`${dir} can't be read.*: it isn't a regular file$`)),
    ]);
  });

  it("holds none for a file it may not read, and says why", () => {
    const path = lines(...METADATA, USER);
    chmodSync(path, 0o000);
    const { holds, warnings } = reader();
    expect([holds(path), warnings]).toEqual([false, [expect.stringContaining("EACCES")]]);
  });

  it("finds an entry split across reads", () => {
    expect(reader({ chunkBytes: 7 }).holds(lines(...METADATA, USER))).toBe(true);
  });

  it("reads on past a line that isn't JSON", () => {
    const { holds } = reader();
    expect([holds(lines("{not json", USER)), holds(lines("{not json"))]).toEqual([true, false]);
  });

  it("doesn't judge a last line still without its newline, which may be mid-write", () => {
    expect(reader().holds(transcript([...METADATA, USER].join("\n")))).toBe(false);
  });

  it("stops at its limit, taking a line still open there for an entry, as a large paste is", () => {
    const head = Buffer.byteLength(`${METADATA.join("\n")}\n`);
    const pasted = `{"type":"user","message":{"role":"user","content":"${"x".repeat(4096)}"}}`;
    const { holds } = reader({ limitBytes: head + 1024, chunkBytes: 256 });
    expect([
      holds(lines(...METADATA, pasted)),
      holds(lines(...METADATA, ...Array<string>(40).fill(SNAPSHOT), USER)),
    ]).toEqual([true, false]);
  });
});
