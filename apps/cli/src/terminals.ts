import type { DoctorResponse } from "@bazhen/protocol";

type Terminals = NonNullable<DoctorResponse["terminals"]>;

/** What `bazhen doctor` says about the terminal budget and the machine's PTYs behind it. */
export function terminalLines({ open, max, host }: Terminals): string[] {
  const lines = [`terminals: ${open} open, at most ${max} (terminals.max_open)`];
  if (open >= max) lines.push("  new agents and shells are refused until one is closed");
  if (host === null) lines.push("  machine PTYs: can't be counted here");
  else if (host.exact) lines.push(`  machine PTYs: ${host.used} of ${host.max} in use`);
  else
    lines.push(
      `  machine PTYs: as many as ${host.used} of ${host.max} in use (the count includes closed ones)`,
    );
  return lines;
}
