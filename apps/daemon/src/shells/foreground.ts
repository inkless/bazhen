import type { EnvironmentAdapter, ShellForeground } from "@bazhen/core";
import type { Store } from "../store/store.ts";

export interface ForegroundDeps {
  readonly store: Store;
  readonly environment: EnvironmentAdapter;
  readonly log?: (message: string) => void;
}

/** The longest program name an event carries; a name is a word, never a command line. */
const COMMAND_MAX = 200;

/**
 * Keeps each running shell's foreground current from process facts, never from its screen
 * (foundation-design §4.8, §12 item 17): one read of the running shells, on the server watch's
 * tick and whenever a view attaches to a shell, and none while no shell runs. An event is recorded
 * only when what runs changes, and it names the program alone, never its command line: that is
 * the shell's own expansion of what the user typed, secrets included.
 */
export class ForegroundWatch {
  private readonly deps: ForegroundDeps;
  private reading: Promise<void> | undefined;
  /** The last failure of a read, so a persistent one is said once. */
  private fault: string | undefined;

  constructor(deps: ForegroundDeps) {
    this.deps = deps;
  }

  /** One read; a refresh asked for while one runs gets that one. It never rejects. */
  refresh(): Promise<void> {
    this.reading ??= this.read()
      .then(() => (this.fault = undefined))
      .catch((err: unknown) => {
        const fault = `shells: could not read their foregrounds: ${String(err)}`;
        if (fault !== this.fault) (this.deps.log ?? console.warn)(fault);
        this.fault = fault;
      })
      .finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async read(): Promise<void> {
    const { store, environment } = this.deps;
    const running = () =>
      store.recoverableShells(environment.id).filter((s) => s.state === "running");
    const refs = running().flatMap((s) => (s.runtime === null ? [] : [s.runtime]));
    if (refs.length === 0) return;
    const seen = new Map<string, ShellForeground>(
      (await environment.shellForegrounds(refs)).map((f) => [f.ref.terminalId, f]),
    );
    // Read again after the environment answered: a shell closed meanwhile is left as it is.
    for (const shell of running()) {
      const found = seen.get(shell.terminalId);
      if (found === undefined) continue;
      if (found.ref.locator.generation !== String(shell.generation)) continue;
      store.transaction(() => {
        if (found.cwd !== null && found.cwd !== shell.currentCwd)
          store.noteShellCwd(shell.terminalId, found.cwd);
        const command = found.command?.slice(0, COMMAND_MAX) ?? null;
        if (command === shell.foreground) return;
        store.append({
          type: "terminal.foreground_changed",
          entityId: shell.terminalId,
          actor: "system",
          payload: { command },
        });
      });
    }
  }
}
