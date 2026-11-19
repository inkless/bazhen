import type { ProgramExit } from "@bazhen/core";
import type { ExitStatus } from "@bazhen/protocol";
import { Settle } from "./settle.ts";

/**
 * One client's exits of its terminal's process, from the runtime's polled reports of it.
 *
 * tmux calls a pane dead only once it has read the pane to its end, but its redraw of that last
 * output to this client can still be on its way when the poll answers, and tmux says nothing in
 * the client's own bytes. So an exit is told once the client's output has been quiet for `quietMs`
 * after the exit was seen, or after `maxWaitMs` at most: after the program's last output unless
 * that output takes longer than the bound to arrive. A holder's exit is ordered by construction;
 * this one is bounded.
 */
export class ExitWatch {
  /** The lowest generation whose exit may still be told: a respawn's raises it. */
  private floor: number;
  private pending: ProgramExit | null = null;
  private told: ProgramExit | null = null;
  private readonly listeners: ((exit: ProgramExit) => void)[] = [];
  private readonly settle: Settle;

  /** `generation` is that of the process running as the client attached. */
  constructor(quietMs: number, maxWaitMs: number, generation: number) {
    this.floor = generation;
    this.settle = new Settle(quietMs, maxWaitMs, () => this.tell());
  }

  /** A report of the terminal's process at `generation`: how it ended, or null while it runs. */
  report(generation: number, status: ExitStatus | null): void {
    if (generation < this.floor) return;
    if (status === null) {
      this.respawned(generation);
      return;
    }
    if (this.told?.generation === generation || this.pending?.generation === generation) return;
    this.pending = { generation, status };
    this.settle.poke();
  }

  /** A process of `generation` replaced the one before it. */
  respawned(generation: number): void {
    this.floor = Math.max(this.floor, generation);
    if (this.pending !== null && this.pending.generation < this.floor) {
      this.pending = null;
      this.settle.reset();
    }
    if (this.told !== null && this.told.generation < this.floor) this.told = null;
  }

  /** The client printed. */
  output(): void {
    if (this.pending !== null) this.settle.poke();
  }

  onExit(cb: (exit: ProgramExit) => void): void {
    this.listeners.push(cb);
  }

  get exited(): ProgramExit | null {
    return this.told;
  }

  dispose(): void {
    this.settle.dispose();
  }

  private tell(): void {
    const exit = this.pending;
    if (exit === null) return;
    this.pending = null;
    this.told = exit;
    for (const cb of this.listeners) cb(exit);
  }
}
