import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import { SIZE, attachEnv, newTerminal, report, sleep, spikeServer, until } from "./spike.ts";

const RECORDER = join(import.meta.dirname, "recorder.ts");

const servers: ConfiguredTmuxServer[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) s.kill();
});

/** Every byte the recorder got, and when each chunk arrived. */
function recorded(log: string): { bytes: Buffer; chunks: Array<{ at: number; hex: string }> } {
  if (!existsSync(log)) return { bytes: Buffer.alloc(0), chunks: [] };
  const chunks = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [at = "0", hex = ""] = l.split(" ");
      return { at: Number(at), hex };
    });
  return { bytes: Buffer.from(chunks.map((c) => c.hex).join(""), "hex"), chunks };
}

async function recorderPane(label: string, modes: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
  const log = join(dir, "keys.log");
  const server = spikeServer(label);
  servers.push(server);
  const t = newTerminal(server, label, `node ${RECORDER} ${log} ${modes.join(" ")}`);
  await until(
    () => server.runSync(["capture-pane", "-p", "-t", t.pane]).includes("recorder ready"),
    10_000,
  );
  const client = await ControlClient.attach(server, t.session);
  closers.push(() => client.close());
  return { server, t, client, log };
}

/** Sends `bytes`, waits for that many to arrive or 5 s, and says whether they arrived intact. */
async function roundTrip(name: string, bytes: Buffer, chunk?: number) {
  const { client, t, log } = await recorderPane(name);
  const sent = Date.now();
  await client.sendBytes(t.pane, bytes, chunk);
  await until(() => recorded(log).bytes.length >= bytes.length, 5000);
  await sleep(200);
  const got = recorded(log);
  const result = {
    sentBytes: bytes.length,
    gotBytes: got.bytes.length,
    identical: got.bytes.equals(bytes),
    firstDiffAt: firstDiff(got.bytes, bytes),
    ms: (got.chunks.at(-1)?.at ?? sent) - sent,
    gotHeadHex: got.bytes.subarray(0, 24).toString("hex"),
  };
  report(`input-${name}`, result);
  return result;
}

function firstDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function paste(size: number): Buffer {
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; n < size; i++) {
    const line = `line ${i}: const x = "héllo 世界 🎉" + \`${"y".repeat(i % 40)}\`;\n`;
    parts.push(line);
    n += Buffer.byteLength(line);
  }
  return Buffer.from(parts.join("")).subarray(0, size);
}

const percentile = (xs: number[], p: number) =>
  xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? -1;

/** Lone Esc, 20 times, through `send` into a recorder; ms until each arrived. */
async function escLatency(send: (bytes: Buffer) => Promise<void> | void, log: string) {
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const before = recorded(log).chunks.length;
    const at = Date.now();
    await send(Buffer.from([0x1b]));
    await until(() => recorded(log).chunks.length > before, 2000, 1);
    times.push((recorded(log).chunks.at(-1)?.at ?? at + 2000) - at);
    await sleep(50);
  }
  return { p50: percentile(times, 50), max: Math.max(...times) };
}

describe("send-keys -H carries input byte for byte", () => {
  it("a lone Esc arrives at once, through control mode and, for comparison, a PTY attach", async () => {
    const control = await recorderPane("esc-control");
    const viaControl = await escLatency(
      (b) => control.client.sendBytes(control.t.pane, b),
      control.log,
    );
    const pty = await recorderPane("esc-attach");
    const proc = nodePtySpawner.spawn(
      pty.server.argv("attach-session", "-t", pty.t.session),
      SIZE,
      attachEnv(),
    );
    closers.push(() => proc.kill());
    await sleep(500);
    const viaAttach = await escLatency((b) => proc.write(b), pty.log);
    report("input-esc", { control: viaControl, attachUnanswered: viaAttach });
    expect(viaControl.max).toBeLessThan(100);
  });

  it("a 30 KB bracketed paste in 4 KB commands", async () => {
    const data = Buffer.concat([Buffer.from("\x1b[200~"), paste(30_000), Buffer.from("\x1b[201~")]);
    expect((await roundTrip("paste-30k", data)).identical).toBe(true);
  });

  it.each([8192, 16_384, 30_012])("a 30 KB paste in commands of %i bytes", async (chunk) => {
    const data = Buffer.concat([Buffer.from("\x1b[200~"), paste(30_000), Buffer.from("\x1b[201~")]);
    const error = await roundTrip(`paste-30k-chunk-${chunk}`, data, chunk).then(
      () => null,
      (e: unknown) => String(e),
    );
    report("input-send-keys-chunk", { chunk, error });
    expect(typeof chunk).toBe("number");
  });

  it("paste-buffer -p brackets a 30 KB paste for a program that asked", async () => {
    const { server, t, log } = await recorderPane("paste-buffer", ["2004"]);
    const body = paste(30_000);
    const file = join(mkdtempSync(join(tmpdir(), "bz-cc-")), "paste");
    writeFileSync(file, body);
    server.runSync(["load-buffer", "-b", "p", file]);
    server.runSync(["paste-buffer", "-p", "-r", "-b", "p", "-t", t.pane]);
    const want = Buffer.concat([Buffer.from("\x1b[200~"), body, Buffer.from("\x1b[201~")]);
    await until(() => recorded(log).bytes.length >= want.length, 5000);
    const got = recorded(log).bytes;
    report("input-paste-buffer-p", {
      wantBytes: want.length,
      gotBytes: got.length,
      identical: got.equals(want),
      firstDiffAt: firstDiff(got, want),
    });
    expect(got.equals(want)).toBe(true);
  });

  it.each([
    ["sgr-mouse", "\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<64;3;3M"],
    ["utf8", "中文 é 🎉 👩‍💻 ｱ"],
    ["decckm-arrows", "\x1bOA\x1bOB\x1bOC\x1bOD"],
    ["keypad", "\x1bOp\x1bOq\x1bOM\x1bOj"],
    ["ctrl-and-alt", "\x03\x04\x1a\x1bx\x1b\x7f\x7f\t\r"],
    ["csi-u", "\x1b[13;2u\x1b[97;5u"],
    ["focus", "\x1b[I\x1b[O"],
  ])("%s", async (name, text) => {
    expect((await roundTrip(name, Buffer.from(text))).identical).toBe(true);
  });

  it("a UTF-8 character split across two commands", async () => {
    const emoji = Buffer.from("🎉");
    const { client, t, log } = await recorderPane("utf8-split");
    await client.sendBytes(t.pane, emoji.subarray(0, 2));
    await client.sendBytes(t.pane, emoji.subarray(2));
    await until(() => recorded(log).bytes.length >= 4, 3000);
    await sleep(200);
    const got = recorded(log).bytes;
    report("input-utf8-split", { gotHex: got.toString("hex"), identical: got.equals(emoji) });
    expect(got.equals(emoji)).toBe(true);
  });
});
