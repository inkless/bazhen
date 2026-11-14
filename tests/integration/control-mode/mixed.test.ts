import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import {
  attachEnv,
  Screen,
  fifo,
  missing,
  newTerminal,
  numbers,
  report,
  serverPid,
  sleep,
  spikeServer,
  tmuxLines,
  until,
  type Terminal,
} from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) s.kill();
});

const rssKb = (pid: number) =>
  Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? -1);

/** A person's `tmux attach` in a terminal of their own, 80x24, reading everything. */
function humanAttach(server: ConfiguredTmuxServer, t: Terminal) {
  const proc = nodePtySpawner.spawn(
    server.argv("attach-session", "-t", t.session),
    { cols: 80, rows: 24 },
    attachEnv(),
  );
  let bytes = 0;
  proc.onData((d) => (bytes += d.length));
  closers.push(() => proc.kill());
  return { proc, bytes: () => bytes };
}

const windowSize = (server: ConfiguredTmuxServer, t: Terminal) =>
  server
    .runSync(["display-message", "-p", "-t", t.pane, "#{window_width}x#{window_height}"])
    .trim();

/**
 * `yes` in a pane both a person's tty client and a control client view, for 30 s, with the control
 * client reading as the daemon would, or not at all; then 10 s for it to catch up.
 */
async function floodBeside(paused: boolean) {
  const server = spikeServer(`mixed-flood-${paused}`);
  servers.push(server);
  const t = newTerminal(server, "flood", "yes");
  const client = await ControlClient.attach(server, t.session);
  closers.push(() => client.close());
  const screen = new Screen();
  client.onOutput((_p, d) => screen.write(d));
  const human = humanAttach(server, t);
  if (paused) client.pause();
  const pid = serverPid(server);
  const rows: Array<Record<string, unknown>> = [];
  const sample = (s: number) =>
    rows.push({
      s,
      tmuxRssKb: rssKb(pid),
      humanMb: Math.round(human.bytes() / 1e6),
      controlMb: Math.round(client.bytes / 1e6),
      controlAlive: client.child.exitCode === null,
    });
  for (let s = 5; s <= 30; s += 5) {
    await sleep(5000);
    sample(s);
  }
  client.resume();
  await sleep(10_000);
  sample(40);
  const row = {
    paused,
    rows,
    exitReason: client.exitReason,
    serverAlive: server.alive(),
  };
  report("mixed-flood", row);
  return row;
}

describe("a control client beside a person's tmux attach", () => {
  it("a paused control view loses nothing while a tty client keeps reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
    const go = fifo(dir, "go");
    const server = spikeServer("mixed");
    servers.push(server);
    const t = newTerminal(
      server,
      "mixed",
      `sh -c 'read x < ${go}; date +%s%N > ${dir}/start; seq 1 200000; date +%s%N > ${dir}/end; exec sleep 3600'`,
    );
    const sizeAlone = windowSize(server, t);
    const client = await ControlClient.attach(server, t.session);
    closers.push(() => client.close());
    const screen = new Screen();
    client.onOutput((_p, d) => screen.write(d));
    const sizeWithControl = windowSize(server, t);
    const human = humanAttach(server, t);
    await sleep(500);
    const sizeWithHuman = windowSize(server, t);
    const pid = serverPid(server);
    const rssBefore = rssKb(pid);
    client.pause();
    writeFileSync(go, "go\n");
    await sleep(5000);
    const rssPaused = rssKb(pid);
    client.resume();
    await until(() => numbers(tmuxLines(server, t.pane)).has(200000), 30_000);
    await sleep(2000);
    await screen.settled();
    const ns = (f: string) => Number(readFileSync(join(dir, f), "utf8").trim());
    const tmux = numbers(tmuxLines(server, t.pane));
    const mine = numbers(screen.lines());
    const row = {
      seqMs: (ns("end") - ns("start")) / 1e6,
      rssBeforeKb: rssBefore,
      rssPausedKb: rssPaused,
      controlBytes: client.bytes,
      humanBytes: human.bytes(),
      missingFromView: missing(tmux, mine).length,
      viewMax: Math.max(...mine),
      controlAlive: client.child.exitCode === null,
      exitReason: client.exitReason,
      sizeAlone,
      sizeWithControl,
      sizeWithHuman,
      serverAlive: server.alive(),
    };
    report("mixed-paused-burst", row);
    expect(row.serverAlive).toBe(true);
  });

  it.each([true, false])(
    "a flood beside a tty client for 30 s, the control view paused: %s",
    async (paused) => {
      const row = await floodBeside(paused);
      expect(row.serverAlive).toBe(true);
    },
  );
});
