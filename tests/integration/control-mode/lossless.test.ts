import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import {
  HISTORY,
  Screen,
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
  return { client, screen };
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
    const { screen } = await view(server, t);
    await until(() => numbers(tmuxLines(server, t.pane)).has(40000), 30_000);
    await sleep(500);
    await screen.settled();
    const r = compare("seam-mid-burst", server, t, screen);
    expect(r.missingFromView + r.extraInView + r.duplicateLines).toBe(0);
  });

  it("a view that reads throughout gets all of seq 1 200000", async () => {
    const r = await burst(false);
    expect(r.missingFromView).toBe(0);
  });

  it("a view that stops reading for 2 s mid-burst loses nothing, and holds the program back", async () => {
    const r = await burst(true);
    expect(r.missingFromView).toBe(0);
  });

  it("a view that never reads: does tmux hold the program, or drop the view", async () => {
    const server = spikeServer("stall");
    servers.push(server);
    const t = newTerminal(server, "stall", "yes");
    const { client } = await ControlClient.attach(server, t.session).then((c) => {
      clients.push(c);
      return { client: c };
    });
    client.pause();
    const sample = () => {
      const [h, pid] = server
        .runSync(["display-message", "-p", "-t", t.pane, "#{history_size} #{pane_pid}"])
        .trim()
        .split(" ");
      return { history: Number(h), pid: Number(pid) };
    };
    const rows: Array<Record<string, unknown>> = [];
    const start = Date.now();
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const s = sample();
      const stat = readFileSync(`/proc/${s.pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({
        s: Math.round((Date.now() - start) / 1000),
        history: s.history,
        yesCpuS: (Number(f[11]) + Number(f[12])) / 100,
        tmuxRssKb: Number(
          readFileSync(
            `/proc/${Number(server.runSync(["display-message", "-p", "#{pid}"]))}/status`,
            "utf8",
          ).match(/VmRSS:\s+(\d+)/)?.[1],
        ),
        clientAlive: client.child.exitCode === null,
      });
    }
    report("stalled-reader", { rows, exitReason: client.exitReason });
    expect(server.alive()).toBe(true);
  });
});
