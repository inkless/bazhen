import type { HostPtys } from "@bazhen/host-guard";

/** A new terminal refused: past `terminals.max_open`, or with the machine short of PTYs. */
export class TerminalLimit extends Error {
  override readonly name = "TerminalLimit";
  readonly open: number;
  readonly max: number;
  /** Whether the machine's own PTYs refused it, rather than the budget. */
  readonly host: boolean;

  constructor(message: string, limit: { open: number; max: number; host: boolean }) {
    super(message);
    this.open = limit.open;
    this.max = limit.max;
    this.host = limit.host;
  }
}

export interface BudgetDeps {
  /** `terminals.max_open`. */
  readonly max: number;
  /** How many terminals are open now (`Store.openTerminals`). */
  readonly open: () => number;
  /**
   * How many are still being created (`Store.startingTerminals`): their PTYs may not be in the
   * machine's count yet, so a burst of launches would otherwise all pass its check.
   */
  readonly starting: () => number;
  readonly host: () => HostPtys;
  readonly warn: (message: string) => void;
}

/** Where a new terminal asks for its slot, in the same synchronous step that records it. */
export interface TerminalAdmission {
  admit(): void;
}

/** What `bazhen doctor` shows. */
export interface BudgetReport {
  readonly open: number;
  readonly max: number;
  readonly host: { readonly used: number; readonly max: number; readonly exact: boolean } | null;
  /** Which limit refuses a new terminal now, if one does. */
  readonly refusing: "budget" | "host" | null;
}

/** PTYs left for the rest of the machine, so the user's own terminals and `ssh` still open. */
export const hostHeadroom = (max: number) => Math.max(16, Math.ceil(max / 10));

const terminals = (n: number) => (n === 1 ? "1 terminal is" : `${n} terminals are`);

/** Where the machine stands: short when one more PTY would leave less than its headroom free. */
type HostCheck =
  | { readonly kind: "unread"; readonly reason: string }
  | { readonly kind: "room" }
  | {
      readonly kind: "short";
      readonly used: number;
      readonly keep: number;
      readonly host: Counted;
    };

type Counted = Extract<HostPtys, { ok: true }>;

/**
 * Admits new terminals. The open count is the store's, so admitting inside the transaction that
 * records the terminal reserves its slot, and every end the store records gives it back.
 */
export class TerminalBudget implements TerminalAdmission {
  private readonly deps: BudgetDeps;
  private warnedUnreadable = false;
  private warnedShort = false;

  constructor(deps: BudgetDeps) {
    this.deps = deps;
  }

  /** Throws `TerminalLimit` when one more terminal may not open. Call it before recording one. */
  admit(): void {
    const open = this.deps.open();
    const overBudget = this.budgetRefusal(open);
    if (overBudget !== null) throw overBudget;
    const host = this.hostCheck();
    if (host.kind === "unread") {
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.deps.warn(
          `the machine's PTYs can't be counted (${host.reason}): only terminals.max_open limits new terminals`,
        );
      }
      return;
    }
    if (host.kind === "room") {
      this.warnedShort = false;
      return;
    }
    const refused = this.hostRefusal(open, host);
    if (refused !== null) throw refused;
    // An approximate count can include PTYs already closed, so it warns rather than refuse.
    if (!this.warnedShort) {
      this.warnedShort = true;
      this.deps.warn(
        `the machine may have as many as ${host.used} of ${host.host.max} PTYs in use, within the ${host.keep} Bazhen keeps free; new terminals still open, since the count can include closed PTYs`,
      );
    }
  }

  report(): BudgetReport {
    const open = this.deps.open();
    const counted = this.deps.host();
    const host = this.hostCheck(counted);
    const refusing =
      this.budgetRefusal(open) !== null
        ? "budget"
        : host.kind === "short" && this.hostRefusal(open, host) !== null
          ? "host"
          : null;
    return {
      open,
      max: this.deps.max,
      host: counted.ok ? { used: counted.used, max: counted.max, exact: counted.exact } : null,
      refusing,
    };
  }

  private budgetRefusal(open: number): TerminalLimit | null {
    const { max } = this.deps;
    if (open < max) return null;
    return new TerminalLimit(
      `${terminals(open)} open, the most at once (terminals.max_open = ${max}): close one you no longer need to open another`,
      { open, max, host: false },
    );
  }

  private hostCheck(counted: HostPtys = this.deps.host()): HostCheck {
    if (!counted.ok) return { kind: "unread", reason: counted.reason };
    const keep = hostHeadroom(counted.max);
    const used = counted.used + this.deps.starting();
    return used >= counted.max - keep
      ? { kind: "short", used, keep, host: counted }
      : { kind: "room" };
  }

  /** The refusal a short machine gives, where its count is exact enough to refuse on. */
  private hostRefusal(
    open: number,
    short: Extract<HostCheck, { kind: "short" }>,
  ): TerminalLimit | null {
    if (!short.host.exact) return null;
    return new TerminalLimit(
      `the machine has ${short.used} of ${short.host.max} PTYs in use or being opened, and Bazhen keeps ${short.keep} free for the rest of the system: close a terminal, or raise ${short.host.limit}`,
      { open, max: this.deps.max, host: true },
    );
  }

  /** What a start should say: terminals kept above a lowered budget, a budget the host can't meet. */
  startupWarnings(): string[] {
    const { max } = this.deps;
    const open = this.deps.open();
    const host = this.deps.host();
    return [
      ...(open > max
        ? [
            `${terminals(open)} open, above terminals.max_open (${max}): they keep running, and a new one opens once ${open - max + 1} of them have closed`,
          ]
        : []),
      ...(host.ok && max > host.max
        ? [
            `terminals.max_open (${max}) is above the machine's ${host.max} PTYs: the machine's own limit is reached first`,
          ]
        : []),
    ];
  }
}
