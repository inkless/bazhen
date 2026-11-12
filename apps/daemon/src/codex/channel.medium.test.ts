import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { closeFakeServers, tempCodexHome as home, fakeServer } from "../testing/fake-app-server.ts";
import { CodexChannel, type CodexChannelOptions } from "./channel.ts";

afterEach(closeFakeServers);

const notNeeded = () => Promise.reject(new Error("not needed"));
const channelOn = (codexHome: string, opts: Partial<CodexChannelOptions> = {}) =>
  new CodexChannel({ codexHome, startDaemon: notNeeded, boundThreads: () => [], ...opts });

const DRAINING = {
  error: { code: -32600, message: "Server is draining", data: { reason: "serverShuttingDown" } },
};

describe("Codex channel", () => {
  it("starts Codex's own daemon when nothing listens, then connects to it", async () => {
    const { codexHome, socket } = home();
    let started = 0;
    const channel = channelOn(codexHome, {
      startDaemon: async () => {
        started++;
        await fakeServer(socket, codexHome, () => ({ result: "ok" }));
      },
    });
    expect([await channel.request("thread/start", {}), started]).toEqual(["ok", 1]);
    channel.close();
  });

  it("connects again on the next request after the connection ends", async () => {
    const { codexHome, socket } = home();
    const connections: WebSocket[] = [];
    const { wss } = await fakeServer(socket, codexHome, () => ({ result: "ok" }));
    wss.on("connection", (ws) => connections.push(ws));
    const channel = channelOn(codexHome);
    await channel.request("thread/start", {});
    connections[0]?.terminate();
    await expect.poll(() => channel.request("thread/start", {})).toBe("ok");
    expect(connections.length).toBeGreaterThan(1);
    channel.close();
  });

  it("resumes every bound thread on each new connection", async () => {
    const { codexHome, socket } = home();
    const requests: [string, number, unknown][] = [];
    const connections: WebSocket[] = [];
    const { wss } = await fakeServer(socket, codexHome, (method, connection, params) => {
      requests.push([method, connection, params]);
      return { result: "ok" };
    });
    wss.on("connection", (ws) => connections.push(ws));
    const channel = channelOn(codexHome, { boundThreads: () => ["thr-1"] });
    await channel.resume();
    connections[0]?.terminate();
    await expect.poll(() => channel.request("thread/start", {})).toBe("ok");
    expect(requests.filter(([method]) => method === "thread/resume")).toEqual([
      ["thread/resume", 0, { threadId: "thr-1", excludeTurns: true }],
      ["thread/resume", 1, { threadId: "thr-1", excludeTurns: true }],
    ]);
    channel.close();
  });

  it("sends a request refused by a draining server to the server that comes next", async () => {
    const { codexHome, socket } = home();
    const answers = [DRAINING, { result: "launched" }];
    const { wss } = await fakeServer(
      socket,
      codexHome,
      (_method, connection) => answers[connection],
    );
    // The draining server exits a moment after refusing.
    wss.once("connection", (ws) => setTimeout(() => ws.terminate(), 50));
    const channel = channelOn(codexHome);
    expect(await channel.request("thread/start", {})).toBe("launched");
    channel.close();
  });

  it("reports a server that came back on a different version", async () => {
    const { codexHome, socket } = home();
    const logged: string[] = [];
    const channel = channelOn(codexHome, { log: (m) => logged.push(m) });
    const first = await fakeServer(socket, codexHome, () => ({ result: "ok" }), "0.166.0");
    await channel.request("thread/start", {});
    await first.close();
    await fakeServer(socket, codexHome, () => ({ result: "ok" }), "0.167.2");
    await expect.poll(() => channel.request("thread/start", {})).toBe("ok");
    expect(logged).toEqual([expect.stringContaining("from 0.166.0 to 0.167.2")]);
    channel.close();
  });
});
