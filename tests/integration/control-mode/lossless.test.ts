import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import {
  HISTORY,
  Screen,
  cpuSeconds,
  fifo,
  missing,
  newTerminal,
  numbers,
  report,
  sleep,
  spikeServer,
  tmuxLines,
  until,
  type Terminal,
} from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const clients: ControlClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) s.kill();
});

const MODES = "#{cursor_x} #{cursor_y}";

/** A client whose screen starts from attach's seam and then follows the pane's output. */
async function view(server: ConfiguredTmuxServer, t: Terminal) {
  const client = await ControlClient.attach(server, t.session);
  clients.push(client);
  const screen = new Screen();
  const live: Buffer[] = [];
  client.onOutput((pane, data) => {
    if (pane === t.pane) live.push(data);
  });
  const { modes, capture } = await client.snapshot(t.pane, MODES);
  const [x = 0, y = 0] = modes.split(" ").map(Number);
  screen.write(`${capture.replace(/\n$/, "").split("\n").join("\r\n")}\x1b[${y + 1};${x + 1}H`);
  for (const chunk of live.splice(0)) screen.write(chunk);
  client.onOutput((pane, data) => {
    if (pane === t.pane) screen.write(data);
  });
  return { client, screen, captureMax: Math.max(0, ...numbers(capture.split("\n"))) };
}

function compare(
  name: string,
  server: ConfiguredTmuxServer,
  t: Terminal,
  screen: Screen,
  extra = {},
) {
  const tmux = numbers(tmuxLines(server, t.pane));
  const lines = screen.lines();
  const mine = numbers(lines);
  const numbered = lines.filter((l) => /^\d+$/.test(l.trim())).length;
  const result = {
    tmuxCount: tmux.size,
    tmuxMin: Math.min(...tmux),
    tmuxMax: Math.max(...tmux),
    viewCount: mine.size,
    viewMin: Math.min(...mine),
    viewMax: Math.max(...mine),
    missingFromView: missing(tmux, mine).length,
    extraInView: missing(mine, tmux).length,
    extraNotOlder: missing(mine, tmux).filter((n) => n >= Math.min(...tmux)).length,
    duplicateLines: numbered - mine.size,
    ...extra,
  };
  report(name, result);
  return result;
}

const work = () => mkdtempSync(join(tmpdir(), "bz-cc-"));

/** seq 1 200000 into a view, which stops reading for its first 2 s when `paused`. */
async function burst(paused: boolean) {
  const dir = work();
  const go = fifo(dir, "go");
  const server = spikeServer(`pause-${paused}`);
  servers.push(server);
  const t = newTerminal(
    server,
    `pause${paused}`,
    `sh -c 'read x < ${go}; date +%s%N > ${dir}/start; seq 1 200000; date +%s%N > ${dir}/end; exec sleep 3600'`,
  );
  const { client, screen } = await view(server, t);
  if (paused) client.pause();
  writeFileSync(go, "go\n");
  if (paused) {
    await sleep(2000);
    client.resume();
  }
  await until(() => numbers(tmuxLines(server, t.pane)).has(200000), 60_000);
  await sleep(1000);
  await screen.settled();
  const ns = (f: string) => Number(readFileSync(join(dir, f), "utf8").trim());
  const seqMs = (ns("end") - ns("start")) / 1e6;
  return compare(`burst-${paused ? "paused-2s" : "reading"}`, server, t, screen, {
    seqMs,
    bytes: client.bytes,
  });
}

/**
 * A control client, the only one on its session, that stops reading as soon as it attaches while
 * `yes` runs: does tmux stop reading the pane (the program holds), or buffer for the client?
 */
async function stall(trial: number) {
  const server = spikeServer(`stall-${trial}`);
  servers.push(server);
  const t = newTerminal(server, "stall", "yes");
  const client = await ControlClient.attach(server, t.session);
  clients.push(client);
  client.pause();
  const bytesAtPause = client.bytes;
  const pid = Number(server.runSync(["display-message", "-p", "-t", t.pane, "#{pane_pid}"]));
  const tmuxPid = Number(server.runSync(["display-message", "-p", "#{pid}"]));
  const rss = () =>
    Number(readFileSync(`/proc/${tmuxPid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1]);
  await sleep(10_000);
  const row = {
    trial,
    bytesAtPause,
    yesCpuS10: cpuSeconds(pid),
    tmuxRssKb10: rss(),
    serverAlive: server.alive(),
    exitReason: client.exitReason,
  };
  report("stalled-reader-trial", row);
  return row;
}

describe("control mode keeps every line tmux keeps", () => {
  it("a live view of seq 1 12000 holds what tmux holds", async () => {
    const dir = work();
    const go = fifo(dir, "go");
    const server = spikeServer("live");
    servers.push(server);
    const t = newTerminal(server, "live", `sh -c 'read x < ${go}; seq 1 12000; exec sleep 3600'`);
    const { client, screen } = await view(server, t);
    writeFileSync(go, "go\n");
    await until(() => numbers(tmuxLines(server, t.pane)).has(12000), 20_000);
    await sleep(500);
    await screen.settled();
    const r = compare("lossless-live", server, t, screen, {
      bytes: client.bytes,
      history: HISTORY,
    });
    expect(r.missingFromView).toBe(0);
  });

  it("a view opened after the burst holds what tmux holds", async () => {
    const server = spikeServer("late");
    servers.push(server);
    const t = newTerminal(server, "late", "sh -c 'seq 1 12000; exec sleep 3600'");
    await until(() => numbers(tmuxLines(server, t.pane)).has(12000), 20_000);
    const { screen } = await view(server, t);
    await sleep(300);
    await screen.settled();
    const r = compare("lossless-late", server, t, screen);
    expect(r.missingFromView).toBe(0);
  });

  it("a view opened mid-burst joins at the seam with no gap and no repeat", async () => {
    const dir = work();
    const go = fifo(dir, "go");
    const server = spikeServer("seam");
    servers.push(server);
    const t = newTerminal(
      server,
      "seam",
      `sh -c 'read x < ${go}; i=0; while [ $i -lt 40 ]; do seq $((i*1000+1)) $((i*1000+1000)); i=$((i+1)); sleep 0.01; done; exec sleep 3600'`,
    );
    writeFileSync(go, "go\n");
    await sleep(150);
    const { screen, captureMax } = await view(server, t);
    await until(() => numbers(tmuxLines(server, t.pane)).has(40000), 30_000);
    await sleep(500);
    await screen.settled();
    const r = compare("seam-mid-burst", server, t, screen, { captureMax });
    expect(captureMax).toBeGreaterThan(0);
    expect(captureMax).toBeLessThan(40000);
    expect(r).toMatchObject({ missingFromView: 0, extraNotOlder: 0, duplicateLines: 0 });
  });

  it("a view that reads throughout gets all of seq 1 200000", async () => {
    const r = await burst(false);
    expect(r.missingFromView).toBe(0);
  });

  it("a view that stops reading for 2 s mid-burst loses nothing, and holds the program back", async () => {
    const r = await burst(true);
    expect(r.missingFromView).toBe(0);
  });

  it.each([1, 2, 3, 4])("a view that never reads, alone, under yes: trial %i", async (trial) => {
    const row = await stall(trial);
    expect(row.serverAlive).toBe(true);
  });
});
