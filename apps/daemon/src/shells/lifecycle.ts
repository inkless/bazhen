import {
  newId,
  NoTerminal,
  ProcessState,
  StaleIncarnation,
  TerminalUnconfirmed,
  type AgentSessionId,
  type EnvironmentAdapter,
  type RuntimeRef,
  type Size,
} from "@bazhen/core";
import {
  ShellCommandResponse,
  type CloseShellRequest,
  type EventPayload,
  type EventType,
  type OpenShellRequest,
} from "@bazhen/protocol";
import { resolveDirectory } from "../agents/cwd.ts";
import { forceable } from "../agents/lifecycle.ts";
import type { AgentQueue } from "../agents/queue.ts";
import {
  UnknownAgent,
  runtimePayload,
  shellCommands,
  type ShellTerminal,
  type Store,
} from "../store/store.ts";

export class UnknownShell extends Error {
  constructor(terminalId: string) {
    super(`no shell ${terminalId}`);
  }
}

/** The shell's state does not allow the command, and never will. */
export class ShellStateConflict extends Error {
  constructor(subject: string, state: string) {
    super(`${subject} is ${state}`);
  }
}

/** A command named a generation the shell has moved past. */
export class StaleShellGeneration extends Error {
  constructor(terminalId: string, current: number) {
    super(`shell ${terminalId} is at generation ${current}`);
  }
}

/** Something other than the shell runs in it, so a close must be confirmed (§4.8). */
export class ShellBusy extends Error {
  readonly command: string;

  constructor(terminalId: string, command: string) {
    super(`${command} is running in shell ${terminalId}; close it anyway to end it`);
    this.command = command;
  }
}

/** The runtime could not open the shell; it is recorded as failed. */
export class ShellOpenFailed extends Error {
  constructor(terminalId: string, cause: unknown) {
    super(`shell ${terminalId} failed to open`, { cause });
  }
}

/** The shell's tmux server or pane is not the one recorded, so it can't be acted on safely. */
export class ShellReplaced extends Error {
  constructor(terminalId: string, cause: unknown) {
    super(
      `shell ${terminalId}'s terminal is not the one recorded; its server or pane has changed`,
      {
        cause,
      },
    );
  }
}

/** As an agent's: gone from view, but its old server may still run it; force records it closed. */
export class ShellServerUnconfirmed extends Error {
  constructor(terminalId: string, cause: unknown) {
    super(
      `shell ${terminalId} is not on the tmux server, but the server it ran on may still be ` +
        "running it; close it with force to record it closed anyway",
      { cause },
    );
  }
}

/** The environment could not act just now; the command can be repeated. */
export class ShellEnvironmentUnavailable extends Error {
  constructor(terminalId: string, cause: unknown) {
    super(`could not reach the environment running shell ${terminalId}`, { cause });
  }
}

/** Shell states in which a dead pane is still to be ended and recorded closed. */
const ENDING: ReadonlySet<string> = new Set(["running", "closing"]);

/** Agent states whose directory still holds their work, so a shell can be opened beside them. */
const LINKABLE: ReadonlySet<string> = new Set(["running", "exited"]);

export interface ShellDeps {
  readonly store: Store;
  readonly environment: EnvironmentAdapter;
  /** Orders commands per entity; a shell's are keyed by its TerminalId. */
  readonly queue: AgentQueue;
  /** The terminal's size until a view attaches and sets its own. */
  readonly size: Size;
  /** The daemon user's home: a standalone shell's default directory, and what `~` names. */
  readonly home: string;
  readonly log?: (message: string) => void;
}

/**
 * Shell terminals (foundation-design §4.8): opening one, closing it from the UI, and closing it at
 * once when its shell exits. Commands on one shell run one at a time, on the agents' queue. Whoever can reach the
 * daemon's API can open and close shells, confirming a busy close included: the browser, the CLI
 * and any process holding BAZHEN_SOCKET, agents among them, as with agents' own commands (§9.4).
 */
export class ShellLifecycle {
  private readonly deps: ShellDeps;
  /**
   * Exited shells whose session couldn't be ended, by terminal and generation. The poller reports
   * a dead pane every second until it is ended, so a failure is logged once, not every time.
   */
  private readonly unended = new Set<string>();

  constructor(deps: ShellDeps) {
    this.deps = deps;
  }

  /** Closes shells whose process the environment reports ended; returns the stop function. */
  watch(): () => void {
    return this.deps.environment.onExit((ref) => void this.exited(ref));
  }

  /**
   * Opens a shell, linked to a live agent in its directory or standalone. The terminal is recorded
   * before the environment starts it, and the key's answer with it, so a retry opens nothing new.
   */
  async open(req: OpenShellRequest): Promise<ShellCommandResponse> {
    const { store, environment, size, home } = this.deps;
    const request = { command: "open", ...req };
    const prior = store.replay(req.idempotencyKey, request, (r) => ShellCommandResponse.parse(r));
    if (prior !== undefined) {
      if (store.shell(prior.terminalId)?.state === "failed")
        throw new ShellOpenFailed(prior.terminalId, "an earlier attempt failed");
      return prior;
    }
    const linked = req.linkedAgentId === undefined ? undefined : this.linkable(req.linkedAgentId);
    const cwd = linked?.cwd ?? resolveDirectory(req.cwd ?? "~", home);
    const linkedAgentId = linked?.agentId ?? null;
    const terminalId = newId("term");
    const opened = store.transaction(() => {
      const response = {
        terminalId,
        eventIds: [
          this.record(terminalId, "terminal.opened", {
            environmentId: environment.id,
            cwd,
            linkedAgentId,
            ...(req.theme && { theme: req.theme }),
          }),
        ],
      };
      store.answered(req.idempotencyKey, request, response);
      return response;
    });
    const ref = await environment
      .openShell({
        terminalId,
        cwd,
        size,
        ...(linkedAgentId !== null && { linkedAgentId }),
        ...(req.theme && { theme: req.theme }),
      })
      .catch((cause: unknown) => {
        console.error(`shell ${terminalId} failed to open:`, cause);
        this.record(terminalId, "terminal.failed", { reason: "open_rejected" });
        throw new ShellOpenFailed(terminalId, cause);
      });
    const running = this.record(terminalId, "terminal.running", {
      runtimeRef: runtimePayload(ref),
    });
    return { terminalId, eventIds: [...opened.eventIds, running] };
  }

  /**
   * Ends a shell and everything in it, asking first (`busy`) when the shell isn't what runs in
   * its foreground. A lost shell is only taken off the list: there is nothing left to end.
   */
  close(terminalId: string, req: CloseShellRequest): Promise<ShellCommandResponse> {
    const request = { command: "close", terminalId, ...req };
    return this.deps.queue.run(terminalId, async () => {
      const { store } = this.deps;
      const prior = store.replay(req.idempotencyKey, request, (r) => ShellCommandResponse.parse(r));
      if (prior !== undefined) return prior;
      const found = store.shell(terminalId);
      if (found === undefined) throw new UnknownShell(terminalId);
      const accepts =
        req.force === true
          ? found.state === "closing"
          : shellCommands(found.state).includes("close");
      if (found.state !== "closed" && !accepts)
        throw new ShellStateConflict(`shell ${terminalId}`, found.state);
      if (found.generation !== req.generation)
        throw new StaleShellGeneration(terminalId, found.generation);
      const eventIds: number[] = [];
      if (found.state !== "closed") {
        if (found.state === "running" && req.confirmBusy !== true) await this.refuseBusy(found);
        if (found.state !== "closing")
          eventIds.push(this.record(terminalId, "terminal.closing", {}));
        if (found.state !== "lost") await this.end(found, req.force === true);
      }
      return store.transaction(() => {
        if (found.state !== "closed")
          eventIds.push(this.record(terminalId, "terminal.closed", { reason: "user" }));
        const response = { terminalId, eventIds };
        store.answered(req.idempotencyKey, request, response);
        return response;
      });
    });
  }

  /**
   * A shell that exits closes at once, with no warning (§4.8). Its pane stays dead until then, so
   * an exit while the daemon was down is still seen, and closed, rather than taken for a loss.
   */
  private exited(ref: RuntimeRef): Promise<void> {
    const incarnation = `${ref.terminalId}:${ref.locator.generation ?? ""}`;
    return this.deps.queue
      .run(ref.terminalId, async () => {
        const found = this.deps.store.shell(ref.terminalId);
        if (found === undefined || !ENDING.has(found.state)) return;
        if (ref.locator.generation !== String(found.generation)) return;
        await this.closeExited(found);
        this.unended.delete(incarnation);
      })
      .catch((err: unknown) => {
        if (this.unended.has(incarnation)) return;
        this.unended.add(incarnation);
        this.log(`shell ${ref.terminalId}: could not end it after it exited: ${String(err)}`);
      });
  }

  /**
   * Ends a shell whose process has exited, and records it closed. Closing goes first, so a view
   * whose stream ends with the session is told the terminal closed, not that it disconnected; a
   * close that fails leaves it closing, for the next exit report or reconciliation to finish.
   * Reconciliation uses it too.
   */
  async closeExited(found: ShellTerminal): Promise<void> {
    if (found.runtime === null) throw new NoTerminal();
    if (found.state !== "closing") this.record(found.terminalId, "terminal.closing", {}, "system");
    await this.deps.environment.close({ runtime: found.runtime, externalRef: null });
    this.record(found.terminalId, "terminal.closed", { reason: "exited" }, "system");
  }

  /**
   * Refuses the close while a program other than the shell holds the foreground. One the user
   * starts between this check and the close is ended with it: the check is a warning, not a lock,
   * as for any terminal. A shell already dead has nothing running to warn about.
   */
  private async refuseBusy(found: ShellTerminal): Promise<void> {
    if (found.runtime === null) return;
    const command = await this.deps.environment.shellBusy(found.runtime).catch((cause: unknown) => {
      if (cause instanceof ProcessState) return null;
      return fromEnvironment(found.terminalId, cause);
    });
    if (command !== null) throw new ShellBusy(found.terminalId, command);
  }

  private async end(found: ShellTerminal, force: boolean): Promise<void> {
    if (found.runtime === null) return;
    await this.deps.environment
      .close({ runtime: found.runtime, externalRef: null })
      .catch((cause: unknown) => {
        if (!force || !forceable(cause)) fromEnvironment(found.terminalId, cause);
        this.log(
          `shell ${found.terminalId} closed by force; its terminal's tmux server ` +
            `(pid ${found.runtime?.locator.serverPid ?? "unknown"}) may still be running it`,
        );
      });
  }

  /** The agent a shell is to be linked to, and the directory it opens in: the agent's own. */
  private linkable(agentId: string): { agentId: AgentSessionId; cwd: string } {
    const { store } = this.deps;
    const agent = store.agentTerminal({ agentId });
    const launched = store.agentLaunch(agentId);
    if (agent === undefined || launched === undefined) throw new UnknownAgent(agentId);
    if (!LINKABLE.has(agent.state)) throw new ShellStateConflict(`agent ${agentId}`, agent.state);
    return { agentId: agent.agentId, cwd: launched.launch.cwd };
  }

  private record<T extends Extract<EventType, `terminal.${string}`>>(
    terminalId: string,
    type: T,
    payload: EventPayload<T>,
    actor: "user" | "system" = "user",
  ): number {
    return this.deps.store.append({ type, entityId: terminalId, actor, payload });
  }

  private log(message: string): void {
    (this.deps.log ?? console.warn)(message);
  }
}

/** An environment's failure as the command's: typed where the caller can act on it. */
function fromEnvironment(terminalId: string, cause: unknown): never {
  if (cause instanceof StaleIncarnation || cause instanceof ProcessState)
    throw new ShellReplaced(terminalId, cause);
  if (cause instanceof TerminalUnconfirmed) throw new ShellServerUnconfirmed(terminalId, cause);
  if (cause instanceof NoTerminal) throw cause;
  throw new ShellEnvironmentUnavailable(terminalId, cause);
}
