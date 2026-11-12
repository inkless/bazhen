import { test, type Page } from "@playwright/test";
import { SHELL, SHELL_ENV, api, createTerm, deleteTerm, openView, save } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const N = 200;
const BATCH = 40;
const ALPHA = "qwertyuiopasdfghjklzxcvbnmmnbvcxzlkjhgfdsapoiuytrewq";

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
}

async function measure(page: Page, clear: () => Promise<void>): Promise<{ total: number[]; toFirstByte: number[]; parse: number[]; timeouts: number }> {
  await page.evaluate(() => { const s = (window as any).spike; s.latency = []; s.typed = ""; s.pending = null; });
  let timeouts = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && i % BATCH === 0) {
      await clear();
      await page.evaluate(() => { const s = (window as any).spike; s.typed = ""; s.pending = null; });
    }
    const before = await page.evaluate(() => (window as any).spike.latency.length);
    await page.keyboard.press(ALPHA[i % BATCH]!);
    const ok = await page.waitForFunction((n) => (window as any).spike.latency.length > n, before, { timeout: 2000 }).then(() => true, () => false);
    if (!ok) { timeouts++; await page.evaluate(() => { (window as any).spike.pending = null; }); }
    await page.waitForTimeout(15);
  }
  const lat = await page.evaluate(() => (window as any).spike.latency as { key: number; recv: number; parsed: number }[]);
  return {
    total: lat.map((l) => l.parsed - l.key),
    toFirstByte: lat.map((l) => l.recv - l.key),
    parse: lat.map((l) => l.parsed - l.recv),
    timeouts,
  };
}

for (const target of ["cat", "claude", "codex"] as const) {
  test(`S5 echo latency: ${target}`, async ({ page }) => {
    test.setTimeout(900_000);
    const env = target === "cat" ? null : await setupTuis();
    const name = `s5-${target}`;
    const rows: unknown[] = [];
    try {
      if (env) {
        const l = env[target as "claude" | "codex"];
        await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
      } else await createTerm(name, [...SHELL], { env: SHELL_ENV });
      await page.waitForTimeout(2500);
      await openView(page, name);
      await page.waitForTimeout(2000);
      if (target === "cat") {
        await page.keyboard.type("stty -echoctl; cat\n", { delay: 20 });
        await page.waitForTimeout(500);
      }
      const clear = async () => {
        await page.keyboard.press(target === "cat" ? "Enter" : "Control+u");
        await page.waitForTimeout(250);
      };
      for (const delay of [0, 20, 80]) {
        await api("POST", "/api/delay", { ms: delay });
        await page.waitForTimeout(300);
        const m = await measure(page, clear);
        await clear();
        const row = {
          target, oneWayDelayMs: delay, samples: m.total.length, timeouts: m.timeouts,
          p50: pct(m.total, 50), p90: pct(m.total, 90), p99: pct(m.total, 99), max: pct(m.total, 100),
          firstByteP50: pct(m.toFirstByte, 50), firstByteP99: pct(m.toFirstByte, 99),
          parseP50: pct(m.parse, 50), parseP99: pct(m.parse, 99),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    } finally {
      await api("POST", "/api/delay", { ms: 0 });
      save(`s5-${target}.json`, rows);
      await deleteTerm(name);
      env?.cleanup();
    }
  });
}
