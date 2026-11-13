import { z } from "zod";
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

/** Ends a shell and everything running in it; a lost shell is only taken off the list. */
export const CloseShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  /**
   * Close even though a program other than the shell is in the foreground. Without it such a
   * close is refused as `busy`, naming that program, so the user is asked first.
   */
  confirmBusy: z.boolean().optional(),
  /** As an agent's close: records closed a shell whose old server can't be shown gone. */
  force: z.boolean().optional(),
});
export type CloseShellRequest = z.infer<typeof CloseShellRequest>;

/** Opens a new shell in a lost one's directory, beside the same agent if it still runs (§4.8). */
export const RestartShellRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: z.number().int().nonnegative(),
  theme: TuiTheme.optional(),
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
