/**
 * The rules the Rust protocol's schema names, which no JSON Schema keyword states:
 * `x-bazhen-check`, a name or several, each of which `cargo xtask schema` writes as
 * `.refine(checks.<name>, checks.<name>.message)`, and on a record `x-bazhen-transform`, written
 * as `z.preprocess(checks.<name>, record)`. It fails on a name this module doesn't export or an
 * export no schema names. Each message is the one the protocol's own schema refuses with.
 */

import type { z } from "zod";
import { hasControl, hasLoneSurrogate } from "./holder.ts";
import { COMMAND_LINE_MAX_BYTES } from "./shells.ts";
import { noteSafe, TASK_NOTE_MAX_BYTES, titleSafe } from "./tasks.ts";
import { INVISIBLE, showable } from "./text.ts";

const encoder = new TextEncoder();

/** In a `u` regex a surrogate pair is one code point, so only a half on its own matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/** `test`, carrying the message a value it refuses is refused with. */
function check<T>(message: string, test: (value: T) => boolean) {
  return Object.assign((value: T) => test(value), { message });
}

/** A string a peer in another language can hold: a lone surrogate has no UTF-8. */
export const wellFormed = check("a lone surrogate", (text: string) => !LONE_SURROGATE.test(text));

/** A string a Rust peer holds in at most `max` UTF-8 bytes. */
function utf8AtMost(max: number) {
  return check(`at most ${max} UTF-8 bytes`, (text: string) => encoder.encode(text).length <= max);
}

export const utf8AtMost32Bytes = utf8AtMost(32);
export const utf8AtMost64Bytes = utf8AtMost(64);
export const utf8AtMost1024Bytes = utf8AtMost(1024);

/** Text with no C0 or C1 control or DEL. */
export const noControl = check("a control character", (text: string) => !hasControl(text));

/** A screen's text: no C0 or C1 control or DEL but the newline ending each row. */
export const screenText = check(
  "a control character",
  (text: string) => !hasControl(text.replaceAll("\n", "")),
);

/** A paste unmarked by brackets may arrive as keys, so it holds printable ASCII only. */
export const unmarkedPasteIsAscii = check(
  "unmarked text beyond printable ASCII",
  ({ text, brackets }: { text: string; brackets: boolean }) =>
    brackets || /^[\x20-\x7e]*$/u.test(text),
);

/**
 * Refuses an own `__proto__` key, which `JSON.parse` makes and zod's record skips without a word;
 * a Rust peer reads it as any other key, so the record would lose what the peer sent.
 */
export function refusingOwnProto(value: unknown, ctx: z.core.$RefinementCtx) {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
    ctx.addIssue({ code: "custom", message: "__proto__ is reserved" });
  }
  return value;
}

/** A title a request gives a task, once trimmed: `NewTaskTitle`'s rule. */
export const newTaskTitle = check(
  "a title can't hold control characters, bidirectional overrides or invisible ones",
  titleSafe,
);

/** A name a person gives a shell, once trimmed: `ShellName`'s rule. */
export const shellName = check(
  "a shell's name can't hold control characters or bidirectional overrides",
  (name: string) => showable(name),
);

/** A command line the user kept in their history, which one starting with a space isn't. */
export const commandLineInHistory = check(
  "a line starting with a space is kept out of history, so it isn't kept",
  (line: string) => !line.startsWith(" "),
);

/** A command line with no control character, bidirectional override or lone surrogate. */
export const commandLineShowable = check(
  "a command line can't hold control characters or bidirectional overrides",
  (line: string) => showable(line) && !hasLoneSurrogate(line),
);

/** A command line with no character that draws as nothing. */
export const commandLineVisible = check(
  "a command line can't hold a character that draws as nothing",
  (line: string) => !INVISIBLE.test(line),
);

/** A command line within its UTF-8 budget. */
export const commandLineBytes = check(
  `a command line is at most ${COMMAND_LINE_MAX_BYTES} bytes`,
  (line: string) => encoder.encode(line).length <= COMMAND_LINE_MAX_BYTES,
);

/** A task note within its UTF-8 budget. */
export const taskNoteBytes = check(
  `a note is at most ${TASK_NOTE_MAX_BYTES} UTF-8 bytes`,
  (text: string) => encoder.encode(text).length <= TASK_NOTE_MAX_BYTES,
);

/** Text fit for a note: a task's, or what the one who finishes it says of it. */
export const noteText = check(
  "a note can't hold control characters but newline and tab, or invisible characters",
  noteSafe,
);

/** A delegation names the agent to delegate to, or one to launch, and not both. */
export const agentOrLaunch = check(
  "name the agent to delegate to, or one to launch, not both",
  (request: { agentId?: unknown; launch?: unknown }) =>
    (request.agentId === undefined) !== (request.launch === undefined),
);

/** A shell linked to an agent opens in the agent's directory, so it takes no `cwd`. */
export const linkedShellTakesNoCwd = check(
  "a linked shell opens in its agent's directory, so it takes no cwd",
  (request: { linkedAgentId?: unknown; cwd?: unknown }) =>
    request.linkedAgentId === undefined || request.cwd === undefined,
);
