import type { RuntimeRef } from "@bazhen/core";
import { ShellCommandLine } from "@bazhen/protocol";

/** How long a restarted shell has to report its first prompt before its line is dropped. */
export const RETYPE_WITHIN_MS = 30_000;

/** Runs `run` once `ms` have passed, unless the function it returns cancels it first. */
export type After = (ms: number, run: () => void) => () => void;

/** On the daemon's clock, never keeping the daemon running for it. */
export const afterTimeout: After = (ms, run) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface RetypeDeps {
  /**
   * Types the line at the prompt of the shell `ref` names, without Enter, marked as a paste with
   * the bracketed-paste sequences when `brackets` is true.
   */
  readonly paste: (ref: RuntimeRef, line: string, brackets: boolean) => Promise<void>;
  readonly log: (message: string) => void;
  readonly after?: After;
}

interface Pending {
  readonly line: string;
  ref: RuntimeRef | null;
  /** Null until the shell reports its prompt; then whether its editor reads a marked paste. */
  brackets: boolean | null;
  readonly cancelExpiry: () => void;
}

/**
 * The lines restarts are to type into their new shells, held in memory only, never written
 * anywhere, until the new shell reports its first prompt. Each is typed once at most, and dropped
 * if no prompt comes in time: the shell's integration didn't load. A log names the shell, never
 * the line.
 */
export class PendingRetypes {
  private readonly deps: RetypeDeps;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: RetypeDeps) {
    this.deps = deps;
  }

  /** Holds `line` for the shell `terminalId`, recorded but not yet started. */
  hold(terminalId: string, line: string): void {
    this.drop(terminalId);
    const cancelExpiry = (this.deps.after ?? afterTimeout)(RETYPE_WITHIN_MS, () => {
      if (this.pending.delete(terminalId))
        this.skipped(terminalId, `no prompt reported within ${RETYPE_WITHIN_MS / 1000} s`);
    });
    this.pending.set(terminalId, { line, ref: null, brackets: null, cancelExpiry });
  }

  /** The shell started as `ref`; a prompt it reported meanwhile gets its line now. */
  opened(terminalId: string, ref: RuntimeRef): void {
    const held = this.pending.get(terminalId);
    if (held === undefined) return;
    held.ref = ref;
    if (held.brackets !== null) this.type(terminalId, held);
  }

  /**
   * The shell reported its first prompt: its line is typed, once it is known where. A later
   * report changes nothing: the first is the shell's integration's own, at its first prompt.
   */
  prompted(terminalId: string, brackets: boolean): void {
    const held = this.pending.get(terminalId);
    if (held === undefined || held.brackets !== null) return;
    held.brackets = brackets;
    if (held.ref !== null) this.type(terminalId, held);
  }

  /** Forgets the shell's line, as for one that failed to open. */
  drop(terminalId: string): void {
    const held = this.pending.get(terminalId);
    if (held === undefined) return;
    held.cancelExpiry();
    this.pending.delete(terminalId);
  }

  private type(terminalId: string, held: Pending): void {
    this.drop(terminalId);
    if (held.ref === null) return;
    // Checked again as it is typed: whatever held it, nothing but a line safe to type gets here.
    if (!ShellCommandLine.safeParse(held.line).success) {
      this.skipped(terminalId, "it is not a line that can be typed safely");
      return;
    }
    this.deps
      .paste(held.ref, held.line, held.brackets === true)
      .catch((err: unknown) => this.skipped(terminalId, errorName(err)));
  }

  private skipped(terminalId: string, why: string): void {
    this.deps.log(`shell ${terminalId}: last command not retyped: ${why}`);
  }
}

/** A failed paste, by the message the runtime wrote for logs, which names the pane, never the text. */
const errorName = (err: unknown): string => (err instanceof Error ? err.message : "paste failed");
