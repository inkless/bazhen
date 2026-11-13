// The web dev server as `pnpm dev` runs it, its own config and plugins included, in front of a
// stub daemon: what it refuses must never reach the daemon, over HTTP or as a WebSocket.

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signalGroup, spawnGroup } from "@bazhen/host-guard";

const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
const vite = new URL("../apps/web/node_modules/vite/dist/node/index.js", import.meta.url).href;
const LAN = "192.168.1.20";
const STOP_MS = 5000;

/**
 * Starts the dev server with the repository's own config, but its dependency cache in `cacheDir`:
 * a `pnpm dev` running alongside shares the default one, and would find its optimized
 * dependencies swapped under it.
 */
const START = `
const { createServer } = await import(${JSON.stringify(vite)});
const server = await createServer({
  root: ${JSON.stringify(web)},
  configFile: ${JSON.stringify(join(web, "vite.config.ts"))},
  cacheDir: process.env.BZ_VITE_CACHE,
  clearScreen: false,
  logLevel: "error",
});
await server.listen();
`;

/** What reached the stub daemon behind the dev server's proxy. */
const reached: string[] = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    }),
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A GET's status and body, with the Host header given. */
function fetchAs(port: number, path: string, host: string): Promise<[number, string]> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve([res.statusCode ?? 0, body]));
    });
    req.on("error", () => resolve([0, ""]));
    req.end();
  });
}

const get = async (port: number, path: string, host: string) =>
  (await fetchAs(port, path, host))[0];

/** A WebSocket upgrade: "upgraded", "answered <status>", or "closed" with no answer. */
function upgrade(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": "vite-hmr",
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("response", (res) => {
      res.resume();
      resolve(`answered ${res.statusCode ?? 0}`);
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
}

/**
 * Waits until this dev server, not some other process that took the port, answers this machine
 * with its page. Fails at once, with what it printed, if it exits first.
 */
async function ready(port: number, child: ReturnType<typeof spawnGroup>, stderr: () => string) {
  const exited = once(child, "exit").then(([code]) => {
    throw new Error(`the web dev server exited (${String(code)}): ${stderr()}`);
  });
  const deadline = Date.now() + 30_000;
  const answered = (async () => {
    for (;;) {
      const [status, body] = await fetchAs(port, "/", `127.0.0.1:${port}`);
      if (status === 200 && body.includes("/@vite/client")) return;
      if (Date.now() > deadline) throw new Error(`the web dev server didn't start: ${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  await Promise.race([answered, exited]);
}

describe("the web dev server", () => {
  const daemon = createServer((req, res) => {
    reached.push(`GET ${req.url ?? ""}`);
    res.end("{}");
  });
  daemon.on("upgrade", (req, socket) => {
    reached.push(`upgrade ${req.url ?? ""}`);
    socket.destroy();
  });
  const cache = mkdtempSync(join(tmpdir(), "bz-vite-cache-"));
  let port = 0;
  let child: ReturnType<typeof spawnGroup> | undefined;

  beforeAll(async () => {
    const daemonPort = await listen(daemon);
    port = await freePort();
    let stderr = "";
    child = spawnGroup(process.execPath, ["--input-type=module", "-e", START], {
      cwd: web,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // As `pnpm dev` runs it, not as the test runner it was started from.
        NODE_ENV: "development",
        BZ_VITE_CACHE: cache,
        BAZHEN_PORT: String(daemonPort),
        BAZHEN_WEB_PORT: String(port),
      },
    });
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    await ready(port, child, () => stderr);
  }, 40_000);

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null) {
      const exited = once(child, "exit");
      signalGroup(child, "SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_MS)),
      ]);
      if (!stopped) signalGroup(child, "SIGKILL");
    }
    await new Promise((resolve) => daemon.close(resolve));
    rmSync(cache, { recursive: true, force: true });
  }, STOP_MS + 5000);

  it("refuses another host's requests before they reach the source or the daemon", async () => {
    const statuses = [await get(port, "/", `${LAN}:${port}`)];
    statuses.push(await get(port, "/v1/health", `${LAN}:${port}`), await get(port, "/@fs/", LAN));
    // This machine's own request, after them, is the one the daemon sees.
    statuses.push(await get(port, "/v1/health", `127.0.0.1:${port}`));
    expect({ statuses, reached }).toEqual({
      statuses: [403, 403, 403, 200],
      reached: ["GET /v1/health"],
    });
  });

  it("refuses another host's WebSockets, the HMR socket's included, and proxies none", async () => {
    reached.splice(0);
    const refused = [
      await upgrade(port, "/v1/events?lan", `${LAN}:${port}`),
      await upgrade(port, "/?lan", `${LAN}:${port}`),
    ];
    await upgrade(port, "/v1/events?own", `127.0.0.1:${port}`);
    await expect.poll(() => reached.includes("upgrade /v1/events?own")).toBe(true);
    // A refused upgrade the proxy still opened could land after this machine's own; it is given
    // a moment to, since what is checked is that none arrives at all.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect({ refused, reached }).toEqual({
      refused: ["closed", "closed"],
      reached: ["upgrade /v1/events?own"],
    });
  });
});
