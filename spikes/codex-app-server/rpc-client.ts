// A probe client that plays Bazhen: spawns `codex app-server proxy --sock <path>` and speaks
// JSON-RPC to the app-server. The proxy is a raw byte pipe to a WebSocket endpoint, so this
// client does the WebSocket handshake and framing itself over the proxy's stdio.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type Pending = { resolve: (m: RpcMessage) => void; method: string };

export class RpcClient {
  readonly name: string;
  readonly messages: { ts: number; dir: "in" | "out"; msg: RpcMessage }[] = [];
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly logFile: string | undefined;
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly waiters: { match: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }[] =
    [];
  private readonly ready: Promise<void>;
  private markReady: () => void = () => {};
  serverRequestHandler: ((m: RpcMessage) => unknown) | undefined;
  exited = false;

  constructor(opts: { name: string; sock: string; env: NodeJS.ProcessEnv; logFile?: string }) {
    this.name = opts.name;
    this.logFile = opts.logFile;
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.proc = spawn("codex", ["app-server", "proxy", "--sock", opts.sock], { env: opts.env });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => this.log({ stderr: chunk.toString() }));
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.log({ exit: code, signal });
    });
    const key = randomBytes(16).toString("base64");
    this.proc.stdin.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  private log(entry: object): void {
    if (this.logFile) {
      appendFileSync(
        this.logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), client: this.name, ...entry })}\n`,
      );
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buffer.subarray(0, end).toString();
      this.buffer = this.buffer.subarray(end + 4);
      if (!head.startsWith("HTTP/1.1 101")) throw new Error(`upgrade failed: ${head}`);
      this.upgraded = true;
      this.markReady();
    }
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === 0x1) this.onMessage(JSON.parse(frame.payload.toString()) as RpcMessage);
      else if (frame.opcode === 0x9) this.writeFrame(0xa, frame.payload);
      else if (frame.opcode === 0x8) this.log({ wsClose: frame.payload.toString("hex") });
    }
  }

  private readFrame(): { opcode: number; payload: Buffer } | undefined {
    const b = this.buffer;
    if (b.length < 2) return undefined;
    const opcode = b[0]! & 0x0f;
    let len = b[1]! & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    if (b.length < offset + len) return undefined;
    const payload = b.subarray(offset, offset + len);
    this.buffer = b.subarray(offset + len);
    return { opcode, payload: Buffer.from(payload) };
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const len = payload.length;
    const header =
      len < 126
        ? Buffer.from([0x80 | opcode, 0x80 | len])
        : len < 65536
          ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), u16(len)])
          : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), u64(len)]);
    const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
    this.proc.stdin.write(Buffer.concat([header, mask, masked]));
  }

  private onMessage(msg: RpcMessage): void {
    this.messages.push({ ts: Date.now(), dir: "in", msg });
    this.log({ dir: "in", msg });
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      pending?.resolve(msg);
    } else if (msg.id !== undefined && msg.method && this.serverRequestHandler) {
      const answer = this.serverRequestHandler(msg);
      if (answer !== undefined) this.respond(msg.id, answer);
    }
    for (const w of [...this.waiters]) {
      if (w.match(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  }

  private sendRaw(msg: RpcMessage): void {
    this.messages.push({ ts: Date.now(), dir: "out", msg });
    this.log({ dir: "out", msg });
    this.writeFrame(0x1, Buffer.from(JSON.stringify(msg)));
  }

  async request(method: string, params: unknown = {}, timeoutMs = 15000): Promise<RpcMessage> {
    await this.ready;
    const id = this.nextId++;
    const reply = new Promise<RpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, method });
      setTimeout(() => reject(new Error(`${this.name}: ${method} timed out`)), timeoutMs).unref();
    });
    this.sendRaw({ id, method, params });
    return reply;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ready;
    this.sendRaw(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.sendRaw({ id, result });
  }

  /** Resolves with the first message (already received or future) that matches. */
  waitFor(match: (m: RpcMessage) => boolean, timeoutMs = 15000, since = 0): Promise<RpcMessage> {
    const seen = this.messages.find((e) => e.dir === "in" && e.ts >= since && match(e.msg));
    if (seen) return Promise.resolve(seen.msg);
    return new Promise((resolve, reject) => {
      this.waiters.push({ match, resolve });
      setTimeout(
        () => reject(new Error(`${this.name}: waitFor timed out`)),
        timeoutMs,
      ).unref();
    });
  }

  received(method: string, since = 0): RpcMessage[] {
    return this.messages
      .filter((e) => e.dir === "in" && e.ts >= since && e.msg.method === method)
      .map((e) => e.msg);
  }

  async initialize(): Promise<RpcMessage> {
    const reply = await this.request("initialize", {
      clientInfo: { name: `bz-probe-${this.name}`, version: "0" },
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized");
    return reply;
  }

  close(): void {
    this.proc.kill("SIGTERM");
  }
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
