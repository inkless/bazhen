import type { LimitStop } from "@bazhen/core";
import type { Activity, Usage, UsageLimit } from "@bazhen/protocol";

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
 * The meter can be read after the stop it explains, so the agent's latest stop is weighed again
 * at each change of its usage until the agent reports anything else.
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
    this.opts.record(agentId, this.weigh(agentId, activity, limit) ?? activity);
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

  private reweigh(agentId: string): void {
    const stop = this.stops.get(agentId);
    if (stop === undefined) return;
    const observedAt = this.now().toISOString();
    const limited = this.weigh(agentId, { ...stop.activity, observedAt }, stop.limit);
    if (limited !== null) this.opts.record(agentId, limited);
  }

  private weigh(agentId: string, activity: Activity, limit: LimitStop): Activity | null {
    const now = this.now().getTime();
    const usedUp = (this.opts.usage(agentId)?.limits ?? []).filter(
      (l) => l.usedPercent >= 100 && (l.resetsAt === undefined || Date.parse(l.resetsAt) > now),
    );
    if (usedUp.length === 0 && limit === "rate") return null;
    const resetsAt = usedUp
      .flatMap((l) => (l.resetsAt === undefined ? [] : [l.resetsAt]))
      .toSorted();
    const latest = resetsAt.at(-1);
    return { ...activity, value: "limited", ...(latest !== undefined && { resetsAt: latest }) };
  }
}

/** The usage limits held, with those an update names replaced and those it leaves out kept. */
export function mergeLimits(
  held: readonly UsageLimit[] | undefined,
  update: readonly UsageLimit[],
): UsageLimit[] {
  const named = new Map(update.map((l) => [l.window, l]));
  const kept = (held ?? []).map((l) => named.get(l.window) ?? l);
  const known = new Set(kept.map((l) => l.window));
  return [...kept, ...update.filter((l) => !known.has(l.window))];
}
