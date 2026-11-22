import { expect } from "vitest";
import { ShellCommandResponse } from "@bazhen/protocol";
import type { Daemon, IntegratedShell } from "./daemon.ts";
import { closeHoldersUnder } from "../support/holder-close.ts";

/** The line docs/shell-integration.md gives each shell's rc file. */
export const RC_LINE: Record<IntegratedShell, string> = {
  zsh: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/zsh ]] && source "$BAZHEN_SHELL_INTEGRATION/zsh"',
  bash: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/bash ]] && . "$BAZHEN_SHELL_INTEGRATION/bash"',
  fish: 'test -n "$BAZHEN_SHELL_INTEGRATION"; and test -r "$BAZHEN_SHELL_INTEGRATION/fish"; and source "$BAZHEN_SHELL_INTEGRATION/fish"',
};

/**
 * Runs `line` in a new shell, then ends the daemon and every terminal, as a reboot would; runs
 * `before` and starts the daemon again; and restarts the shell, asking for its line typed back.
 * Resolves with the new shell.
 */
export async function retypedAfterReboot(daemon: Daemon, line: string, before = () => {}) {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: `open-${line}`, cwd: daemon.work },
  });
  const { terminalId } = ShellCommandResponse.parse(opened.body);
  const view = await daemon.view(terminalId, "interactive");
  await view.drive();
  await expect
    .poll(() => daemon.terminalScreen(terminalId), { timeout: 20_000 })
    .toContain("[st=0]");
  view.type(`${line}\r`);
  await expect.poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 }).toBe(line);
  view.close();
  await daemon.crash();
  await closeHoldersUnder(daemon.home);
  before();
  await daemon.restart();
  const restarted = await daemon.request(`/v1/shells/${terminalId}/restart`, {
    method: "POST",
    body: { idempotencyKey: `retype-${line}`, generation: 0, retype: true },
  });
  return ShellCommandResponse.parse(restarted.body).terminalId;
}

/**
 * What the daemon logs for a restarted shell whose integration said at its first prompt that it
 * won't take a line typed back.
 */
export const notRetyped = (terminalId: string) =>
  `shell ${terminalId}: last command not retyped: the shell's integration said it can't take a line typed back`;
/**
 * Well inside the 30 s the daemon holds a line for a shell that reports no prompt, so a line
 * dropped only then fails the wait.
 */
export const DECLINED_WITHIN_MS = 15_000;

export const lastLine = (daemon: Daemon, terminalId: string) => async () =>
  (await daemon.terminalScreen(terminalId)).trimEnd().split("\n").at(-1);
