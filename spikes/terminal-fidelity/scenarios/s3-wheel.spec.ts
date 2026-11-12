import { test } from "@playwright/test";
import { createTerm, deleteTerm, openView, save, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const LONG = { claude: "show [[fake:long:120]]", codex: "show LONG:120" };

for (const which of ["claude", "codex"] as const) {
  test(`S3 wheel in ${which}`, async ({ page }) => {
    const env = await setupTuis();
    const name = `s3w-${which}`;
    try {
      const l = env[which];
      await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForTimeout(2500);
      await openView(page, name);
      await page.waitForTimeout(2500);
      await page.keyboard.type(LONG[which], { delay: 30 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(4000);
      const before = (await viewport(page)).join("\n");
      const n = await page.evaluate(() => (window as any).spike.sent.length);
      await page.mouse.move(600, 400);
      for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(100); }
      await page.waitForTimeout(800);
      const after = (await viewport(page)).join("\n");
      const sent = await page.evaluate((n) => (window as any).spike.sent.slice(n).map((s: any) => s.hex), n);
      const modes = await page.evaluate(() => {
        const t = (window as any).spike.term;
        return { mouseTracking: t.modes.mouseTrackingMode, buffer: t.buffer.active.type, viewportY: t.buffer.active.viewportY };
      });
      const firstLine = (s: string) => (/line (\d{4})/.exec(s) ?? [null, null])[1];
      const r = {
        sentOnWheel: [...new Set(sent.map((h: string) => Buffer.from(h, "hex").toString().replace(/\x1b/g, "ESC")))],
        sentCount: sent.length,
        modes,
        firstNumberedLineBefore: firstLine(before),
        firstNumberedLineAfter: firstLine(after),
        screenChanged: before !== after,
        promptAfter: after.split("\n").filter((x) => /^[❯›]/.test(x)).slice(-1)[0],
      };
      console.log(which, JSON.stringify(r));
      save(`s3-wheel-${which}.json`, r);
    } finally {
      await deleteTerm(name);
      env.cleanup();
    }
  });
}
