import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isConversationEntry } from "@bazhen/harness-claude-code";

export interface TranscriptLimits {
  /** How much is read at a time. */
  readonly chunkBytes?: number;
  /** How much of the file is read at most. */
  readonly limitBytes?: number;
}

const CHUNK_BYTES = 16 * 1024;
/**
 * A session's first entry is among its transcript's first few lines, in a resumed one too, which
 * appends; each metadata line ahead of it is a few hundred bytes. A line still open here that is
 * half this long is no metadata but an entry holding a large paste, such as an image.
 */
const LIMIT_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

const codeOf = (err: unknown) =>
  typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;

/**
 * Reads whether the Claude Code transcript at a path holds a conversation `--resume` can load. A
 * line still without its newline may be mid-write and is not judged, unless it runs on past the
 * limit. A path that can't be read holds none; why is said once for each path, but for a file not
 * there yet, which is how every session starts.
 */
export function transcriptReader(
  warn: (message: string) => void,
  { chunkBytes = CHUNK_BYTES, limitBytes = LIMIT_BYTES }: TranscriptLimits = {},
): (path: string) => boolean {
  const warned = new Set<string>();
  const unreadable = (path: string, why: string) => {
    if (warned.has(path)) return false;
    warned.add(path);
    warn(`the transcript ${path} can't be read, so its session isn't offered to resume: ${why}`);
    return false;
  };
  return (path) => {
    let fd: number;
    try {
      // The path is a hook's to name: a FIFO there mustn't block the daemon, nor a terminal
      // become the controlling terminal of the session the daemon leads.
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
    } catch (err) {
      return codeOf(err) === "ENOENT" ? false : unreadable(path, String(err));
    }
    try {
      if (!fstatSync(fd).isFile()) return unreadable(path, "it isn't a regular file");
      const chunk = Buffer.allocUnsafe(chunkBytes);
      // The line still open, in copies of each read's share of it: each byte is searched for a
      // newline once and copied at most twice, however many reads a long line spans.
      let open: Buffer[] = [];
      let openBytes = 0;
      for (let read = 0; read < limitBytes;) {
        const n = readSync(fd, chunk, 0, Math.min(chunkBytes, limitBytes - read), read);
        if (n === 0) return false;
        read += n;
        const bytes = chunk.subarray(0, n);
        let start = 0;
        let end: number;
        while ((end = bytes.indexOf(NEWLINE, start)) !== -1) {
          const rest = bytes.subarray(start, end);
          const line = openBytes === 0 ? rest : Buffer.concat([...open, rest]);
          if (isConversationEntry(line.toString("utf8"))) return true;
          open = [];
          openBytes = 0;
          start = end + 1;
        }
        if (start < n) {
          open.push(Buffer.from(bytes.subarray(start)));
          openBytes += n - start;
        }
      }
      return openBytes >= limitBytes / 2;
    } catch (err) {
      return unreadable(path, String(err));
    } finally {
      closeSync(fd);
    }
  };
}
