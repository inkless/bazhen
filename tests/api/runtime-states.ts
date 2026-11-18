import { HealthResponse, ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import type { Daemon } from "./daemon.ts";

export const snapshot = async (daemon: Daemon) =>
  StateSnapshot.parse((await daemon.request("/v1/state")).body);

export async function openShell(daemon: Daemon, key: string): Promise<string> {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: key, cwd: daemon.work },
  });
  return ShellCommandResponse.parse(opened.body).terminalId;
}

const runtimeOf = (command: string | null) =>
  command === null ? "none" : command.startsWith("bazhen terminals attach") ? "holder" : "tmux";

/** Each runtime the daemon reports, as `<kind>: <state>`. */
export async function runtimeStates(daemon: Daemon): Promise<string[]> {
  const { runtimes } = HealthResponse.parse((await daemon.request("/v1/health")).body);
  return runtimes.map((r) => `${r.kind}: ${r.state}`);
}

/** Each terminal's state and the runtime its attach command names, by TerminalId. */
export async function terminals(daemon: Daemon): Promise<Record<string, string>> {
  const { agents, shells } = await snapshot(daemon);
  return Object.fromEntries([
    ...agents.map((a) => [String(a.terminalId), `${a.state} on ${runtimeOf(a.attachCommand)}`]),
    ...shells.map((s) => [s.id, `${s.state} on ${runtimeOf(s.attachCommand)}`]),
  ]);
}
