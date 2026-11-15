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
}

/** PTYs left for the rest of the machine, so the user's own terminals and `ssh` still open. */
export const hostHeadroom = (max: number) => Math.max(16, Math.ceil(max / 10));

const terminals = (n: number) => (n === 1 ? "1 terminal is" : `${n} terminals are`);

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
    const { max } = this.deps;
    const open = this.deps.open();
    if (open >= max) {
      throw new TerminalLimit(
        `${terminals(open)} open, the most at once (terminals.max_open = ${max}): close one you no longer need to open another`,
        { open, max, host: false },
      );
    }
    this.admitOnHost(open);
  }

  private admitOnHost(open: number): void {
    const host = this.deps.host();
    if (!host.ok) {
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        this.deps.warn(
          `the machine's PTYs can't be counted (${host.reason}): only terminals.max_open limits new terminals`,
        );
      }
      return;
    }
    const keep = hostHeadroom(host.max);
    const short = host.used >= host.max - keep;
    if (!short) {
      this.warnedShort = false;
      return;
    }
    if (host.exact) {
      throw new TerminalLimit(
        `the machine has ${host.used} of ${host.max} PTYs in use, and Bazhen keeps ${keep} free for the rest of the system: close a terminal, or raise the machine's PTY limit`,
        { open, max: this.deps.max, host: true },
      );
    }
    // An approximate count can include PTYs already closed, so it warns rather than refuse.
    if (!this.warnedShort) {
      this.warnedShort = true;
      this.deps.warn(
        `the machine may have as many as ${host.used} of ${host.max} PTYs in use, within the ${keep} Bazhen keeps free; new terminals still open, since the count can include closed PTYs`,
      );
    }
  }

  report(): BudgetReport {
    const host = this.deps.host();
    return {
      open: this.deps.open(),
      max: this.deps.max,
      host: host.ok ? { used: host.used, max: host.max, exact: host.exact } : null,
    };
  }

  /** What a start should say: terminals kept above a lowered budget, a budget the host can't meet. */
  startupWarnings(): string[] {
    const { max } = this.deps;
    const open = this.deps.open();
    const host = this.deps.host();
    return [
      ...(open > max
        ? [
            `${terminals(open)} open, above terminals.max_open (${max}): they keep running, and new ones are refused until fewer than ${max} are open`,
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
