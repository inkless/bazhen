import { closeSync, openSync, readSync } from "node:fs";
import { isConversationEntry } from "@bazhen/harness-claude-code";

export interface TranscriptLimits {
  /** How much is read at a time. */
  readonly chunkBytes?: number;
  /** How much of the file is read at most before the answer is no. */
  readonly limitBytes?: number;
}

const CHUNK_BYTES = 64 * 1024;
/**
 * A session's first message is among its transcript's first few lines, in a resumed one too,
 * which appends; a respawn's check doesn't read on through a long transcript that shows none.
 */
const LIMIT_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Whether the Claude Code transcript at `path` holds a conversation `--resume` can load. A line
 * still without its newline may be mid-write and is not read; any read error is no.
 */
export function transcriptHoldsConversation(
  path: string,
  { chunkBytes = CHUNK_BYTES, limitBytes = LIMIT_BYTES }: TranscriptLimits = {},
): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const chunk = Buffer.alloc(chunkBytes);
    let pending = Buffer.alloc(0);
    for (let read = 0; read < limitBytes;) {
      const n = readSync(fd, chunk, 0, Math.min(chunkBytes, limitBytes - read), read);
      if (n === 0) return false;
      read += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let end: number;
      while ((end = pending.indexOf(NEWLINE)) !== -1) {
        if (isConversationEntry(pending.subarray(0, end).toString("utf8"))) return true;
        pending = pending.subarray(end + 1);
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
