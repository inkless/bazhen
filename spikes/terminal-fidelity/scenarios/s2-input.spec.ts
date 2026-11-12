import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OUT, createTerm, deleteTerm, openView, save, waitForText } from "./helpers.ts";

const PROBE = new URL("../probe.ts", import.meta.url).pathname;

const KEYS = [
  "a", "Shift+A", "Control+a", "Control+c", "Control+z", "Control+Backslash", "Control+Space",
  "Control+Slash", "Control+BracketLeft", "Control+Enter", "Shift+Enter", "Alt+Enter", "Alt+b",
  "Alt+Shift+B", "Control+Alt+a", "Meta+k", "Escape", "Tab", "Shift+Tab", "Backspace",
  "Control+Backspace", "Alt+Backspace", "Enter", "ArrowUp", "Shift+ArrowUp", "Control+ArrowLeft",
  "Alt+ArrowLeft", "Home", "End", "PageUp", "Delete", "Insert", "F1", "F5", "F12", "Control+j",
  "Control+r", "Control+o", "Control+t", "Control+_",
];

async function probeLog(file: string): Promise<{ t: number; hex: string; vis: string }[]> {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function startProbe(page: Page, name: string, flags: string[]): Promise<string> {
  const log = `${OUT}${name}.jsonl`;
  await createTerm(name, ["node", PROBE, log, ...flags], { cols: 120, rows: 36 });
  await openView(page, name);
  await waitForText(page, "probe ready");
  return log;
}

async function sentSince(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as any).spike.sent.slice(n).map((s: any) => s.hex).join(" "), n);
}

for (const [label, flags] of [
  ["plain", []],
  ["mok2", ["--mok=2"]],
  ["kitty", ["--kitty=1", "--query"]],
] as const) {
  test(`S2 keys under ${label}`, async ({ page }) => {
    const name = `s2-${label}`;
    const log = await startProbe(page, name, [...flags]);
    await page.waitForTimeout(300);
    const pre = await probeLog(log); // e.g. replies to queries
    const rows: unknown[] = [];
    for (const key of KEYS) {
      const nSent = await page.evaluate(() => (window as any).spike.sent.length);
      const nLog = (await probeLog(log)).length;
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
      const got = (await probeLog(log)).slice(nLog);
      rows.push({ key, sent: await sentSince(page, nSent), received: got.map((g) => g.hex).join(" "), vis: got.map((g) => g.vis).join(" ") });
    }
    save(`s2-keys-${label}.json`, { pre, rows });
    console.log(label, "pre:", JSON.stringify(pre.map((p) => p.vis)));
    for (const r of rows as any[]) console.log(label.padEnd(6), r.key.padEnd(20), "sent", (r.sent || "-").padEnd(24), "recv", r.vis || "-");
    await deleteTerm(name);
  });
}

test("S2 Esc timing, paste, focus, IME, mouse", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const log = await startProbe(page, "s2-misc", ["--paste", "--focus", "--mouse"]);
  const res: Record<string, unknown> = {};
  const mark = async () => (await probeLog(log)).length;
  const since = async (n: number) => (await probeLog(log)).slice(n);

  // Esc then a letter, fast and slow: does the app see one chunk (Alt+x) or two?
  let n = await mark();
  await page.keyboard.press("Escape");
  await page.keyboard.press("x");
  await page.waitForTimeout(200);
  res.escFast = (await since(n)).map((c) => c.vis);
  n = await mark();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await page.keyboard.press("x");
  await page.waitForTimeout(200);
  res.escSlow = (await since(n)).map((c) => c.vis);

  // Bracketed paste through xterm's paste path, and through a real Cmd+V.
  const text = "line one\nline two — ünïcødé 日本語 🙂\n\ttabbed";
  n = await mark();
  await page.evaluate((t) => (window as any).spike.term.paste(t), text);
  await page.waitForTimeout(300);
  res.pasteApi = (await since(n)).map((c) => c.vis).join("");
  n = await mark();
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(300);
  res.pasteCmdV = (await since(n)).map((c) => c.vis).join("");
  const big = Array.from({ length: 400 }, (_, i) => `paste line ${i} ${"x".repeat(60)}`).join("\n");
  n = await mark();
  await page.evaluate((t) => (window as any).spike.term.paste(t), big);
  await page.waitForTimeout(1500);
  const bigGot = Buffer.from((await since(n)).map((c) => c.hex).join(""), "hex").toString();
  res.pasteBig = { sentChars: big.length, receivedChars: bigGot.length, starts: bigGot.slice(0, 6) === "\x1b[200~", ends: bigGot.endsWith("\x1b[201~"), intact: bigGot.includes(big.replace(/\n/g, "\r")) };

  // IME: committed text and a composition sequence via CDP.
  n = await mark();
  await page.keyboard.insertText("日本語");
  await page.waitForTimeout(200);
  res.imeInsertText = (await since(n)).map((c) => c.vis).join("");
  const cdp = await context.newCDPSession(page);
  n = await mark();
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "日本" });
  await page.waitForTimeout(300);
  res.imeComposition = (await since(n)).map((c) => c.vis);

  // Focus events.
  n = await mark();
  await page.evaluate(() => (window as any).spike.term.blur());
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as any).spike.term.focus());
  await page.waitForTimeout(150);
  res.focus = (await since(n)).map((c) => c.vis);

  // Mouse: click cell (10,5), drag, wheel.
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  const dims = await page.evaluate(() => {
    const t = (window as any).spike.term;
    return { cols: t.cols, rows: t.rows };
  });
  const cw = box.width / dims.cols, ch = box.height / dims.rows;
  const at = (c: number, r: number) => [box.x + (c - 0.5) * cw, box.y + (r - 0.5) * ch] as const;
  n = await mark();
  await page.mouse.click(...at(10, 5));
  await page.waitForTimeout(150);
  res.mouseClick = (await since(n)).map((c) => c.vis);
  n = await mark();
  await page.mouse.move(...at(10, 5));
  await page.mouse.down();
  await page.mouse.move(...at(20, 8), { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  res.mouseDrag = (await since(n)).map((c) => c.vis);
  n = await mark();
  await page.mouse.move(...at(30, 10));
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  res.mouseWheel = (await since(n)).map((c) => c.vis);

  save("s2-misc.json", res);
  console.log(JSON.stringify(res, null, 1));
  expect(res.pasteBig).toBeTruthy();
  await deleteTerm("s2-misc");
});
