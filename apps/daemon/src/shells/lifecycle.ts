import {
  newId,
  NoTerminal,
  ProcessState,
  type AgentSessionId,
  type EnvironmentAdapter,
  type RuntimeRef,
  type Size,
  type TerminalId,
} from "@bazhen/core";
import {
  ShellCommandResponse,
  type AgentCommandResponse,
  type CloseAgentRequest,
  type CloseShellRequest,
  type RenameShellRequest,
  type ShellCommand,
  type RestartShellRequest,
  type TuiTheme,
  type UnlinkShellRequest,
  type EventPayload,
  type EventType,
  type OpenShellRequest,
} from "@bazhen/protocol";
import { InvalidDirectory, resolveDirectory } from "../agents/cwd.ts";
import {
  forceable,
  fromEnvironment as failed,
  StaleGeneration,
  StateConflict,
  TerminalReplaced,
} from "../commands.ts";
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

/** Something other than the shell runs in it, so a close must be confirmed (§4.8). */
export class ShellBusy extends Error {
  readonly command: string;

  constructor(subject: string, command: string) {
    super(`${command} is running in ${subject}; close it anyway to end it`);
    this.command = command;
  }
}

/** The agent closed, but shells linked to it could not be; repeating the close finishes them. */
export class ShellsUnsettled extends Error {
  constructor(agentId: string, terminalIds: readonly string[]) {
    super(
      `agent ${agentId} closed, but its shells ${terminalIds.join(", ")} could not be closed; ` +
        "close it again to finish",
    );
  }
}

/** The runtime could not open the shell; it is recorded as failed. */
export class ShellOpenFailed extends Error {
  constructor(terminalId: string, cause: unknown) {
    super(`shell ${terminalId} failed to open`, { cause });
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
 * Shell terminals (foundation-design §4.8): opening, closing, restarting, renaming and unlinking
 * them, closing them with their agent, and closing one at once when its shell exits. Commands on
 * one shell run one at a time, on the agents' queue. Whoever can reach the daemon's API can open
 * and close shells, confirming a busy close included: the browser, the CLI and any process
 * holding BAZHEN_SOCKET, agents among them, as with agents' own commands (§9.4).
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
  open(req: OpenShellRequest): Promise<ShellCommandResponse> {
    const { store, home, queue } = this.deps;
    const request = { command: "open", ...req };
    const opening = async () => {
      const prior = store.replay(req.idempotencyKey, request, (r) => ShellCommandResponse.parse(r));
      if (prior !== undefined) {
        if (store.shell(prior.terminalId)?.state === "failed")
          throw new ShellOpenFailed(prior.terminalId, "an earlier attempt failed");
        return prior;
      }
      const linked = req.linkedAgentId === undefined ? undefined : this.linkable(req.linkedAgentId);
      return this.start(
        {
          cwd: linked?.cwd ?? resolveDirectory(req.cwd ?? "~", home),
          linkedAgentId: linked?.agentId ?? null,
          theme: req.theme,
        },
        (response) => store.answered(req.idempotencyKey, request, response),
      );
    };
    // On the agent's own queue, so a linked shell is opened wholly before or after its agent's
    // close, and that close always sees it.
    return req.linkedAgentId === undefined ? opening() : queue.run(req.linkedAgentId, opening);
  }

  /**
   * Ends a shell and everything in it, asking first (`busy`) when the shell isn't what runs in
   * its foreground. A lost shell is only taken off the list: there is nothing left to end.
   */
  close(terminalId: string, req: CloseShellRequest): Promise<ShellCommandResponse> {
    const force = req.force === true;
    const accepts = ({ state }: ShellTerminal) =>
      state === "closed" ||
      (force ? state === "closing" : shellCommands(state, false).includes("close"));
    return this.command("close", terminalId, req, accepts, async (found) => {
      if (found.state === "closed") return () => ({ terminalId, eventIds: [] });
      if (found.state === "running" && req.confirmBusy !== true) await this.refuseBusy(found);
      const closing =
        found.state === "closing" ? [] : [this.record(terminalId, "terminal.closing", {})];
      if (found.state !== "lost") await this.end(found, force);
      return () => ({
        terminalId,
        eventIds: [...closing, this.record(terminalId, "terminal.closed", { reason: "user" })],
      });
    });
  }

  /**
   * Starts a new shell in a lost one's directory, beside the same agent if that agent can still
   * have one, and takes the lost one off the list. The answer names the new shell.
   */
  restart(terminalId: string, req: RestartShellRequest): Promise<ShellCommandResponse> {
    const { store, queue } = this.deps;
    return this.command("restart", terminalId, req, offers("restart"), async (found) => {
      const theme = req.theme ?? found.theme ?? undefined;
      const request = { command: "restart", terminalId, ...req };
      const replace = async () => {
        const agent = found.linkedAgentId && store.agentTerminal({ agentId: found.linkedAgentId });
        const linkedAgentId = agent && LINKABLE.has(agent.state) ? agent.agentId : null;
        const response = await this.start(
          { cwd: this.restartCwd(found), linkedAgentId, theme, restartOf: found.terminalId },
          (first) => store.answered(req.idempotencyKey, request, first),
        );
        // Taken off the list only once its replacement runs: a restart that fails leaves it lost,
        // to be restarted again.
        store.transaction(() => {
          this.record(terminalId, "terminal.closing", {});
          this.record(terminalId, "terminal.closed", { reason: "restarted" });
        });
        return response;
      };
      // As a linked open: on the agent's own queue, so it can't link to an agent mid-close.
      const response = await (found.linkedAgentId === null
        ? replace()
        : queue.run(found.linkedAgentId, replace));
      return () => response;
    });
  }

  /** Gives a shell a name, or, given null, takes it away. */
  rename(terminalId: string, req: RenameShellRequest): Promise<ShellCommandResponse> {
    return this.command("rename", terminalId, req, offers("rename"), async () => () => ({
      terminalId,
      eventIds: [this.record(terminalId, "terminal.renamed", { name: req.name })],
    }));
  }

  /** Makes a running linked shell standalone, where it runs and in the store (§4.8). */
  unlink(terminalId: string, req: UnlinkShellRequest): Promise<ShellCommandResponse> {
    return this.command("unlink", terminalId, req, offers("unlink"), async (found) => {
      await this.untag(found);
      return () => ({ terminalId, eventIds: [this.record(terminalId, "terminal.unlinked", {})] });
    });
  }

  /**
   * Closes an agent and its linked shells together (§4.8). Unless `confirmBusy`, it is refused
   * while a program other than the shell runs in a shell it would close, naming them. The shells
   * named in `keepShells` are made standalone before the agent closes, so a shell still linked to
   * a closed agent, after a crash or a failure here, was never kept: `settleOrphans` closes it.
   * Every other one is closed once the agent is; any that can't be is reported, and repeating
   * the command finishes them.
   */
  async closeAgent(
    agentId: string,
    req: CloseAgentRequest,
    closeAgent: (req: CloseAgentRequest) => Promise<AgentCommandResponse>,
  ): Promise<AgentCommandResponse> {
    const { store } = this.deps;
    // A repeat replays the agent's first answer; what it asked was checked and done the first
    // time, so only the shells left to close are settled again.
    if (store.recall(req.idempotencyKey) === undefined) {
      const keep = new Set(req.keepShells ?? []);
      const linked = store.linkedShells(agentId);
      for (const id of keep) {
        const shell = linked.find((s) => s.terminalId === id);
        if (shell?.state !== "running")
          throw new StateConflict(`shell ${id}`, `not running beside agent ${agentId}`);
      }
      const closing = linked.filter((s) => !keep.has(s.terminalId));
      if (req.confirmBusy !== true) await this.refuseBusyShells(agentId, closing);
      for (const shell of linked.filter((s) => keep.has(s.terminalId))) await this.keep(shell);
    }
    const response = await closeAgent(req);
    await this.settleWithAgent(agentId);
    return response;
  }

  /**
   * Closes the shells still linked to agents that have closed or failed: those left by a crash or
   * a failure between an agent's close and its shells'. Boot and the server watch run it.
   */
  async settleOrphans(): Promise<void> {
    for (const agentId of this.deps.store.agentsWithOrphanedShells()) {
      if (this.deps.queue.busy(agentId)) continue;
      await this.settleWithAgent(agentId).catch((err: unknown) => this.log(String(err)));
    }
  }

  private async settleWithAgent(agentId: string): Promise<void> {
    const unsettled: string[] = [];
    for (const shell of this.deps.store.linkedShells(agentId)) {
      await this.deps.queue
        .run(shell.terminalId, () => this.closeWithAgent(shell.terminalId))
        .catch((err: unknown) => {
          unsettled.push(shell.terminalId);
          this.log(`shell ${shell.terminalId}: could not close it with its agent: ${String(err)}`);
        });
    }
    if (unsettled.length > 0) throw new ShellsUnsettled(agentId, unsettled);
  }

  /**
   * Makes a shell standalone in the store first, then where it runs. A tag left behind names an
   * agent nothing links it to any more; boot's reconcile drops it.
   */
  private keep(shell: ShellTerminal): Promise<void> {
    return this.deps.queue.run(shell.terminalId, async () => {
      this.record(shell.terminalId, "terminal.unlinked", {});
      await this.untag(shell).catch((err: unknown) =>
        this.log(
          `shell ${shell.terminalId}: kept, but its session still names its agent: ${String(err)}`,
        ),
      );
    });
  }

  /** Refuses an agent's close while a shell it would close runs anything but its shell. */
  private async refuseBusyShells(agentId: string, shells: readonly ShellTerminal[]): Promise<void> {
    const busy: string[] = [];
    for (const shell of shells) {
      if (shell.state !== "running" || shell.runtime === null) continue;
      const command = await this.deps.environment
        .shellBusy(shell.runtime)
        .catch((cause: unknown) => {
          if (cause instanceof ProcessState) return null;
          return fromEnvironment(shell.terminalId, cause);
        });
      if (command !== null) busy.push(command);
    }
    if (busy.length > 0) throw new ShellBusy(`agent ${agentId}'s shells`, busy.join(", "));
  }

  /** Closes a shell its agent's close takes; it was recorded closing before anything ended. */
  private async closeWithAgent(terminalId: string): Promise<void> {
    const found = this.deps.store.shell(terminalId);
    if (found === undefined || !shellCommands(found.state, false).includes("close")) return;
    if (found.state !== "closing") this.record(terminalId, "terminal.closing", {}, "system");
    if (found.state !== "lost") await this.end(found, false);
    this.record(terminalId, "terminal.closed", { reason: "agent_closed" }, "system");
  }

  /**
   * Records a new shell, with `first` run in the same transaction to record what goes with it,
   * then starts it in the environment and records it running, or failed.
   */
  private async start(
    shell: {
      cwd: string;
      linkedAgentId: AgentSessionId | null;
      theme: TuiTheme | undefined;
      restartOf?: TerminalId;
    },
    first: (response: ShellCommandResponse) => void,
  ): Promise<ShellCommandResponse> {
    const { store, environment, size } = this.deps;
    const { cwd, linkedAgentId, theme, restartOf } = shell;
    const terminalId = newId("term");
    const opened = store.transaction(() => {
      const response = {
        terminalId,
        eventIds: [
          this.record(terminalId, "terminal.opened", {
            environmentId: environment.id,
            cwd,
            linkedAgentId,
            ...(theme && { theme }),
            ...(restartOf && { restartOf }),
          }),
        ],
      };
      first(response);
      return response;
    });
    const ref = await environment
      .openShell({
        terminalId,
        cwd,
        size,
        ...(linkedAgentId !== null && { linkedAgentId }),
        ...(theme && { theme }),
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
   * One command on one shell: a repeated key gets the first answer; otherwise the shell must be
   * in a state the command accepts, at the generation it names, if it names one. `act` does the
   * work and returns the last step, recorded with the key's answer.
   */
  private command(
    name: string,
    terminalId: string,
    req: { readonly idempotencyKey: string; readonly generation?: number },
    accepts: (found: ShellTerminal) => boolean,
    act: (found: ShellTerminal) => Promise<() => ShellCommandResponse>,
  ): Promise<ShellCommandResponse> {
    const request = { command: name, terminalId, ...req };
    return this.deps.queue.run(terminalId, async () => {
      const { store } = this.deps;
      const prior = store.replay(req.idempotencyKey, request, (r) => ShellCommandResponse.parse(r));
      if (prior !== undefined) {
        // A restart answers with its new shell, which may have failed to open.
        if (store.shell(prior.terminalId)?.state === "failed")
          throw new ShellOpenFailed(prior.terminalId, "an earlier attempt failed");
        return prior;
      }
      const found = store.shell(terminalId);
      if (found === undefined) throw new UnknownShell(terminalId);
      if (!accepts(found)) throw new StateConflict(`shell ${terminalId}`, found.state);
      if (req.generation !== undefined && found.generation !== req.generation)
        throw new StaleGeneration(`shell ${terminalId}`, found.generation);
      const last = await act(found);
      return store.transaction(() => {
        const response = last();
        store.answered(req.idempotencyKey, request, response);
        return response;
      });
    });
  }

  private async untag(found: ShellTerminal): Promise<void> {
    if (found.runtime === null) throw new NoTerminal();
    await this.deps.environment
      .unlinkShell(found.runtime)
      .catch((cause: unknown) => fromEnvironment(found.terminalId, cause));
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
    if (command !== null) throw new ShellBusy(`shell ${found.terminalId}`, command);
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

  /**
   * Where a restart opens: the directory the shell was last seen in, while it is still a
   * directory, else the one it opened in.
   */
  private restartCwd(found: ShellTerminal): string {
    try {
      return resolveDirectory(found.currentCwd, this.deps.home);
    } catch (err) {
      if (!(err instanceof InvalidDirectory)) throw err;
      return found.cwd;
    }
  }

  /** The agent a shell is to be linked to, and the directory it opens in: the agent's own. */
  private linkable(agentId: string): { agentId: AgentSessionId; cwd: string } {
    const { store } = this.deps;
    const agent = store.agentTerminal({ agentId });
    const launched = store.agentLaunch(agentId);
    if (agent === undefined || launched === undefined) throw new UnknownAgent(agentId);
    if (!LINKABLE.has(agent.state)) throw new StateConflict(`agent ${agentId}`, agent.state);
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

/** Whether a shell, as it is, takes `command`: what the snapshot offers is what is accepted. */
const offers =
  (command: ShellCommand) =>
  ({ state, linkedAgentId }: ShellTerminal) =>
    shellCommands(state, linkedAgentId !== null).includes(command);

/** An environment's failure as a command on the shell's. */
const fromEnvironment = (terminalId: string, cause: unknown): never => {
  // A shell has no exited state to be in, so a process found not as expected is a replaced one.
  if (cause instanceof ProcessState) throw new TerminalReplaced(`shell ${terminalId}`, cause);
  return failed(`shell ${terminalId}`, cause);
};
