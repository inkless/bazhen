import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptHoldsConversation } from "./transcript.ts";

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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-transcript-"));
  dirs.push(dir);
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, text);
  return path;
}
const lines = (...l: string[]) => transcript(l.map((x) => `${x}\n`).join(""));

describe("whether a Claude Code transcript holds a conversation --resume can load", () => {
  it("holds none while only its metadata is written, with or without its file snapshot", () => {
    expect([
      transcriptHoldsConversation(lines(...METADATA)),
      transcriptHoldsConversation(lines(...METADATA, SNAPSHOT)),
    ]).toEqual([false, false]);
  });

  it("holds one from its first user or assistant entry", () => {
    expect([
      transcriptHoldsConversation(lines(...METADATA, SNAPSHOT, USER)),
      transcriptHoldsConversation(lines(...METADATA, ASSISTANT)),
    ]).toEqual([true, true]);
  });

  it("holds none for a file that isn't there, or a path it can't read as one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bz-transcript-"));
    dirs.push(dir);
    expect([
      transcriptHoldsConversation(join(dir, "missing.jsonl")),
      transcriptHoldsConversation(dir),
    ]).toEqual([false, false]);
  });

  it("finds an entry split across reads", () => {
    expect(transcriptHoldsConversation(lines(...METADATA, USER), { chunkBytes: 7 })).toBe(true);
  });

  it("reads on past a line that isn't JSON", () => {
    expect([
      transcriptHoldsConversation(lines("{not json", USER)),
      transcriptHoldsConversation(lines("{not json")),
    ]).toEqual([true, false]);
  });

  it("doesn't read a last line still without its newline, which may be mid-write", () => {
    expect(transcriptHoldsConversation(transcript([...METADATA, USER].join("\n")))).toBe(false);
  });

  it("stops at its byte limit, and finds no conversation past it", () => {
    const head = `${METADATA.join("\n")}\n`;
    const path = lines(...METADATA, USER);
    const within = Buffer.byteLength(head) + Buffer.byteLength(USER) + 1;
    expect([
      transcriptHoldsConversation(path, { limitBytes: within }),
      transcriptHoldsConversation(path, { limitBytes: within - 1 }),
    ]).toEqual([true, false]);
  });
});
