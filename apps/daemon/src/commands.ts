import {
  NoTerminal,
  NotResumable,
  ProcessState,
  StaleIncarnation,
  TerminalUnconfirmed,
} from "@bazhen/core";

// Failures of a command on a terminal's owner, an agent or a shell, named by `subject`
// ("agent agent_…", "shell term_…"), as the API reports them.

/** A command named a generation the terminal has moved past (foundation-design §10). */
export class StaleGeneration extends Error {
  constructor(subject: string, current: number | null) {
    super(`${subject} is at generation ${String(current)}`);
  }
}

/** Its state does not allow the command, and never will. */
export class StateConflict extends Error {
  constructor(subject: string, state: string) {
    super(`${subject} is ${state}`);
  }
}

/**
 * The terminal's tmux server or pane is not the one recorded, so it can't be acted on safely.
 * Repeating the command won't help; restart recovery settles what happened to it.
 */
export class TerminalReplaced extends Error {
  constructor(subject: string, cause: unknown) {
    super(`${subject}'s terminal is not the one recorded; its server or pane has changed`, {
      cause,
    });
  }
}

/**
 * The terminal is gone from view, but the server it ran on may still run it, so close can't call
 * it ended; only a forced close records it closed (foundation-design §7.1).
 */
export class ServerUnconfirmed extends Error {
  constructor(subject: string, cause: unknown) {
    super(
      `${subject}'s terminal is not on the tmux server, but the server it ran on may still ` +
        "be running it; close it with force to record it closed anyway",
      { cause },
    );
  }
}

/** The environment could not act just now; the command can be repeated. */
export class EnvironmentUnavailable extends Error {
  constructor(subject: string, cause: unknown) {
    super(`could not reach the environment running ${subject}`, { cause });
  }
}

/** A close failure force may record past: unconfirmed, or the environment out of reach. */
export const forceable = (cause: unknown) =>
  cause instanceof TerminalUnconfirmed ||
  ![StaleIncarnation, NoTerminal, NotResumable, ProcessState].some((e) => cause instanceof e);

/** An environment's failure as the command's: typed where the caller can act on it. */
export function fromEnvironment(subject: string, cause: unknown): never {
  if (cause instanceof StaleIncarnation) throw new TerminalReplaced(subject, cause);
  if (cause instanceof TerminalUnconfirmed) throw new ServerUnconfirmed(subject, cause);
  if (cause instanceof NoTerminal || cause instanceof NotResumable || cause instanceof ProcessState)
    throw cause;
  throw new EnvironmentUnavailable(subject, cause);
}
