import type { Server } from "node:http";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { newId } from "@bazhen/core";
import { DeviceAuth } from "../auth/devices.ts";
import { DRAIN_PATIENCE, HEARTBEAT_MS } from "../http/heartbeat.ts";
import { Store } from "../store/store.ts";
import { loopbackPairing, serveUpgrades, tempDb } from "../testing/fixtures.ts";
import { ViewRefused, type Attachment, type LeaveReason, type Viewer } from "./hub.ts";
import { ANOTHER_PAGE, streamRoute, type StreamDeps } from "./server.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const terminalId = newId("term");

/** A stream endpoint over a hub that counts joins and never finishes one. */
async function endpoint() {
  let joins = 0;
  const hub = {
    join: () => {
      joins++;
      return new Promise<never>(() => {});
    },
  };
  const served = await serveUpgrades([
    streamRoute({
      protocolId: PROTOCOL,
      hub,
      runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
    }),
  ]);
  server = served.server;
  return { url: `ws://${served.host}/v1/terminals/${terminalId}/stream`, joins: () => joins };
}

/**
 * A stream endpoint, pinging every 100 ms unless `heartbeat` says otherwise, whose views join at
 * once and record how they left.
 */
async function beating(
  heartbeat: Pick<StreamDeps, "heartbeatMs" | "drainPatience"> = {
    heartbeatMs: 100,
    drainPatience: 1,
  },
) {
  const left: (LeaveReason | undefined)[] = [];
  const viewers: Viewer[] = [];
  const attachment = {
    id: newId("att"),
    input: () => {},
    engage: () => {},
    declareEpoch: () => {},
    resize: () => {},
    leave: (reason?: LeaveReason) => left.push(reason),
  } satisfies Attachment;
  const hub: StreamDeps["hub"] = {
    join: (_ref, viewer) => {
      viewers.push(viewer);
      return Promise.resolve(attachment);
    },
  };
  const served = await serveUpgrades([
    streamRoute({
      protocolId: PROTOCOL,
      hub,
      runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
      ...heartbeat,
    }),
  ]);
  server = served.server;
  return {
    url: `ws://${served.host}/v1/terminals/${terminalId}/stream`,
    host: served.host,
    left,
    joins: () => viewers.length,
    /** The view the daemon side holds for the latest join. */
    viewer: () => viewers.at(-1),
  };
}

/**
 * A slow link to `host`: it reads one chunk of the daemon's output, then waits 10 ms, so output
 * queues on the daemon's side and pings wait behind it. Returns the address to connect to.
 */
async function slowLink(host: string): Promise<string> {
  const [address = "", port = ""] = host.split(":");
  const proxy = createServer((client) => {
    const daemon = connect(Number(port), address);
    client.pipe(daemon);
    daemon.on("data", (chunk) => {
      client.write(chunk);
      daemon.pause();
      setTimeout(() => daemon.resume(), 10);
    });
    client.on("close", () => daemon.destroy());
    daemon.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const closing = server;
  closing?.on("close", () => proxy.close());
  const listening = proxy.address();
  if (listening === null || typeof listening === "string") throw new Error("no port");
  return `127.0.0.1:${listening.port}`;
}

/**
 * A view at the daemon's own heartbeat that stops reading, is sent more output than the kernel
 * holds for it, and is then dismissed as the hub dismisses a view that fell behind. Fakes the
 * timers, so the heartbeat and ws's close timer run only as far as `vi.advanceTimersByTimeAsync`
 * takes them; socket I/O stays real.
 */
async function dismissedWhileStalled() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const { url, viewer, left } = await beating({
    heartbeatMs: HEARTBEAT_MS,
    drainPatience: DRAIN_PATIENCE,
  });
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(JSON.stringify(hello));
  await expect.poll(viewer).toBeDefined();
  const view = viewer();
  if (view === undefined) throw new Error("the view never joined");
  ws.pause();
  const texts: unknown[] = [];
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (!binary) texts.push(JSON.parse(data.toString()));
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  view.send(Buffer.alloc(64 << 20));
  view.notify({ type: "ended", reason: "evicted_slow" });
  view.close();
  return { ws, view, texts, closed, left };
}

/** Whether `closed` settles within `ms` of real time. */
const settles = (closed: Promise<void>, ms: number) =>
  Promise.race([closed.then(() => true), sleep(ms).then(() => false)]);

const opened = (ws: WebSocket) => new Promise((resolve) => ws.once("open", resolve));

/** The protocol id the daemon under test speaks. */
const PROTOCOL = "a".repeat(64);

const hello = {
  type: "hello",
  protocolId: PROTOCOL,
  mode: "interactive",
  cols: 80,
  rows: 24,
};

describe("stream endpoint", () => {
  it("joins once, however many hellos arrive while the first join is pending", async () => {
    const { url, joins } = await endpoint();
    const ws = new WebSocket(url);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify(hello));
    // Frames are handled in order: once this one is refused, both hellos have been seen.
    ws.send(JSON.stringify({ type: "unknown" }));
    await new Promise((resolve) => ws.once("close", resolve));
    expect(joins()).toBe(1);
  });

  it("refuses a hello that names an attachment to resume without its token", async () => {
    const { url, joins } = await endpoint();
    const ws = new WebSocket(url);
    await opened(ws);
    const refusal = new Promise((resolve) =>
      ws.once("message", (data: Buffer) => resolve(data.toString())),
    );
    ws.send(JSON.stringify({ ...hello, resumes: { attachmentId: newId("att") } }));
    // Answered with a pong if the hello was taken.
    ws.send(JSON.stringify({ type: "ping" }));
    expect([await refusal, joins()]).toEqual(['{"type":"error","message":"unreadable frame"}', 0]);
  });

  it("tells a page of another build, or from before protocol ids, to reload, and joins it nowhere", async () => {
    const { url, joins } = await endpoint();
    const refusal = async (frame: object) => {
      const ws = new WebSocket(url);
      await opened(ws);
      const answer = new Promise((resolve) =>
        ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString()))),
      );
      ws.send(JSON.stringify(frame));
      // Answered with a pong if the hello was taken.
      ws.send(JSON.stringify({ type: "ping" }));
      return answer;
    };
    const { protocolId: _, ...unnamed } = hello;
    expect([
      await refusal({ ...hello, protocolId: "b".repeat(64) }),
      await refusal({ ...unnamed, protocolVersion: "1.55" }),
      joins(),
    ]).toEqual([
      { type: "error", message: ANOTHER_PAGE },
      { type: "error", message: ANOTHER_PAGE },
      0,
    ]);
  });

  it("tells a view the hub turns away why, in the hub's own words", async () => {
    const hub: StreamDeps["hub"] = {
      join: () => Promise.reject(new ViewRefused("this terminal already has 16 views open")),
    };
    const served = await serveUpgrades([
      streamRoute({
        protocolId: PROTOCOL,
        hub,
        runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
      }),
    ]);
    server = served.server;
    const ws = new WebSocket(`ws://${served.host}/v1/terminals/${terminalId}/stream`);
    await opened(ws);
    const refusal = new Promise((resolve) =>
      ws.once("message", (data: Buffer) => resolve(data.toString())),
    );
    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.send(JSON.stringify(hello));
    expect(await refusal).toBe(
      '{"type":"error","message":"this terminal already has 16 views open"}',
    );
    await closed;
  });

  it("tells a view its attach failed and why, leaving out a secret the failure echoed", async () => {
    const hub: StreamDeps["hub"] = {
      join: () => Promise.reject(new Error('tmux gone; api_key = "s3cr3t"')),
    };
    const served = await serveUpgrades([
      streamRoute({
        protocolId: PROTOCOL,
        hub,
        runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
      }),
    ]);
    server = served.server;
    const ws = new WebSocket(`ws://${served.host}/v1/terminals/${terminalId}/stream`);
    await opened(ws);
    const refusal = new Promise((resolve) =>
      ws.once("message", (data: Buffer) => resolve(data.toString())),
    );
    ws.send(JSON.stringify(hello));
    expect(await refusal).toBe(
      '{"type":"error","message":"attach failed: tmux gone; api_key = [redacted]"}',
    );
  });

  it("says when bytes sent to a view are written, and when they never will be", async () => {
    const { url, viewer, joins, left } = await beating();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(JSON.stringify(hello));
    await expect.poll(joins).toBe(1);
    const written: string[] = [];
    viewer()?.send(Buffer.alloc(1 << 20), () => written.push("while open"));
    await expect.poll(() => written).toEqual(["while open"]);
    ws.terminate();
    await expect.poll(() => left).toEqual(["client_closed"]);
    viewer()?.send(Buffer.alloc(1 << 20), () => written.push("once closed"));
    await expect.poll(() => written).toEqual(["while open", "once closed"]);
  });

  it("says a write is over when its view's socket dies with the write still in flight", async () => {
    const { url, viewer, joins, left } = await beating();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(JSON.stringify(hello));
    await expect.poll(joins).toBe(1);
    ws.pause();
    const written: string[] = [];
    viewer()?.send(Buffer.alloc(64 << 20), () => written.push("over"));
    expect(viewer()?.unsent()).toBeGreaterThan(0);
    ws.terminate();
    await expect.poll(() => left).toEqual(["client_closed"]);
    await expect.poll(() => written).toEqual(["over"]);
  });

  it("tells the hub which paired device a view is on, and none for one that never paired", async () => {
    const store = Store.open(tempDb());
    try {
      const devices = new DeviceAuth(store, { log: () => {} });
      const viewers: Viewer[] = [];
      const hub: StreamDeps["hub"] = {
        join: (_ref, viewer) => {
          viewers.push(viewer);
          return new Promise<never>(() => {});
        },
      };
      const served = await serveUpgrades(
        [
          streamRoute({
            protocolId: PROTOCOL,
            hub,
            runtimeRef: (id) => ({ terminalId, runtime: "fake", locator: { id } }),
          }),
        ],
        { devices, always: false },
      );
      server = served.server;
      const { token } = devices.pair("Phone", false, loopbackPairing);
      const view = async (headers: Record<string, string>) => {
        const ws = new WebSocket(`ws://${served.host}/v1/terminals/${terminalId}/stream`, {
          origin: `http://${served.host}`,
          headers,
        });
        await opened(ws);
        ws.send(JSON.stringify(hello));
        return ws;
      };
      const paired = await view({ cookie: `bazhen_device=${token}` });
      const unpaired = await view({});
      await expect.poll(() => viewers.length).toBe(2);
      expect(viewers.map((v) => v.deviceName)).toEqual(["Phone", undefined]);
      paired.close();
      unpaired.close();
    } finally {
      store.close();
    }
  });

  it("ends a view that stops answering pings as timed out", async () => {
    const { url, left, joins } = await beating();
    const ws = new WebSocket(url, { autoPong: false });
    // Alive until it has joined, then silent, as a phone that sleeps with the terminal open.
    const answer = () => ws.pong();
    ws.on("ping", answer);
    await opened(ws);
    ws.send(JSON.stringify(hello));
    await expect.poll(joins).toBe(1);
    ws.off("ping", answer);
    await expect.poll(() => left, { timeout: 2_000 }).toEqual(["timed_out"]);
  });

  it("keeps a view that answers pings, and answers its own", async () => {
    const { url, left } = await beating();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(JSON.stringify(hello));
    let pings = 0;
    ws.on("ping", () => pings++);
    // Each ping after the first would have ended a view that didn't answer the one before.
    await expect.poll(() => pings, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
    const pong = new Promise((resolve) =>
      ws.once("message", (data: Buffer) => resolve(data.toString())),
    );
    ws.send(JSON.stringify({ type: "ping" }));
    expect([await pong, left]).toEqual(['{"type":"pong"}', []]);
    ws.close();
    await expect.poll(() => left).toEqual(["client_closed"]);
  });

  it("keeps a view whose pongs wait behind its output on a slow link, until it falls silent", async () => {
    const { host, left, viewer } = await beating({ heartbeatMs: 100, drainPatience: 50 });
    const link = await slowLink(host);
    const ws = new WebSocket(`ws://${link}/v1/terminals/${terminalId}/stream`, {
      autoPong: false,
      headers: { host },
    });
    // Each ping is answered as it arrives, behind the output sent before it.
    const answer = () => ws.pong();
    ws.on("ping", answer);
    await opened(ws);
    ws.send(JSON.stringify(hello));
    await expect.poll(viewer).toBeDefined();
    const total = 8 * 1024 * 1024;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    for (let sent = 0; sent < total; sent += chunk.length) viewer()?.send(chunk);
    let received = 0;
    ws.on("message", (data: Buffer) => (received += data.length));
    const started = Date.now();
    await expect.poll(() => received, { timeout: 3_000 }).toBe(total);
    // Draining took many heartbeats, any two of which end a view with nothing queued.
    const drained = [Date.now() - started > 300, [...left]];
    ws.off("ping", answer);
    await expect.poll(() => left, { timeout: 2_000 }).toEqual(["timed_out"]);
    expect(drained).toEqual([true, []]);
  });

  it("stops pinging a view once it has closed, or the hub has dismissed it", async () => {
    const started: unknown[] = [];
    const stopped: unknown[] = [];
    const set = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
      const timer = set(...args);
      started.push(timer);
      return timer;
    });
    const clear = globalThis.clearInterval;
    vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      stopped.push(timer);
      clear(timer);
    });
    const { url, viewer } = await beating();
    const closing = new WebSocket(url);
    await opened(closing);
    closing.close();
    const dismissed = new WebSocket(url);
    await opened(dismissed);
    dismissed.send(JSON.stringify(hello));
    await expect.poll(viewer).toBeDefined();
    viewer()?.close();
    const running = () => started.filter((timer) => !stopped.includes(timer));
    await expect.poll(() => [started.length, running()]).toEqual([2, []]);
  });

  it("tells a dismissed view why, though it reads nothing for as long as the heartbeat waits", async () => {
    const { ws, view, texts, closed } = await dismissedWhileStalled();
    // Longer than ws's default close timeout of 30 s, and short of the heartbeat's allowance.
    await vi.advanceTimersByTimeAsync(DRAIN_PATIENCE * HEARTBEAT_MS);
    const queued = view.unsent();
    ws.resume();
    await expect
      .poll(() => texts.at(-1), {
        timeout: 2_000,
        message: "the view's socket closed before it was told why its stream ended",
      })
      .toEqual({ type: "ended", reason: "evicted_slow" });
    expect([queued > 0, await settles(closed, 1_000)]).toEqual([true, true]);
  });

  it("drops a dismissed view that reads nothing for longer than the heartbeat waits", async () => {
    const { ws, texts, closed, left } = await dismissedWhileStalled();
    await vi.advanceTimersByTimeAsync((DRAIN_PATIENCE + 1) * HEARTBEAT_MS);
    ws.resume();
    expect([await settles(closed, 1_000), texts, left]).toEqual([true, [], ["timed_out"]]);
  });
});
