import type { Shell } from "@bazhen/protocol";

/** The last part of a path, or the path itself at its root. */
const basename = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) || path;

/** A program other than the shell runs in it, as the daemon last saw. */
export const isBusy = (shell: Shell) => shell.foreground !== null;

/** What a tab shows: the name the user gave it, else its directory and what runs there. */
export function shellLabel(shell: Shell): string {
  if (shell.name !== null) return shell.name;
  const dir = basename(shell.cwd);
  return shell.foreground === null ? dir : `${dir} · ${shell.foreground.command}`;
}

/** An agent's linked shells, oldest first, as the snapshot lists them. */
export const linkedShells = (shells: readonly Shell[], agentId: string) =>
  shells.filter((s) => s.linkedAgentId === agentId);

/** How many shells an agent has, and how many run something: the fleet row's chip. */
export function shellCount(shells: readonly Shell[], agentId: string) {
  const linked = linkedShells(shells, agentId);
  return { total: linked.length, busy: linked.filter(isBusy).length };
}

export interface ShellGroup {
  readonly dir: string;
  readonly shells: readonly Shell[];
}

/** Standalone shells by the directory they opened in, directories by name. */
export function standaloneGroups(shells: readonly Shell[]): ShellGroup[] {
  const byDir = new Map<string, Shell[]>();
  for (const shell of shells.filter((s) => s.linkedAgentId === null)) {
    byDir.set(shell.cwd, [...(byDir.get(shell.cwd) ?? []), shell]);
  }
  return [...byDir]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([dir, group]) => ({ dir, shells: group }));
}

/** How long ago `since` was, as a person says it: `40s`, `12m`, `3h`, `2d`. */
export function age(since: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
