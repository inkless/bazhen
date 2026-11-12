import { test, type Page } from "@playwright/test";
import { OUT, capture, createTerm, deleteTerm, openView, save, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const M = {
  claude: { plain: "hi [[fake:plain]]", slow: "go [[fake:slow:10]]", approve: "run [[fake:bash:touch approved.txt]]", long: "show [[fake:long:60]]", ready: /❯/ },
  codex: { plain: "hi there", slow: "go SLOW", approve: "please RUN_CMD", long: "show LONG:60", ready: /›/ },
};

const human = (page: Page, text: string) => page.keyboard.type(text, { delay: 30 });
const view = async (page: Page) => (await viewport(page)).join("\n");

async function waitView(page: Page, re: RegExp, timeout = 15_000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (re.test(await view(page))) return Date.now() - t0;
    await page.waitForTimeout(25);
  }
  return null;
}

async function clearPrompt(page: Page): Promise<void> {
  await page.keyboard.press("Control+u");
  await page.keyboard.press("Control+u");
  await page.waitForTimeout(300);
}

/** Rows where xterm.js and tmux disagree on content: a Unicode width disagreement shows here. */
async function widthDiff(page: Page, name: string): Promise<{ rows: number; mismatches: { row: number; xterm: string; tmux: string }[] }> {
  const x = await viewport(page);
  const t = (await capture(name)).split("\n");
  const mismatches = [];
  for (let i = 0; i < x.length; i++) {
    if ((x[i] ?? "").trimEnd() !== (t[i] ?? "").trimEnd()) mismatches.push({ row: i, xterm: x[i] ?? "", tmux: t[i] ?? "" });
  }
  return { rows: x.length, mismatches };
}

async function colourStats(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const t = (window as any).spike.term;
    const b = t.buffer.active;
    const s = { cells: 0, fgRGB: 0, bgRGB: 0, fgPalette: 0, bold: 0, italic: 0, underline: 0, dim: 0, inverse: 0 };
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
      const line = b.getLine(y);
      for (let x = 0; x < t.cols; x++) {
        const c = line?.getCell(x);
        if (!c || !c.getChars()) continue;
        s.cells++;
        if (c.isFgRGB()) s.fgRGB++;
        if (c.isBgRGB()) s.bgRGB++;
        if (c.isFgPalette()) s.fgPalette++;
        if (c.isBold()) s.bold++;
        if (c.isItalic()) s.italic++;
        if (c.isUnderline()) s.underline++;
        if (c.isDim()) s.dim++;
        if (c.isInverse()) s.inverse++;
      }
    }
    return s;
  });
}

const READY_REPLY = { claude: /⏺ ok/, codex: /echo: hi there/ };

async function fresh(page: Page, env: Awaited<ReturnType<typeof setupTuis>>, which: "claude" | "codex", name: string): Promise<void> {
  const l = env[which];
  await createTerm(name, l.argv, { cwd: l.cwd, env: l.env, cols: 140, rows: 40 });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(2500);
  await openView(page, name);
  await waitView(page, M[which].ready);
  await page.waitForTimeout(1200);
}

for (const which of ["claude", "codex"] as const) {
  test(`S3 ${which}: shortcuts, interrupt, paste, approval, colour, width`, async ({ page }) => {
    test.setTimeout(480_000);
    const m = M[which];
    const env = await setupTuis();
    const r: Record<string, unknown> = {};
    let n = 0;
    const check = async (label: string, fn: (name: string) => Promise<void>) => {
      const name = `s3-${which}-${++n}`;
      try {
        await fresh(page, env, which, name);
        await fn(name);
      } catch (e) {
        r[label] = `error: ${String(e).slice(0, 200)}`;
      } finally {
        await deleteTerm(name);
      }
    };
    try {
      await check("plainReplyMs", async () => {
        await human(page, m.plain);
        await page.keyboard.press("Enter");
        r.plainReplyMs = await waitView(page, READY_REPLY[which]);
      });
      const nl: Record<string, string> = {};
      for (const key of ["Shift+Enter", "Control+Enter", "Alt+Enter", "Control+j", "Backslash+Enter"]) {
        await check(`newline ${key}`, async () => {
          await human(page, key === "Backslash+Enter" ? "alpha\\" : "alpha");
          await page.keyboard.press(key === "Backslash+Enter" ? "Enter" : key);
          await human(page, "beta");
          await page.waitForTimeout(1500);
          const lines = (await view(page)).split("\n");
          const a = lines.map((x) => x.includes("alpha")).lastIndexOf(true);
          const b = lines.map((x) => x.includes("beta")).lastIndexOf(true);
          const replied = /⏺ ok|echo: alpha/.test(lines.join("\n"));
          nl[key] = replied ? "submitted" : b === a + 1 ? "newline" : b === a ? "same line" : `other (${a}, ${b})`;
        });
      }
      r.newline = nl;
      await check("slashMenuMs", async () => {
        await page.keyboard.type("/");
        r.slashMenuMs = await waitView(page, which === "claude" ? /\/(add-dir|help|clear)/ : /\/(model|new|init|status)/, 3000);
        await page.screenshot({ path: `${OUT}s3-${which}-slash.png` });
      });
      await check("escInterruptMs", async () => {
        await human(page, m.slow);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${OUT}s3-${which}-streaming.png` });
        await page.keyboard.press("Escape");
        r.escInterruptMs = await waitView(page, /[Ii]nterrupted/, 5000);
        await page.screenshot({ path: `${OUT}s3-${which}-interrupted.png` });
      });
      await check("ctrlC", async (name) => {
        await page.keyboard.press("Control+c");
        r.ctrlCOnceMs = await waitView(page, /[Cc]trl.?[Cc] again|again to (exit|quit)/, 3000);
        await page.waitForTimeout(1500);
        r.ctrlCOncePaneDead = (await (await fetch(`http://127.0.0.1:7681/api/terminals/${name}/info`)).json()).tmux.split(" ")[3] === "1";
      });
      await check("paste", async () => {
        const big = Array.from({ length: 60 }, (_, i) => `pasted line ${i}`).join("\n");
        await page.evaluate((t) => (window as any).spike.term.paste(t), big);
        await page.waitForTimeout(1500);
        const pv = await view(page);
        r.paste = { placeholder: (/\[Pasted[^\]]*\]/i.exec(pv) ?? [null])[0], firstLineVisible: pv.includes("pasted line 0"), lastLineVisible: pv.includes("pasted line 59") };
        await page.screenshot({ path: `${OUT}s3-${which}-paste.png` });
      });
      await check("approval", async () => {
        await human(page, m.approve);
        await page.keyboard.press("Enter");
        r.approvalShownMs = await waitView(page, which === "claude" ? /Do you want to proceed/ : /Would you like to run|Allow|approve/i, 15_000);
        await page.screenshot({ path: `${OUT}s3-${which}-approval.png` });
        await page.waitForTimeout(500);
        await page.keyboard.press("Enter");
        r.approvalDoneMs = await waitView(page, which === "claude" ? /⏺ done/ : /tool done/, 15_000);
        await page.screenshot({ path: `${OUT}s3-${which}-approved.png` });
      });
      await check("long", async (name) => {
        await human(page, m.long);
        await page.keyboard.press("Enter");
        r.longMs = await waitView(page, /line 0060/, 20_000);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${OUT}s3-${which}-long.png` });
        r.colour = await colourStats(page);
        r.captureTruecolorSGRs = ((await capture(name, "escapes=1")).match(/38;2;/g) ?? []).length;
        r.width = await widthDiff(page, name);
        const oscs = await page.evaluate(() => (window as any).spike.oscs as { id: number; data: string }[]);
        r.oscs = { count: oscs.length, ids: [...new Set(oscs.map((o) => o.id))], sample: oscs.slice(0, 2) };
        r.xtermBuffer = await page.evaluate(() => (window as any).spike.bufferType());
        r.paneAlternateOn = (await (await fetch(`http://127.0.0.1:7681/api/terminals/${name}/info`)).json()).tmux.split(" ")[2] === "1";
      });
    } finally {
      save(`s3-${which}.json`, r);
      console.log(which, JSON.stringify({ ...r, width: { rows: (r.width as any)?.rows, mismatches: (r.width as any)?.mismatches?.slice(0, 4) } }, null, 1));
      env.cleanup();
    }
  });
}
