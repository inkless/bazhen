import { existsSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

export const homeOf = (runtime: Runtime) => join(runRoot(), runtime);

export const portVariable = (runtime: Runtime, kind: "DAEMON" | "WEB") =>
  `BZ_E2E_${runtime.toUpperCase()}_${kind}_PORT`;

function port(runtime: Runtime, kind: "DAEMON" | "WEB"): number {
  const name = portVariable(runtime, kind);
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is unset`);
  return value;
}

/** The daemon of `runtime`, as the config chose its home and ports for the run. */
const e2eDaemon = (runtime: Runtime): E2eDaemon => ({
  runtime,
  home: homeOf(runtime),
  daemonPort: port(runtime, "DAEMON"),
  webPort: port(runtime, "WEB"),
});

export const e2eDaemons = () => RUNTIMES.map(e2eDaemon);

export const webOrigin = (daemon: E2eDaemon) => `http://127.0.0.1:${daemon.webPort}`;

const STOP_MS = 15_000;

const socketOf = (home: string) => join(home, "run", "bazhen.sock");

/** One request to the daemon at `home` over its socket, as the CLI makes it; answers the JSON body. */
export function socketCall(
  home: string,
  method: string,
  path: string,
  body?: object,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socketOf(home),
        method,
        path,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) reject(new Error(`${path}: ${res.statusCode} ${text}`));
          else resolve(JSON.parse(text));
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Whether anything accepts a connection on the daemon's socket under `home`. */
function answers(home: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socketOf(home));
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", () => resolve(false));
  });
}

/**
 * Stops the daemon at `home` as `bazhen stop` does, over its socket, and resolves once it
 * no longer answers. Playwright runs global teardown before it stops its web servers, and a daemon
 * left running would go on writing into the home teardown removes.
 */
export async function stopDaemon(home: string): Promise<void> {
  if (!existsSync(socketOf(home)) || !(await answers(home))) return;
  await socketCall(home, "POST", "/v1/daemon/stop");
  // A daemon with agents still running takes a while to stop: a timeout here should mean a hang.
  for (let waited = 0; waited < STOP_MS; waited += 100) {
    if (!(await answers(home))) return;
    await delay(100);
  }
  throw new Error(
    `the daemon at ${home} still answers ${STOP_MS / 1000} s after it was asked to stop`,
  );
}
