import { z } from "zod";
import { ENV_RULE, filterEnv, type EnvRules } from "@bazhen/core";

type Env = Readonly<Record<string, string | undefined>>;

/** What `bazhen start` tells the daemon it removed: when, and how many per rule; never values. */
const HANDOFF = "BAZHEN_CAPTURE";
const Handoff = z.strictObject({
  at: z.iso.datetime(),
  removed: z.record(z.string().regex(ENV_RULE), z.int().nonnegative()),
});

/** What Bazhen sets for each agent: started from inside one, the daemon must not carry it. */
const PER_AGENT = new Set(["BAZHEN_AGENT_ID", "BAZHEN_SOCKET"]);

export interface Capture {
  /** What every agent starts with (foundation-design §9.5). */
  readonly env: Readonly<Record<string, string>>;
  /** How many variables each denying rule removed, for `bazhen doctor`. */
  readonly removed: Readonly<Record<string, number>>;
  readonly at: string;
}

/**
 * The environment `bazhen start` gives the daemon: the user's, minus what no agent may inherit,
 * plus Bazhen's own settings, which the daemon reads and strips again before any agent sees them.
 * So the daemon never holds a parent harness's session variables or messaging socket (§2).
 */
export function handOff(env: Env, rules: EnvRules, now = new Date()): Record<string, string> {
  const { env: kept, removed } = filterEnv(env, rules);
  const own = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith("BAZHEN_") && !PER_AGENT.has(entry[0]) && entry[1] !== undefined,
  );
  const handoff = { at: now.toISOString(), removed };
  return { ...kept, ...Object.fromEntries(own), [HANDOFF]: JSON.stringify(handoff) };
}

/** The daemon's capture, once at boot, counting what `bazhen start` removed before it existed. */
export function capture(env: Env, rules: EnvRules, now = new Date()): Capture {
  const own = filterEnv(env, rules);
  const handoff = parseHandoff(env[HANDOFF]);
  if (handoff === undefined) return { ...own, at: now.toISOString() };
  // The BAZHEN_* the daemon removes here are its own settings, which start already counted.
  const { "BAZHEN_*": _settings, ...counted } = own.removed;
  const removed: Record<string, number> = { ...counted };
  for (const [rule, count] of Object.entries(handoff.removed))
    removed[rule] = (removed[rule] ?? 0) + count;
  return { env: own.env, removed, at: handoff.at };
}

function parseHandoff(raw: string | undefined): z.infer<typeof Handoff> | undefined {
  if (raw === undefined) return undefined;
  try {
    return Handoff.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}
