import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OUT, createTerm, deleteTerm, openView, save, waitForText } from "./helpers.ts";

const PROBE = new URL("../probe.ts", import.meta.url).pathname;

test("S2 Esc latency in the browser, and xterm.js replies to tmux's attach queries", async ({ page }) => {
  const log = `${OUT}s2-escb.jsonl`;
  await createTerm("s2-escb", ["node", PROBE, log]);
  await openView(page, "s2-escb");
  await waitForText(page, "probe ready");
  await page.waitForTimeout(1500);
  const replies = await page.evaluate(() => (window as any).spike.sent.map((s: any) => s.hex));
  const vis = replies.map((h: string) => Buffer.from(h, "hex").toString().replace(/\x1b/g, "ESC"));
  const read = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const samples: (number | null)[] = [];
  for (let i = 0; i < 5; i++) {
    const n0 = read().length;
    const t0 = Date.now();
    await page.keyboard.press("Escape");
    let ms: number | null = null;
    while (Date.now() - t0 < 3000) {
      await page.waitForTimeout(5);
      if (read().length > n0) { ms = Date.now() - t0; break; }
    }
    samples.push(ms);
    await page.waitForTimeout(200);
  }
  const r = { xtermRepliesAtAttach: vis, escDeliveredMs: samples };
  console.log(JSON.stringify(r));
  save("s2-esc-browser.json", r);
  await deleteTerm("s2-escb");
});
