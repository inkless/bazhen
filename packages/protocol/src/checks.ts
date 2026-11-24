/**
 * The rules the Rust protocol's schema names, which no JSON Schema keyword states:
 * `x-bazhen-check`, which `cargo xtask schema` writes as `.refine(checks.<name>)`, and on a record
 * `x-bazhen-transform`, written as `z.preprocess(checks.<name>, record)`. It fails on a name this
 * module doesn't export or an export no schema names.
 */

import type { z } from "zod";
import { noteSafe, TASK_NOTE_MAX_BYTES, titleSafe } from "./tasks.ts";

const encoder = new TextEncoder();

/** In a `u` regex a surrogate pair is one code point, so only a half on its own matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * A string a Rust peer holds in at most `max` UTF-8 bytes. A lone surrogate has no UTF-8, so a
 * Rust peer refuses it whatever its length.
 */
function utf8AtMost(max: number) {
  return (text: string) => !LONE_SURROGATE.test(text) && encoder.encode(text).length <= max;
}

export const utf8AtMost32Bytes = utf8AtMost(32);
export const utf8AtMost64Bytes = utf8AtMost(64);
export const utf8AtMost1024Bytes = utf8AtMost(1024);

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
export const newTaskTitle = titleSafe;

/** What a task note says, once trimmed: within its UTF-8 budget, and fit for a note. */
export function taskNoteText(text: string) {
  return utf8AtMost(TASK_NOTE_MAX_BYTES)(text) && noteSafe(text);
}

/** What the one who finishes a task says of it: fit for a note. */
export const finishNoteText = noteSafe;

/** A delegation names the agent to delegate to, or one to launch, and not both. */
export function agentOrLaunch(request: { agentId?: unknown; launch?: unknown }) {
  return (request.agentId === undefined) !== (request.launch === undefined);
}

/** A shell linked to an agent opens in the agent's directory, so it takes no `cwd`. */
export function linkedShellTakesNoCwd(request: { linkedAgentId?: unknown; cwd?: unknown }) {
  return request.linkedAgentId === undefined || request.cwd === undefined;
}
