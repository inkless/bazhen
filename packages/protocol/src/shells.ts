import { z } from "zod";
import { hasLoneSurrogate } from "./holder.ts";
import { TuiTheme } from "./theme.ts";
import { Id, IdempotencyKey } from "./ids.ts";

export const TerminalState = z.enum([
  "creating",
  "running",
  "exited",
  "unknown",
  "lost",
  "closing",
  "closed",
  "failed",
]);
export type TerminalState = z.infer<typeof TerminalState>;

/** A command on a shell: each is a `POST /v1/shells/:id/<command>` (protocol 1.17). */
export const ShellCommand = z.enum(["close", "restart", "rename", "unlink"]);
export type ShellCommand = z.infer<typeof ShellCommand>;

/**
 * A plain terminal running the user's own shell, beside the agents (foundation-design §4.8).
 * It never exits into `exited`: a shell whose process ends is closed at once.
 */
export const Shell = z.object({
  id: Id("term"),
  environmentId: Id("env"),
  state: TerminalState,
  generation: z.number().int().nonnegative(),
  /** The directory it was opened in. */
  cwd: z.string(),
  /** The agent it is shown with, whose close takes it; null for a standalone shell. */
  linkedAgentId: Id("agent").nullable(),
  /** A name the user gave it; without one, a client names it from its directory. */
  name: z.string().nullable().default(null),
  /**
   * What runs in its foreground when that isn't the shell, by name, and since when, as the
   * daemon last saw it; null at the shell's prompt (protocol 1.23).
   */
  foreground: z.object({ command: z.string(), since: z.iso.datetime() }).nullable().default(null),
  /** The theme it was opened for, which it is drawn in and tells programs that ask. */
  theme: TuiTheme,
  /** As an agent's: null while the runtime holds no terminal for it. */
  attachCommand: z.string().nullable(),
  commands: z.array(ShellCommand),
  /**
   * A lost shell whose last line its shell integration kept: a restart can type it back at the
   * new shell's prompt (`retype`). The line itself is never sent (protocol 1.40).
   */
  retypeable: z.boolean().default(false),
});
export type Shell = z.infer<typeof Shell>;

/**
 * Opens a shell: linked to an agent, in that agent's directory, or standalone in `cwd` (an
 * absolute path, `~` or `~/…`), the daemon user's home when none is named.
 */
export const OpenShellRequest = z
  .object({
    idempotencyKey: IdempotencyKey,
    linkedAgentId: Id("agent").optional(),
    cwd: z.string().min(1).optional(),
    theme: TuiTheme.optional(),
  })
  .refine((r) => r.linkedAgentId === undefined || r.cwd === undefined, {
    message: "a linked shell opens in its agent's directory, so it takes no cwd",
  });
export type OpenShellRequest = z.infer<typeof OpenShellRequest>;

/** A program the user was shown running in a shell, and chose to end with it. */
export const BusyShell = z.object({ terminalId: Id("term"), program: z.string().max(200) });
export type BusyShell = z.infer<typeof BusyShell>;

/** Ends a shell and everything running in it; a lost shell is only taken off the list. */
export const CloseShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  /**
   * Close even though a program other than the shell is in the foreground. Without it such a
   * close is refused as `busy`, naming that program, so the user is asked first.
   */
  confirmBusy: z.boolean().optional(),
  /**
   * The program the user was shown running, and confirmed: the close ends that one, and is still
   * refused as `busy` if another runs by then (protocol 1.28).
   */
  confirmedProgram: z.string().max(200).optional(),
  /** As an agent's close: records closed a shell whose old server can't be shown gone. */
  force: z.boolean().optional(),
});
export type CloseShellRequest = z.infer<typeof CloseShellRequest>;

/** Opens a new shell in a lost one's directory, beside the same agent if it still runs (§4.8). */
export const RestartShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  theme: TuiTheme.optional(),
  /**
   * Type the lost shell's last line at the new shell's first prompt, without Enter; refused for
   * a shell that isn't `retypeable` (protocol 1.40).
   */
  retype: z.literal(true).optional(),
});
export type RestartShellRequest = z.infer<typeof RestartShellRequest>;

/** C0 and C1 control characters, and the bidirectional embeddings, overrides and isolates. */
const unshowable = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** Every one of them is in the Basic Multilingual Plane, so UTF-16 units find them all. */
function showable(name: string): boolean {
  for (let i = 0; i < name.length; i++) if (unshowable(name.charCodeAt(i))) return false;
  return true;
}

/**
 * A shell's name, as a person gives it. A client draws it, so it can't carry a control character
 * (an escape sequence, a newline) or a bidirectional override that reorders the text around it.
 */
export const ShellName = z.string().trim().min(1).max(80).refine(showable, {
  message: "a shell's name can't hold control characters or bidirectional overrides",
});

/**
 * The most UTF-8 bytes of a command line kept to type back. A longer one is dropped, never cut:
 * typing back part of a command is typing a different one.
 */
export const COMMAND_LINE_MAX_BYTES = 2048;

const encoder = new TextEncoder();

/**
 * Characters that draw as nothing, or as a line break, so a line holding one types back other
 * than it looks: zero-width spaces and joiners, the directional marks, the word joiner and
 * invisible operators, the byte-order mark, and the line and paragraph separators.
 */
const INVISIBLE = /[\u061c\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/u;

/**
 * A line the user ran at a shell's prompt, as their shell reported it, kept to type back into
 * the shell's replacement without Enter. A control character there is a key, not text: a newline
 * or carriage return would run the line, and an escape would drive the line editor. A line that
 * starts with a space is one the user kept out of their history, so it is kept out of this too.
 */
export const ShellCommandLine = z
  .string()
  .min(1)
  .refine((line) => !line.startsWith(" "), {
    message: "a line starting with a space is kept out of history, so it isn't kept",
  })
  .refine((line) => showable(line) && !hasLoneSurrogate(line), {
    message: "a command line can't hold control characters or bidirectional overrides",
  })
  .refine((line) => !INVISIBLE.test(line), {
    message: "a command line can't hold a character that draws as nothing",
  })
  .refine((line) => encoder.encode(line).length <= COMMAND_LINE_MAX_BYTES, {
    message: `a command line is at most ${COMMAND_LINE_MAX_BYTES} bytes`,
  });

/**
 * What a shell's integration reports over the daemon's socket, as the shell starts running a
 * line: never over HTTP. `token` is the shell's own, from its environment.
 */
export const ShellReport = z.object({
  token: z.string().min(1).max(128),
  /**
   * When the shell started running the line, in microseconds since the epoch: a report earlier
   * than the kept one, arriving late, changes nothing.
   */
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** The line, or null for one its client couldn't send whole: too long, or not UTF-8. */
  command: z.string().max(COMMAND_LINE_MAX_BYTES).nullable(),
});
export type ShellReport = z.infer<typeof ShellReport>;

/**
 * What a shell's integration reports over the daemon's socket once, at the shell's first prompt:
 * its line editor is reading, so a line can be typed back (protocol 1.40).
 */
export const ShellPrompt = z.object({ token: ShellReport.shape.token });
export type ShellPrompt = z.infer<typeof ShellPrompt>;

export const RenameShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  name: ShellName.nullable(),
});
export type RenameShellRequest = z.infer<typeof RenameShellRequest>;

/**
 * Makes a linked shell standalone: its agent's close no longer takes it. It keeps running as it
 * is, and is never linked again.
 */
export const UnlinkShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
});
export type UnlinkShellRequest = z.infer<typeof UnlinkShellRequest>;

/** What a command on a shell produced: the events it recorded, none if there was nothing to do. */
export const ShellCommandResponse = z.object({
  /** The shell the command was on; a restart's new shell. */
  terminalId: Id("term"),
  eventIds: z.array(z.number().int().positive()),
});
export type ShellCommandResponse = z.infer<typeof ShellCommandResponse>;
