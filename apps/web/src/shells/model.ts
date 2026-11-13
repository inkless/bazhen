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
