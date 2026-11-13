import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { HookOrigin } from "@bazhen/harness-claude-code";
import type { Store } from "../store/store.ts";

/** How long a SessionStart waits for its agent's start to be recorded before it is judged. */
const START_WAIT_MS = 30_000;

/** One process's parent and command name, as the OS reports them. */
export interface ProcessEntry {
  readonly ppid: number;
  readonly command: string;
}

/** Reads the process table; a process that has gone, or can't be read, is undefined. */
export interface ProcessTable {
  parent(pid: number): Promise<ProcessEntry | undefined>;
}

/**
 * The OS's own `ps`, the same on macOS and Linux. A process that has gone makes `ps` exit 1 with
 * no output; any other failure (no `ps`, a timeout, output it can't read) is logged, since it
 * stops the agent's binding from following a new session, and with it the agent's mail.
 */
export const psTable: ProcessTable = {
  parent: (pid) =>
    new Promise((resolve) => {
      execFile("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { timeout: 2000 }, (err, out) =>
        resolve(psAnswer(pid, err, out)),
      );
    }),
};

/** What one `ps` run says about `pid`, logging any failure but the process having gone. */
export function psAnswer(
  pid: number,
  err: { readonly code?: unknown; readonly message: string } | null,
  out: string,
): ProcessEntry | undefined {
  const entry = parsePs(out);
  const gone = err !== null && err.code === 1 && out.trim() === "";
  if ((err !== null || entry === undefined) && !gone) {
    console.error(
      `bazhen: can't read process ${pid} with ps:`,
      err?.message ?? JSON.stringify(out),
    );
  }
  return err === null ? entry : undefined;
}

/** One line of `ps -o ppid=,comm=`: the parent pid, then the command, which may hold spaces. */
export function parsePs(out: string): ProcessEntry | undefined {
  const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(out);
  if (match === null) return undefined;
  return { ppid: Number(match[1]), command: match[2] ?? "" };
}

/** Shells a harness may run a hook command through; a login shell's name starts with `-`. */
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "ash"]);
const isShell = (command: string) => SHELLS.has(basename(command).replace(/^-/, ""));
/** A hook runs at most a shell or two below the TUI that ran it. */
const MAX_HOPS = 4;

/**
 * Whether the process that ran a hook is the pane's own process (foundation-design §3.1): the
 * nearest ancestor of the hook client that is not a shell, starting from the parent pid the
 * client reports. A nested `claude` the agent started is a nearer ancestor, so its hooks are not
 * the agent's. The pid is the client's word: this tells an honest nested session apart, and is
 * no defence against a process in the agent that lies, which is inside the agent's own trust
 * boundary (§9.4).
 */
export async function ranByPane(
  table: ProcessTable,
  hookParent: number,
  panePid: number,
): Promise<boolean> {
  let pid = hookParent;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (pid === panePid) return true;
    const entry = await table.parent(pid);
    if (entry === undefined || !isShell(entry.command)) return false;
    pid = entry.ppid;
  }
  return false;
}

/**
 * Which Claude Code hooks are the agent's own (foundation-design §3.1, §5.6). The agent is bound
 * to one session at a time, and a SessionStart on a new session, as `/clear` and fork start one,
 * moves the binding when the pane's process ran it (see `ranByPane` for what that does and
 * doesn't prove). Subagents and every other session never count. Anything that can't be checked
 * counts as foreign, so mail waits rather than going astray, and the refusal is logged.
 */
export class SessionBinding {
  private readonly store: Store;
  private readonly table: ProcessTable;
  /** Per agent, the rebind checks still running, so they settle in the order they arrived. */
  private readonly rebinding = new Map<string, Promise<unknown>>();

  private readonly startWaitMs: number;

  constructor(store: Store, table: ProcessTable, startWaitMs = START_WAIT_MS) {
    this.store = store;
    this.table = table;
    this.startWaitMs = startWaitMs;
  }

  /** Whether a hook ran in the agent's bound session, its subagents' included. */
  inSession(agentId: string, origin: HookOrigin): boolean {
    return (
      origin.sessionId !== null && origin.sessionId === this.store.claudeBinding(agentId).sessionId
    );
  }

  /**
   * Whether a hook is the bound session's own, rebinding on its pane's SessionStart of a new one.
   * An owned hook that names where the session keeps its conversation records it: a respawn or
   * relaunch resumes the session only once that file exists.
   */
  async owns(
    agentId: string,
    origin: HookOrigin,
    hook: { readonly sessionStarted: boolean; readonly ppid: number },
  ): Promise<boolean> {
    const owned = await this.ownsSession(agentId, origin, hook);
    if (owned && origin.sessionId !== null && origin.transcriptPath !== null)
      this.store.recordTranscript(agentId, origin.sessionId, origin.transcriptPath);
    return owned;
  }

  private async ownsSession(
    agentId: string,
    origin: HookOrigin,
    hook: { readonly sessionStarted: boolean; readonly ppid: number },
  ): Promise<boolean> {
    const { sessionId } = origin;
    if (origin.subagent || sessionId === null) return false;
    if (sessionId === this.store.claudeBinding(agentId).sessionId) return true;
    if (!hook.sessionStarted) return false;
    // Two quick SessionStarts (two /clears, or a /clear then a /resume) each walk the process
    // table; queued, the later one is checked, and rebinds, last.
    // A check that threw is that hook's failure alone; the next one in line still runs.
    const previous = (this.rebinding.get(agentId) ?? Promise.resolve()).catch(() => {});
    const check = previous.then(() => this.rebindIfPane(agentId, sessionId, hook.ppid));
    this.rebinding.set(agentId, check);
    try {
      return await check;
    } finally {
      if (this.rebinding.get(agentId) === check) this.rebinding.delete(agentId);
    }
  }

  private async rebindIfPane(agentId: string, sessionId: string, ppid: number): Promise<boolean> {
    // A TUI started again can report its new session before its start is recorded, while there
    // is no pane to check it against; the start, once recorded, may have bound it already.
    await this.started(agentId);
    if (sessionId === this.store.claudeBinding(agentId).sessionId) return true;
    const { panePid } = this.store.claudeBinding(agentId);
    if (panePid === null || !(await ranByPane(this.table, ppid, panePid))) {
      console.error(
        `bazhen: agent ${agentId} stays on its session: SessionStart of ${sessionId} wasn't its pane's`,
      );
      return false;
    }
    this.rebind(agentId, sessionId);
    return true;
  }

  /** Resolves once the agent is no longer starting, or after `startWaitMs` if it stays so. */
  private started(agentId: string): Promise<void> {
    const starting = () => this.store.agentTerminal({ agentId })?.state === "starting";
    if (!starting()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, this.startWaitMs);
      const stop = this.store.onCommit(() => {
        if (!starting()) done();
      });
    });
  }

  private rebind(agentId: string, sessionId: string): void {
    this.store.transaction(() => {
      // A repeat of the same SessionStart finds the binding already moved: one event, not two.
      if (this.store.claudeBinding(agentId).sessionId === sessionId) return;
      const environmentId = this.store.agentEnvironment(agentId);
      if (environmentId === undefined) return;
      this.store.append({
        type: "agent.external_ref_updated",
        entityId: agentId,
        actor: "system",
        payload: { externalRef: { environmentId, kind: "claude-session", id: sessionId } },
      });
    });
  }
}
