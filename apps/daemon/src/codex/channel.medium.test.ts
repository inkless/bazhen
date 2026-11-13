import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { closeFakeServers, tempCodexHome as home, fakeServer } from "../testing/fake-app-server.ts";
import { CodexChannel, type CodexChannelOptions } from "./channel.ts";

afterEach(closeFakeServers);

const notNeeded = () => Promise.reject(new Error("not needed"));
const channelOn = (codexHome: string, opts: Partial<CodexChannelOptions> = {}) =>
  new CodexChannel({
    codexHome,
    startDaemon: notNeeded,
    boundThreads: () => [],
    reconnectMs: 10,
    ...opts,
  });

/** A server that, once a thread is resumed on a second connection, asks for an approval. */
const approvesOnceResumedAgain = (method: string, connection: number) =>
  method === "thread/resume" && connection === 1
    ? { result: {}, andSends: { id: 9, method: "approve" } }
    : { result: "ok" };

/** A server that goes away while a thread is being resumed. */
const dropsOnResume = (method: string) => (method === "thread/resume" ? null : { result: "ok" });

/** A server that can't resume `thr-2`. */
const resumesOnlyThr1 = (method: string, _connection: number, params: unknown) =>
  method === "thread/resume" && JSON.stringify(params).includes("thr-2")
    ? { error: { code: -32600, message: "no such thread" } }
    : { result: "ok" };

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
    await channel.request("thread/start", {});
    connections[0]?.terminate();
    await expect.poll(() => connections.length).toBe(2);
    await expect
      .poll(() => requests.filter(([method]) => method === "thread/resume"))
      .toEqual([
        ["thread/resume", 0, { threadId: "thr-1", excludeTurns: true }],
        ["thread/resume", 1, { threadId: "thr-1", excludeTurns: true }],
      ]);
    channel.close();
  });

  it("connects again by itself when the server goes away, so its next approval still arrives", async () => {
    const { codexHome, socket } = home();
    const { wss } = await fakeServer(socket, codexHome, approvesOnceResumedAgain);
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));
    const heard: unknown[] = [];
    const channel = channelOn(codexHome, {
      boundThreads: () => ["thr-1"],
      listener: {
        request: (method, _params, id) => heard.push([method, id]),
        notification: () => {},
        disconnected: () => heard.push("disconnected"),
        resumed: () => heard.push("resumed"),
      },
    });
    channel.keepConnected();
    await expect.poll(() => connections.length).toBe(1);
    connections[0]?.terminate();
    await expect.poll(() => heard).toContainEqual(["approve", 9]);
    expect(heard).toEqual(["resumed", "disconnected", ["approve", 9], "resumed"]);
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

  it("reports the version of every server it connects to, as one that updated itself", async () => {
    const { codexHome, socket } = home();
    const versions: string[] = [];
    const channel = channelOn(codexHome, { connectedTo: (v) => versions.push(v) });
    expect(channel.version).toBeNull();
    const first = await fakeServer(socket, codexHome, () => ({ result: "ok" }), "0.166.0");
    await channel.request("thread/start", {});
    await first.close();
    await fakeServer(socket, codexHome, () => ({ result: "ok" }), "0.167.2");
    await expect.poll(() => channel.request("thread/start", {})).toBe("ok");
    expect([versions, channel.version]).toEqual([["0.166.0", "0.167.2"], "0.167.2"]);
    channel.close();
  });

  it("tells its listener which threads resumed, leaving out one that couldn't be", async () => {
    const { codexHome, socket } = home();
    await fakeServer(socket, codexHome, resumesOnlyThr1);
    const resumed: unknown[] = [];
    const channel = channelOn(codexHome, {
      boundThreads: () => ["thr-1", "thr-2"],
      listener: {
        request: () => {},
        notification: () => {},
        disconnected: () => {},
        resumed: (threads) => resumed.push(threads),
      },
    });
    await channel.request("thread/start", {});
    expect(resumed).toEqual([["thr-1"]]);
    channel.close();
  });

  it("tells its listener nothing of a connection that dropped while resuming", async () => {
    const { codexHome, socket } = home();
    const { wss } = await fakeServer(socket, codexHome, dropsOnResume);
    const connections: WebSocket[] = [];
    wss.on("connection", (ws) => connections.push(ws));
    const resumed: unknown[] = [];
    const channel = channelOn(codexHome, {
      boundThreads: () => ["thr-1"],
      listener: {
        request: () => {},
        notification: () => {},
        disconnected: () => {},
        resumed: (threads) => resumed.push(threads),
      },
    });
    channel.keepConnected();
    await expect.poll(() => connections.length).toBeGreaterThan(1);
    expect(resumed).toEqual([]);
    channel.close();
  });
});
