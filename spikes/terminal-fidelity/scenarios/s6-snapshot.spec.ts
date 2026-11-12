import { test, type Page } from "@playwright/test";
import { SHELL_ENV, api, capture, createTerm, deleteTerm, openView, save } from "./helpers.ts";

// Run once per tmux config: BZ_SPIKE_TMUX_EXTRA unset (repo config) and
// BZ_SPIKE_TMUX_EXTRA='set -ga terminal-overrides ",xterm-256color:smcup@:rmcup@"'.
const CONFIG = process.env["BZ_SPIKE_TMUX_EXTRA"] ? "no-smcup" : "repo";
const PRINTER = "seq -f 'L%g' 1 3000; i=3001; while :; do echo L$i; i=$((i+1)); sleep 0.002; done";

interface BufferScan { buffer: string; numbers: number[]; first: number | null; last: number | null; gaps: [number, number][]; dups: number[]; count: number }

async function scan(page: Page): Promise<{ active: string; normal: BufferScan; alternate: BufferScan }> {
  const raw = await page.evaluate(() => {
    const t = (window as any).spike.term;
    const read = (b: any) => { const o: string[] = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i)?.translateToString(true, 0, t.cols) ?? ""); return o; };
    return { active: t.buffer.active.type, normal: read(t.buffer.normal), alternate: read(t.buffer.alternate) };
  });
  const analyse = (buffer: string, lines: string[]): BufferScan => {
    const numbers = lines.map((l) => /^L(\d+)$/.exec(l.trim())).filter(Boolean).map((m) => Number(m![1]));
    const gaps: [number, number][] = [];
    const dups: number[] = [];
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] === numbers[i - 1]) dups.push(numbers[i]!);
      else if (numbers[i]! !== numbers[i - 1]! + 1) gaps.push([numbers[i - 1]!, numbers[i]!]);
    }
    return { buffer, numbers: [], first: numbers[0] ?? null, last: numbers.at(-1) ?? null, gaps: gaps.slice(0, 10), dups: dups.slice(0, 10), count: numbers.length };
  };
  return { active: raw.active, normal: analyse("normal", raw.normal), alternate: analyse("alternate", raw.alternate) };
}

for (const seed of (process.env["BZ_SPIKE_SEEDS"] ?? "capture-then-attach").split(",") as ("capture-then-attach" | "atomic")[]) {
  test(`S6 snapshot [${CONFIG}] seed=${seed}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const name = `s6-${seed}`;
    const r: Record<string, unknown> = { config: CONFIG, seed };
    const c1 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const c2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
      await createTerm(name, ["bash", "--norc", "--noprofile", "-c", PRINTER], { env: SHELL_ENV, cols: 120, rows: 40, seed });
      await new Promise((res) => setTimeout(res, 4000)); // > 3,000 lines of history before anyone views
      const first = await c1.newPage();
      await first.goto(`/?name=${name}&mode=observe`); // observe: keep the window at 120x40
      await first.waitForFunction(() => (window as any).spike?.snapshot.ended > 0);
      await first.waitForTimeout(1500);
      const second = await c2.newPage(); // joins while output flows: serialized headless seed
      await second.goto(`/?name=${name}&mode=observe`);
      await second.waitForFunction(() => (window as any).spike?.snapshot.ended > 0);
      await second.waitForTimeout(1500);
      await api("POST", `/api/terminals/${name}/keys`, { keys: ["C-c"] });
      await first.waitForTimeout(800);
      const hist = (await capture(name, "start=-100000")).split("\n").map((l) => /^L(\d+)$/.exec(l.trim())).filter(Boolean).map((m) => Number(m![1]));
      r.tmuxLast = hist.at(-1);
      r.first = await scan(first);
      r.second = await scan(second);
      r.snapshotBytes = { first: await first.evaluate(() => (window as any).spike.snapshot.bytes), second: await second.evaluate(() => (window as any).spike.snapshot.bytes) };
    } finally {
      save(`s6-${CONFIG}-${seed}.json`, r);
      console.log(JSON.stringify(r));
      await c1.close();
      await c2.close();
      await deleteTerm(name);
    }
  });
}
