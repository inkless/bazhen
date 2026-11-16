import { z } from "zod";
import { Id, ID_BODY } from "./ids.ts";

/**
 * The prefix of every kind of Bazhen id (foundation-design §3): no name is a whole id of any. Core
 * mints the ids, and a test there holds this list to its kinds.
 */
export const ID_PREFIXES = [
  "host",
  "env",
  "agent",
  "task",
  "asgn",
  "attn",
  "ntc",
  "msg",
  "term",
  "dev",
  "att",
  "lease",
] as const;

/** The most characters an agent's name has. */
export const AGENT_NAME_MAX = 40;

/**
 * An agent's name, the handle a human or another agent addresses it by (foundation-design §11.4):
 * the characters a Claude Code session name takes unquoted. It starts with a letter or digit, so
 * a command line never reads it as an option, and it is never exactly an id of any kind, so a
 * reference is always one or the other. `agent_tools` is a name; only a whole id is refused. A
 * default name fits within the 40 because its base is cut to 32, leaving `-` and seven digits.
 */
export const AgentName = z
  .string()
  .regex(
    new RegExp(
      `^(?!(?:${ID_PREFIXES.join("|")})_${ID_BODY}$)[A-Za-z0-9][A-Za-z0-9_-]{0,${AGENT_NAME_MAX - 1}}$`,
    ),
    {
      message:
        "a name is 1 to 40 letters, digits, - or _, starts with a letter or digit, and isn't an id",
    },
  );

/** An agent as a request names it: by its id, or by the name of one not ended (protocol 1.40). */
export const AgentRef = z.union([Id("agent"), AgentName]);

/**
 * The longest base a default name keeps, which leaves room within a name's 40 characters for
 * `-` and a seven-digit number. A fixed length, rather than one that shrinks as the number
 * grows, keeps one base per project, so two long projects can't share a counter's numbers.
 */
const BASE_MAX = 32;

const trim = (s: string) => s.replaceAll(/^[-_]+|[-_]+$/g, "");

/**
 * A project made into the start of a default name: each run of characters a name can't hold
 * becomes `-`, and the ends lose their `-` and `_`, so the name starts with a letter or digit. A
 * default name ends `-<n>`, which no id does. The daemon keys its never-reused counters by this,
 * so a change to it moves them.
 */
export function nameBase(project: string): string {
  const base = trim(trim(project.replaceAll(/[^A-Za-z0-9_-]+/g, "-")).slice(0, BASE_MAX));
  return base === "" ? "agent" : base;
}

/** The default name numbered `ordinal` under `base`, as `nameBase` makes one. */
export const defaultName = (base: string, ordinal: number): string => `${base}-${ordinal}`;
