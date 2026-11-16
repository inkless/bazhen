import type { EnvironmentAdapter } from "@bazhen/core";
import { vouchHolder, type HolderProcess } from "@bazhen/host-guard";
import type { Store } from "../store/store.ts";

export interface RestartWatchOptions {
  readonly store: Store;
  readonly environment: EnvironmentAdapter;
  /** Proves a holder still runs at its pid, from `ps` alone: host-guard's `vouchHolder`. */
  readonly vouch?: (holder: HolderProcess) => Promise<HolderProcess | null>;
}

/**
 * Keeps the record of which terminals need a restart in step with what their runtimes serve
 * (design §4.7): a terminal on a holder this build can't fully serve is recorded once, and cleared
 * once a build that serves it in full reads it, as after a daemon update. It also keeps, for each
 * such terminal, its holder's pid as last proved still running there, which is all a restart
 * prompt may name: a pid reused since must never be offered up to be ended.
 */
export class RestartWatch {
  private readonly opts: RestartWatchOptions;
  private holders = new Map<string, number>();

  constructor(opts: RestartWatchOptions) {
    this.opts = opts;
  }

  /** The holder to end for `terminalId`, as the last sweep proved it; null when it didn't. */
  holderPid(terminalId: string): number | null {
    return this.holders.get(terminalId) ?? null;
  }

  /** One read of every runtime; one that can't be read throws, and nothing changes. */
  async sweep(): Promise<void> {
    const { store, environment } = this.opts;
    const read = await environment.compatibility?.();
    if (read === undefined) return;
    for (const [terminalId, protocol] of read.outdated) {
      if (!store.restartUnrecorded(terminalId)) continue;
      store.append({
        type: "terminal.needs_restart",
        entityId: terminalId,
        actor: "system",
        payload: { protocol: [...protocol] },
      });
    }
    for (const terminalId of store.restartsRecorded()) {
      if (!read.served.has(terminalId)) continue;
      store.append({
        type: "terminal.restart_cleared",
        entityId: terminalId,
        actor: "system",
        payload: {},
      });
    }
    this.holders = await this.vouched([...read.outdated.keys()]);
  }

  private async vouched(terminalIds: readonly string[]): Promise<Map<string, number>> {
    const vouch = this.opts.vouch ?? vouchHolder;
    const found = new Map<string, number>();
    for (const terminalId of terminalIds) {
      const locator = this.opts.store.runtimeRef(terminalId)?.locator;
      const pid = Number(locator?.holderPid);
      const start = Number(locator?.holderStart);
      if (!(Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(start))) continue;
      if ((await vouch({ pid, start })) !== null) found.set(terminalId, pid);
    }
    return found;
  }
}
