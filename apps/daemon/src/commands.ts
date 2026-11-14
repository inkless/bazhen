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

/** A name a secret is kept under: `api_key`, `experimental_bearer_token`, `x-api-key`, `password`. */
const SECRET_NAME =
  /key|token(?!s)|secret|passw(?:or)?d|credential|bearer|authori[sz]ation|cookie|^auth$/i;

/** Names that, before a colon and a plain word, are prose (`token: expired`), not a value. */
const PROSE_NAMES = new Set(["key", "token", "auth"]);

/**
 * `name = value` or `name: value`, as a TOML or env line, JSON, or Rust's Debug output
 * (`experimental_bearer_token: Some("…")`) shows it. A quoted value runs to its closing quote, or
 * the end of the line when it has none, escaped quotes included; a TOML `"""` string to its
 * closing `"""`; an unquoted value to the end of its line, since a secret can hold spaces. Every
 * repetition is bounded or can't overlap the next, so no input backtracks without end.
 */
const ASSIGNMENT =
  /(\\?["']?)([\w.-]{1,64})\1([ \t]{0,64}([=:])\s{0,64}(?:Some\(\s{0,64})?)((?:(?:bearer|basic|digest|token)\s{1,8})?(?:"""[\s\S]{0,4096}?(?:"""|$)|\\"(?:[^"\\\n]|\\[^"]){0,4096}(?:\\")?|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\n]{1,512}))/gi;

/**
 * Credentials that need no secret-looking name beside them: a private key's PEM block, cut short
 * or whole; a provider's extra headers, whose names are anyone's (`http_headers = { "X-Corp" =
 * "…" }`); a URL's user and password; and the shapes well-known keys take.
 */
const BARE_SECRETS: readonly [RegExp, string][] = [
  [
    /-----BEGIN [A-Z0-9 ]{1,64}-----(?:[\s\S]{0,16384}?-----END [A-Z0-9 ]{1,64}-----|[\s\S]{0,16384})/g,
    "[redacted]",
  ],
  [
    /((?:env_)?http_headers["']?[ \t]{0,64}[=:]\s{0,64}(?:Some\(\s{0,64})?)\{[^}]{0,4096}\}?/gi,
    "$1{[redacted]}",
  ],
  [/(\w{1,32}:\/\/)[^/\s@]{1,256}@/g, "$1[redacted]@"],
  [
    /\b(?:sk-[\w-]{16,512}|[sr]k_(?:live|test)_\w{16,512}|gh[pousr]_\w{20,512}|github_pat_\w{20,512}|glpat-[\w-]{20,512}|hf_\w{20,512}|xox[abprs]-[\w-]{10,512}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]{8,2048}\.eyJ[\w-]{8,2048}\.[\w-]{8,2048})/g,
    "[redacted]",
  ],
];

/** An HTTP authorization scheme and its credentials, in any case, with or without a header name. */
const SCHEME = /\b(bearer|basic)(\s{1,8})([\w.~+/=-]{8,2048})/gi;

/** Credentials look encoded; prose after `basic` or `bearer` is lowercase letters. */
const encoded = (value: string) => /[0-9A-Z+/=]/.test(value);

/**
 * How much of a failure's text is kept: the rest is dropped before it is searched, which also
 * bounds the search's cost, since a name that turns out not to be a secret's has its value
 * searched again.
 */
const SEARCHED_MAX = 16 * DETAIL_MAX;

/**
 * The first SEARCHED_MAX characters, cut back to the last whitespace: a secret cut in two could
 * escape a pattern that needs its end, as a URL's password does its `@`, and a secret can hold
 * any other character.
 */
function searched(text: string): string {
  if (text.length <= SEARCHED_MAX) return text;
  const head = text.slice(0, SEARCHED_MAX);
  const end = Math.max(...[" ", "\n", "\t"].map((d) => head.lastIndexOf(d)), 0);
  return `${head.slice(0, end)}…`;
}

function redacted(text: string): string {
  const bare = BARE_SECRETS.reduce((t, [pattern, to]) => t.replace(pattern, to), text).replace(
    SCHEME,
    (whole, scheme: string, gap: string, value: string) =>
      encoded(value) ? `${scheme}${gap}[redacted]` : whole,
  );
  let out = "";
  let copied = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(bare); m !== null; m = ASSIGNMENT.exec(bare)) {
    const [whole, quote = "", name = "", separator = "", op, value = ""] = m;
    const prose =
      op === ":" && /^[a-z]+(?:\s|$)/i.test(value) && PROSE_NAMES.has(name.toLowerCase());
    if (SECRET_NAME.test(name) && !prose) {
      out += `${bare.slice(copied, m.index)}${quote}${name}${quote}${separator}[redacted]`;
      copied = m.index + whole.length;
    } else {
      // What looked like this name's value may be a secret's name: `error: api_key = …`.
      ASSIGNMENT.lastIndex = m.index + whole.length - value.length;
    }
  }
  return out + bare.slice(copied);
}

/**
 * A failure's own text, safe to store and to answer with: secrets a config line, an environment
 * or a request could echo taken out, and cut to DETAIL_MAX characters (grapheme clusters), never
 * through one.
 */
export function failureDetail(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const safe = redacted(searched(text));
  const chars = [...new Intl.Segmenter().segment(safe)].map((s) => s.segment);
  return chars.length <= DETAIL_MAX ? safe : `${chars.slice(0, DETAIL_MAX - 1).join("")}…`;
}
