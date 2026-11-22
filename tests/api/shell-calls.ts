import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import type { Daemon } from "./daemon.ts";

let keys = 0;

/** Opens a shell, in the daemon's work dir unless `body` says otherwise; its TerminalId. */
export const open = async (on: Daemon, body: Record<string, unknown> = {}) => {
  const res = await on.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: `open-${++keys}`, cwd: on.work, ...body },
  });
  return ShellCommandResponse.parse(res.body).terminalId;
};

export const close = (on: Daemon, terminalId: string, body: Record<string, unknown> = {}) =>
  on.request(`/v1/shells/${terminalId}/close`, {
    method: "POST",
    body: { idempotencyKey: `close-${++keys}`, generation: 0, ...body },
  });

/** The shell as `/v1/state` has it, if it has it. */
export const shellOf = async (on: Daemon, terminalId: string) =>
  StateSnapshot.parse((await on.request("/v1/state")).body).shells.find((s) => s.id === terminalId);
