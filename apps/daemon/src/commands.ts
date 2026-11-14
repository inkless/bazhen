import {
  HarnessRefused,
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
    super(`could not reach the environment running ${subject}: ${failureDetail(cause)}`, {
      cause,
    });
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
  const typed = [NoTerminal, NotResumable, ProcessState, HarnessRefused];
  if (typed.some((e) => cause instanceof e)) throw cause;
  throw new EnvironmentUnavailable(subject, cause);
}

/** The most of a failure's text an event or an answer carries. */
export const DETAIL_MAX = 500;

/**
 * Where a failure's text could hold a secret: a value assigned to a name that says it is one, as a
 * config line or an environment variable echoed back (`api_key = "…"`, `OPENAI_API_KEY=…`, a JSON
 * `"token": "…"`); an `Authorization` scheme's credentials; a URL's user and password; and the
 * shapes well-known keys take wherever they appear. Prose such as `auth: failed` is left as is.
 */
const SECRETS: readonly [RegExp, string][] = [
  [
    /(["']?[\w.-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w.-]*["']?\s*=\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
    "$1[redacted]",
  ],
  [
    /("[\w.-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w.-]*"\s*:\s*)("[^"]*"|[^\s,;)}\]]+)/gi,
    "$1[redacted]",
  ],
  [/\b(Bearer|Basic|Token)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
  [/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@"],
  [
    /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35})/g,
    "[redacted]",
  ],
];

/**
 * A failure's own text, safe to store and to answer with: its secrets taken out, and cut to
 * DETAIL_MAX characters, never through one.
 */
export function failureDetail(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const safe = SECRETS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);
  const chars = [...new Intl.Segmenter().segment(safe)].map((s) => s.segment);
  return chars.length <= DETAIL_MAX ? safe : `${chars.slice(0, DETAIL_MAX - 1).join("")}…`;
}
