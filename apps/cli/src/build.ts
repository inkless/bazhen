import { ANOTHER_BUILD } from "@bazhen/daemon/client";

/** As much of a protocol id as a person compares by eye. */
export const shortId = (id: string): string => id.slice(0, 12);

/**
 * What `bazhen status` and `doctor` first say of the daemon: its version and protocol, and, when
 * that protocol isn't this CLI's (`ours`), that the daemon is another build to restart.
 */
export function buildLines(
  daemon: { readonly appVersion: string; readonly protocolId: string },
  ours: string,
  state = "",
): string[] {
  const head = `bazhen ${daemon.appVersion} (protocol ${shortId(daemon.protocolId)})${state}`;
  if (daemon.protocolId === ours) return [head];
  return [head, `  warning: this CLI speaks protocol ${shortId(ours)}; ${ANOTHER_BUILD}`];
}
