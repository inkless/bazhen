// What the containment suite reads of a holder's scope, from the kernel and the user manager. It
// reads only: the scope is made by `spawnHolder`'s launch, and only the kernel kills inside it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Containment, probeContainment, type TerminalCaps } from "@bazhen/host-guard";

export type { Containment };
export type Scoped = Extract<Containment, { kind: "scoped" }>;

/** The caps the suite probes with: small, since every terminal it starts is small. */
export const SUITE_CAPS: TerminalCaps = { terminal: "256M", total: "1G" };

/** The containment this runner gives, as the daemon would decide it with `SUITE_CAPS`. */
export const probeSuite = () => probeContainment(SUITE_CAPS);

/** Containment as `scoped` decides it, but with each terminal capped at `terminal`. */
export const cappedAt = (scoped: Scoped, terminal: string): Scoped => ({
  ...scoped,
  caps: { ...scoped.caps, terminal },
});

const read = (path: string) => readFileSync(path, "utf8").trim();

/** The cgroup `pid` runs in, as `/proc/<pid>/cgroup` names it. */
export function cgroupOfPid(pid: number): string {
  const cgroup = /^0::(\/\S*)$/m.exec(read(`/proc/${pid}/cgroup`))?.[1];
  if (cgroup === undefined) throw new Error(`pid ${pid} is in no unified cgroup`);
  return cgroup;
}

/** A cgroup's `memory.max`, as the kernel shows it. */
export const memoryMax = (cgroup: string) => read(`/sys/fs/cgroup${cgroup}/memory.max`);

/** The OOM kills a cgroup has counted. */
export const oomKills = (cgroup: string) =>
  Number(/^oom_kill (\d+)$/m.exec(read(`/sys/fs/cgroup${cgroup}/memory.events`))?.[1] ?? 0);

/** A property of the user manager's unit for a cgroup's last part. */
export function unitProperty(cgroup: string, property: string): string {
  const unit = cgroup.split("/").at(-1) ?? "";
  return execFileSync("systemctl", ["--user", "show", "--value", "-p", property, unit], {
    encoding: "utf8",
  }).trim();
}
