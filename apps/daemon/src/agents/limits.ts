import type { LimitStop } from "@bazhen/core";
import { USAGE_LIMITS_MAX, type Activity, type Usage, type UsageLimit } from "@bazhen/protocol";

/** The events that say an agent's process has gone, or is going. */
const GONE: ReadonlySet<string> = new Set(["agent.exited", "agent.lost", "agent.closing"]);

type Recorded = { readonly type: string; readonly entityId: string };

export interface LimitsOptions {
  /** The usage the agent's harness last reported. */
  readonly usage: (agentId: string) => Usage | undefined;
  /** Stores the agent's usage, and says null when it was already what it held. */
  readonly recordUsage: (agentId: string, usage: Usage) => number | null;
  readonly record: (agentId: string, activity: Activity) => void;
  readonly now?: () => Date;
}

/**
 * Whether a turn its harness says the account's limit may have stopped is `limited`, against the
 * usage limits the harness last reported. `limited` says the agent waits for a window to reset,
 * so it takes a window used up and not yet reset, as only the harness's meter shows. A `rate`
 * stop without one stays failed: a passing 429 looks the same, and so does any 429 from a harness
 * that reports no meter. A `quota` stop is the account's usage limit by the harness's own word,
 * so it is limited with or without a window, and resets when that window does.
 *
 * A window counts as used up only with a reset still to come. One that gives no reset, or whose
 * reset has passed, may be stale: a merged window keeps its last reading until an update names
 * it again, and one the harness has renamed is never named again.
 *
 * The meter can be read after the stop it explains, so the agent's latest stop is weighed again
 * at each change of its usage until the agent reports anything else. Weighed again, it records
 * only a window used up: a later reading that shows none, as another turn's on the same account
 * may, says nothing of what stopped this one.
 */
export class Limits {
  private readonly opts: LimitsOptions;
  private readonly now: () => Date;
  private readonly stops = new Map<string, { activity: Activity; limit: LimitStop }>();

  constructor(opts: LimitsOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /** Records what the agent's harness reports it doing, `limited` when the usage shows it. */
  record(agentId: string, activity: Activity, limit?: LimitStop): void {
    if (limit === undefined) {
      this.stops.delete(agentId);
      return this.opts.record(agentId, activity);
    }
    const resetsAt = this.resetOf(agentId);
    this.opts.record(
      agentId,
      resetsAt === null && limit === "rate" ? activity : limited(activity, resetsAt),
    );
    this.stops.set(agentId, { activity, limit });
  }

  /** Records the usage the agent's harness reports, which may show why its last turn stopped. */
  recordUsage(agentId: string, usage: Usage): void {
    if (this.opts.recordUsage(agentId, usage) !== null) this.reweigh(agentId);
  }

  /**
   * Records an update of an account's limits for each agent on it. The update is sparse: a window
   * it leaves out keeps what was last said of it.
   */
  accountLimits(agentIds: readonly string[], update: readonly UsageLimit[]): void {
    for (const agentId of agentIds) {
      const usage = this.opts.usage(agentId);
      this.recordUsage(agentId, { ...usage, limits: mergeLimits(usage?.limits, update) });
    }
  }

  /** Forgets an agent's stop once its process has gone, from the events `react` hands on. */
  follow(react: (reactor: (event: Recorded) => void) => () => void): () => void {
    return react((e) => {
      if (GONE.has(e.type)) this.stops.delete(e.entityId);
    });
  }

  private reweigh(agentId: string): void {
    const stop = this.stops.get(agentId);
    const resetsAt = this.resetOf(agentId);
    if (stop === undefined || resetsAt === null) return;
    const observedAt = this.now().toISOString();
    this.opts.record(agentId, limited({ ...stop.activity, observedAt }, resetsAt));
  }

  /** The latest reset of the agent's windows that are used up, or null when none is. */
  private resetOf(agentId: string): string | null {
    const now = this.now().getTime();
    const resets = (this.opts.usage(agentId)?.limits ?? []).flatMap((l) =>
      l.usedPercent >= 100 && l.resetsAt !== undefined && Date.parse(l.resetsAt) > now
        ? [l.resetsAt]
        : [],
    );
    return resets.toSorted().at(-1) ?? null;
  }
}

const limited = (activity: Activity, resetsAt: string | null): Activity => ({
  ...activity,
  value: "limited",
  ...(resetsAt !== null && { resetsAt }),
});

/**
 * The usage limits held, with those an update names replaced and those it leaves out kept. Past
 * the most usage holds, the oldest of those it leaves out go first.
 */
export function mergeLimits(
  held: readonly UsageLimit[] | undefined,
  update: readonly UsageLimit[],
): UsageLimit[] {
  const named = new Map(update.map((l) => [l.window, l]));
  const kept = (held ?? []).map((l) => named.get(l.window) ?? l);
  const known = new Set(kept.map((l) => l.window));
  const merged = [...kept, ...update.filter((l) => !known.has(l.window))];
  let over = merged.length - USAGE_LIMITS_MAX;
  return merged.filter((l) => named.has(l.window) || over-- <= 0);
}
