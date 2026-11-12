import { test, type Page } from "@playwright/test";
import { capture, createTerm, deleteTerm, info, save } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const CONFIG = process.env["BZ_SPIKE_TMUX_EXTRA"] ? "no-smcup" : "repo";
const LONG = { claude: "show [[fake:long:150]]", codex: "show LONG:150", codexNoAlt: "show LONG:150" };

async function rowsVsTmux(p: Page, name: string) {
  const v = await p.evaluate(() => (window as any).spike.viewportText() as string[]);
  const t = (await capture(name)).split("\n");
  return v.filter((x, i) => x.trimEnd() !== (t[i] ?? "").trimEnd()).length;
}
const reachable = (p: Page) =>
  p.evaluate(() => {
    const t = (window as any).spike.term;
    const b = t.buffer.active;
    const nums: number[] = [];
    for (let i = 0; i < b.length; i++) {
      const m = /line (\d{4})/.exec(b.getLine(i)?.translateToString(true, 0, t.cols) ?? "");
      if (m) nums.push(Number(m[1]));
    }
    return { buffer: b.type, scrollbackRows: b.length - t.rows, numbered: nums.length, first: nums[0] ?? null, last: nums.at(-1) ?? null };
  });

for (const which of ["claude", "codex", "codexNoAlt"] as const) {
  test(`S6 TUI snapshot [${CONFIG}] ${which}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const env = await setupTuis();
    const name = `s6t-${which}`;
    const r: Record<string, unknown> = { config: CONFIG, which };
    const c0 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const c1 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const c2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
      const l = env[which];
      await createTerm(name, l.argv, { cwd: l.cwd, env: l.env, cols: 120, rows: 40 });
      await new Promise((res) => setTimeout(res, 2500));
      // Produce output while viewed, then leave so the next view is a fresh first view.
      const p0 = await c0.newPage();
      await p0.goto(`/?name=${name}`);
      await p0.waitForFunction(() => (window as any).spike?.driver);
      await p0.waitForTimeout(1500);
      await p0.keyboard.type(LONG[which], { delay: 30 });
      await p0.keyboard.press("Enter");
      await p0.waitForTimeout(4000);
      await c0.close();
      await new Promise((res) => setTimeout(res, 800));
      r.attachClientAfterLastViewLeft = (await info(name)).attachClient;
      const first = await c1.newPage();
      await first.goto(`/?name=${name}&mode=observe`);
      await first.waitForFunction(() => (window as any).spike?.snapshot.ended > 0);
      await first.waitForTimeout(1500);
      const second = await c2.newPage();
      await second.goto(`/?name=${name}&mode=observe`);
      await second.waitForFunction(() => (window as any).spike?.snapshot.ended > 0);
      await second.waitForTimeout(1500);
      r.paneAlternateOn = (await info(name)).tmux.split(" ")[2] === "1";
      r.first = { rowsDifferFromTmux: await rowsVsTmux(first, name), ...(await reachable(first)) };
      r.second = { rowsDifferFromTmux: await rowsVsTmux(second, name), ...(await reachable(second)) };
    } finally {
      save(`s6-tui-${CONFIG}-${which}.json`, r);
      console.log(JSON.stringify(r));
      await c1.close();
      await c2.close();
      await deleteTerm(name);
      env.cleanup();
    }
  });
}
