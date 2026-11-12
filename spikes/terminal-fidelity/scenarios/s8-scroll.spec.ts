import { devices, test, type Page } from "@playwright/test";
import { createTerm, deleteTerm, save, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

// Run with BZ_SPIKE_TMUX_EXTRA='set -ga terminal-overrides ",xterm-256color:smcup@:rmcup@"'.
const LONG = { claude: "show [[fake:long:150]]", codex: "show LONG:150", codexNoAlt: "show LONG:150" };
const READY = { claude: /❯/, codex: /›/, codexNoAlt: /›/ };

async function look(p: Page) {
  const v = (await viewport(p)).join("\n");
  const nums = [...v.matchAll(/line (\d{4})/g)].map((m) => Number(m[1]));
  const st = await p.evaluate(() => {
    const t = (window as any).spike.term;
    return { viewportY: t.buffer.active.viewportY, baseY: t.buffer.active.baseY, buffer: t.buffer.active.type, mouse: t.modes.mouseTrackingMode, sent: (window as any).spike.sent.length };
  });
  return { firstLine: nums[0] ?? null, prompt: v.split("\n").filter((x) => /^[❯›]/.test(x.trim())).slice(-1)[0]?.trim() ?? null, ...st };
}

async function swipe(p: Page, down: boolean) {
  const cdp = await p.context().newCDPSession(p);
  const x = 200, y0 = down ? 300 : 600, y1 = down ? 600 : 300;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 10 }] });
    await p.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const which of ["claude", "codex", "codexNoAlt"] as const) {
  for (const wheel of (process.env["WHEELS"] ?? "default,smart").split(",")) {
    test(`S8 scroll ${which} wheel=${wheel}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const env = await setupTuis();
      const name = `s8-${which}`;
      const r: Record<string, unknown> = { which, wheel };
      const lctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const pctx = await browser.newContext({ ...devices["Pixel 7"] });
      try {
        const l = env[which];
        await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
        await new Promise((res) => setTimeout(res, 2500));
        const lap = await lctx.newPage();
        await lap.goto(`/?name=${name}&wheel=${wheel}`);
        await lap.waitForFunction(() => (window as any).spike?.driver);
        for (let i = 0; i < 100 && !READY[which].test((await viewport(lap)).join("\n")); i++) await lap.waitForTimeout(100);
        await lap.waitForTimeout(800);
        await lap.keyboard.type(LONG[which], { delay: 30 });
        await lap.keyboard.press("Enter");
        await lap.waitForTimeout(4000);
        const a0 = await look(lap);
        await lap.mouse.move(600, 400);
        for (let i = 0; i < 6; i++) { await lap.mouse.wheel(0, -200); await lap.waitForTimeout(80); }
        await lap.waitForTimeout(800);
        const a1 = await look(lap);
        r.desktopWheel = { before: a0, after: a1, bytesSent: a1.sent - a0.sent, scrolled: a1.firstLine !== a0.firstLine, historyRecalled: a1.prompt !== a0.prompt && /show/.test(a1.prompt ?? "") };
        // Back to the bottom before the phone takes over.
        for (let i = 0; i < 6; i++) { await lap.mouse.wheel(0, 200); await lap.waitForTimeout(80); }
        await lap.keyboard.press("Control+u").catch(() => {});
        const ph = await pctx.newPage();
        await ph.goto(`/?name=${name}&wheel=${wheel}&font=12`);
        await ph.waitForFunction(() => (window as any).spike?.driver);
        await ph.waitForTimeout(1500);
        const p0 = await look(ph);
        await swipe(ph, true); // finger moves down: reveal earlier output
        await ph.waitForTimeout(800);
        const p1 = await look(ph);
        r.phoneSwipe = { before: p0, after: p1, bytesSent: p1.sent - p0.sent, scrolled: p1.firstLine !== p0.firstLine || p1.viewportY !== p0.viewportY, historyRecalled: p1.prompt !== p0.prompt && /show/.test(p1.prompt ?? "") };
      } finally {
        save(`s8-${which}-${wheel}.json`, r);
        const s = (k: string) => { const x = r[k] as any; return x && { bytes: x.bytesSent, scrolled: x.scrolled, recalled: x.historyRecalled, lines: `${x.before.firstLine}->${x.after.firstLine}`, vy: `${x.before.viewportY}->${x.after.viewportY}/${x.after.baseY}`, buf: x.after.buffer, mouse: x.after.mouse }; };
        console.log(which, wheel, JSON.stringify({ wheel: s("desktopWheel"), swipe: s("phoneSwipe") }));
        await lctx.close(); await pctx.close(); await deleteTerm(name); env.cleanup();
      }
    });
  }
}
