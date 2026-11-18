import { join } from "node:path";

/** The runtimes the run starts a daemon on, one Playwright project each, named for it. */
export const RUNTIMES = ["tmux", "holder"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const isRuntime = (name: string): name is Runtime =>
  (RUNTIMES as readonly string[]).includes(name);

/** The specs that make real terminals but read nothing of tmux, so they run on holders too. */
export const RUNTIME_AGNOSTIC_SPECS = [
  "dashboard.spec.ts",
  "inbox.spec.ts",
  "layout.spec.ts",
  "shells.spec.ts",
  "tasks.spec.ts",
  "terminal.spec.ts",
];

export interface E2eDaemon {
  readonly runtime: Runtime;
  readonly home: string;
  readonly daemonPort: number;
  readonly webPort: number;
}

/** The run's own directory: each daemon's home, and the agents' work directory, are under it. */
export function runRoot(): string {
  const root = process.env["BZ_E2E_ROOT"];
  if (root === undefined) throw new Error("BZ_E2E_ROOT is unset");
  return root;
}

export const daemonHome = (runtime: Runtime) => join(runRoot(), runtime);

export const portVariable = (runtime: Runtime, kind: "DAEMON" | "WEB") =>
  `BZ_E2E_${runtime.toUpperCase()}_${kind}_PORT`;

function port(runtime: Runtime, kind: "DAEMON" | "WEB"): number {
  const name = portVariable(runtime, kind);
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is unset`);
  return value;
}

/** The daemon of `runtime`, as the config chose its home and ports for the run. */
export const e2eDaemon = (runtime: Runtime): E2eDaemon => ({
  runtime,
  home: daemonHome(runtime),
  daemonPort: port(runtime, "DAEMON"),
  webPort: port(runtime, "WEB"),
});

export const e2eDaemons = () => RUNTIMES.map(e2eDaemon);

export const webOrigin = (daemon: E2eDaemon) => `http://127.0.0.1:${daemon.webPort}`;
