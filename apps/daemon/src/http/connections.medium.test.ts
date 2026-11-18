import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "bz-connections-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CONNECTIONS = JSON.stringify(fileURLToPath(new URL("connections.ts", import.meta.url)));
const DAEMON = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Runs, in a Node process of its own, an HTTP server on a Unix socket whose upgrade listener
 * holds the socket and adds no listener of its own, with `hear` applied to the server. A client
 * asks to upgrade, and once the server has written to it, resets with those bytes unread. How
 * the process ended: an unheard error ends the process it happens in, so it can't be this one.
 */
function resetHeldUpgrade(
  hear: string,
): Promise<{ code: number | null; out: string; err: string }> {
  const caller = `
    import { createServer } from "node:http";
    import { connect } from "node:net";
    import { hearConnections } from ${CONNECTIONS};
    const [socket] = process.argv.slice(1);
    const server = ${hear}(createServer());
    let client;
    server.on("upgrade", (_req, held) => {
      held.write(Buffer.alloc(64 * 1024), () => client.destroy());
      held.resume();
    });
    server.listen(socket, () => {
      client = connect(socket);
      client.pause();
      client.write("GET / HTTP/1.1\\r\\nHost: d\\r\\nConnection: Upgrade\\r\\nUpgrade: x\\r\\n\\r\\n");
    });
    setTimeout(() => { console.log("lived"); process.exit(0); }, 500);
  `;
  return runModule(caller, join(dir, `held-${hear.length}.sock`));
}

/**
 * How `caller`, run as a module in a Node process of its own from the daemon's package, so that
 * it finds the daemon's dependencies, ended: its exit code, and what it printed.
 */
const runModule = (caller: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", caller, ...args],
      { cwd: DAEMON, encoding: "utf8" },
      (error, out, err) => done({ code: error === null ? 0 : Number(error.code), out, err }),
    );
  });

/**
 * Runs, in a Node process of its own, an HTTP server on a Unix socket whose upgrades `wss`
 * serves with no listener of the route's own, and a client that sends a text frame of 4 KiB to
 * a server that takes 1 KiB. How the process ended.
 */
function sendTooLarge(wss: string): Promise<{ code: number | null; out: string; err: string }> {
  const caller = `
    import { createServer } from "node:http";
    import { WebSocket, WebSocketServer } from "ws";
    import { heardWebSockets } from ${CONNECTIONS};
    const [socket] = process.argv.slice(1);
    const wss = ${wss};
    const server = createServer();
    server.on("upgrade", (req, held, head) => wss.handleUpgrade(req, held, head, () => {}));
    server.listen(socket, () => {
      const client = new WebSocket("ws+unix://" + socket + ":/");
      client.on("error", () => {});
      client.on("open", () => client.send("x".repeat(4096)));
      client.on("close", (code) => console.log("closed", code));
    });
    setTimeout(() => { console.log("lived"); process.exit(0); }, 500);
  `;
  return runModule(caller, join(dir, `frame-${wss.length}.sock`));
}

describe("a server whose connections are heard from the moment they are accepted", () => {
  it("lives through a peer that resets an upgraded socket nothing else hears", async () => {
    const ran = await resetHeldUpgrade("hearConnections");
    expect(ran).toMatchObject({ code: 0, out: "lived\n" });
  });

  it("ends by the same reset when its connections aren't heard, which is what hearing prevents", async () => {
    const ran = await resetHeldUpgrade("((s) => s)");
    expect(ran.code).toBe(1);
    // The trace a daemon in CI died by: a read the peer reset, on a socket nothing heard.
    expect(ran.err).toMatch(/read ECONNRESET\n\s+at Pipe\.onStreamRead/);
  });
});

describe("WebSockets served through heardWebSockets", () => {
  it("close a socket whose frame ws refuses, and end nothing else", async () => {
    const ran = await sendTooLarge("heardWebSockets(1024)");
    expect(ran).toMatchObject({ code: 0, out: "closed 1009\nlived\n" });
  });

  it("end the process on that frame when unheard, which is what hearing prevents", async () => {
    const ran = await sendTooLarge("new WebSocketServer({ noServer: true, maxPayload: 1024 })");
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/RangeError: Max payload size exceeded/);
  });
});
