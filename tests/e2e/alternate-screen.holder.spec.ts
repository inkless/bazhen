import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { readKeyLog } from "../support/key-log.ts";
import { runAsNextAgent } from "../support/programs.ts";
import {
  atBottom,
  daemonHome,
  expect,
  onAlternateScreen,
  screen,
  status,
  test,
  viewportTop,
} from "./page.ts";

// A holder's view gets the program's bytes as it wrote them, switches of screen included, so the
// page's terminal is on its alternate buffer exactly while the program is. Where the wheel goes
// follows that buffer: to the program, as arrows or mouse reports, or to the page's scrollback once
// the program has left it, with the history printed before it there to scroll back to.

const WORK = String(process.env["BZ_E2E_WORK"]);
const PROBE = fileURLToPath(new URL("../support/key-probe.ts", import.meta.url));
/** A line that ends at a shell's prompt: xterm pads the rest of the row with blanks. */
const PROMPT = /[$#%>][\s ]*$/m;

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

/**
 * Launches an agent from the page that runs the key probe with `options` in place of Claude Code,
 * and drives it. Answers what the probe received since `since`, as hex.
 */
async function launchProbe(page: Page, ...options: string[]) {
  const log = join(WORK, `keys-${Date.now().toString(36)}.log`);
  await runAsNextAgent(
    daemonHome(),
    [process.execPath, PROBE, log, ...options],
    async () => {
      await page.goto("/");
      await page.getByPlaceholder("/path/to/project").fill(WORK);
      await page.getByRole("button", { name: "Launch Claude Code" }).click();
      await expect(page.getByRole("region", { name: "terminal" })).toBeVisible();
      return new URL(page.url()).hash.replace("#/agent/", "");
    },
    (done, what) => expect.poll(done, { message: what, timeout: 20_000 }).toBe(true),
  );
  await expect.poll(() => screen(page), { timeout: 15_000 }).toContain("key-probe ready");
  await page.getByRole("region", { name: "terminal" }).locator(".xterm-screen").click();
  await expect(status(page)).toHaveText("Driving");
  return (since: number) =>
    readKeyLog(log)
      .filter((a) => a.at >= since)
      .map((a) => a.hex)
      .join("");
}

/** A standalone shell in the work directory, open in the centre and driven by this page. */
async function shell(page: Page): Promise<string> {
  await page.goto("/");
  const shellId = await page.evaluate(async (cwd) => {
    const res = await fetch("/v1/shells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), cwd }),
    });
    return String(Reflect.get(Object(await res.json()), "terminalId"));
  }, WORK);
  opened.push(shellId);
  await page.goto(`/#/shell/${shellId}`);
  const pane = page.getByRole("article", { name: /^shell / });
  await pane.locator(".xterm-screen").click();
  await expect(status(pane)).toHaveText("Driving");
  await expect.poll(() => screen(page, shellId), { timeout: 15_000 }).toMatch(PROMPT);
  return shellId;
}

async function run(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** The first line the terminal shows, trimmed: what a scroll moves. */
async function topLine(page: Page, terminalId?: string): Promise<string> {
  const lines = (await screen(page, terminalId)).split("\n");
  return lines[await viewportTop(page, terminalId)]?.trim() ?? "";
}

/** The wheel, turned over the terminal: down for a positive `deltaY`. */
async function wheel(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator(".xterm-screen").first().boundingBox();
  if (box === null) throw new Error("no terminal on the page");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

/** Prints numbered lines the page keeps as history, then pages `lines.txt` with `less`. */
async function lessOverHistory(page: Page, shellId: string): Promise<void> {
  await run(page, "seq 1 200 > lines.txt && seq 1001 1100 && less lines.txt");
  await expect.poll(() => topLine(page, shellId), { timeout: 15_000 }).toBe("1");
  await expect.poll(() => onAlternateScreen(page, shellId)).toBe(true);
}

/** Quits `less` and waits for the shell's prompt, back on the main screen. */
async function quitLess(page: Page, shellId: string): Promise<void> {
  await page.keyboard.press("q");
  await expect.poll(() => onAlternateScreen(page, shellId)).toBe(false);
  await expect.poll(() => screen(page, shellId)).toMatch(PROMPT);
}

/**
 * Checks the page kept the lines `seq 1001 1100` printed before `less`, every one in order, and
 * that the wheel scrolls the view back into them.
 */
async function scrollsBackToHistory(page: Page, shellId: string): Promise<void> {
  const numbers = async () =>
    (await screen(page, shellId))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .map(Number);
  expect(await numbers()).toEqual(Array.from({ length: 100 }, (_, i) => 1001 + i));
  const top = await viewportTop(page, shellId);
  await wheel(page, -400);
  await expect.poll(() => viewportTop(page, shellId)).toBeLessThan(top);
}

/** The shells this file opened, closed after each test so the run's other suites see their own. */
const opened: string[] = [];

test.afterEach(async ({ page }) => {
  await page.evaluate(async (ids) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const listed: unknown = Reflect.get(Object(state), "shells");
    for (const found of Array.isArray(listed) ? listed : []) {
      const id = String(Reflect.get(Object(found), "id"));
      if (!ids.includes(id)) continue;
      await fetch(`/v1/shells/${id}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          generation: Reflect.get(Object(found), "generation"),
          confirmBusy: true,
        }),
      });
    }
  }, opened.splice(0));
});

test("sends nothing for the wheel over an agent on its alternate screen", async ({ page }) => {
  const received = await launchProbe(page, "--lines=200", "--alternate-on-key");
  await page.keyboard.type("!");
  await expect.poll(() => screen(page)).toContain("on the alternate screen");
  const [top, since] = [await viewportTop(page), Date.now()];
  await wheel(page, -400);
  // Input is delivered in order: once this key arrives, anything the wheel sent has too.
  await page.keyboard.type("s");
  await expect.poll(() => received(since)).toContain(hex("s"));
  expect([await viewportTop(page), received(since)]).toEqual([top, hex("s")]);
});

test("less scrolls with the wheel, and its history is the page's again after it quits", async ({
  page,
}) => {
  const id = await shell(page);
  await lessOverHistory(page, id);
  await wheel(page, 400);
  await expect.poll(async () => Number(await topLine(page, id))).toBeGreaterThan(1);
  expect(await atBottom(page, id)).toBe(true);
  await quitLess(page, id);
  await scrollsBackToHistory(page, id);
});

test("nvim with the mouse on gets the wheel as mouse reports", async ({ page }) => {
  const id = await shell(page);
  await run(page, "seq 1 200 > lines.txt && nvim -u NONE -i NONE -c 'set mouse=a' lines.txt");
  await expect.poll(() => topLine(page, id), { timeout: 15_000 }).toBe("1");
  await expect.poll(() => onAlternateScreen(page, id)).toBe(true);
  await wheel(page, 400);
  await expect.poll(async () => Number(await topLine(page, id))).toBeGreaterThan(1);
  expect(await atBottom(page, id)).toBe(true);
  await run(page, ":q");
  await expect.poll(() => onAlternateScreen(page, id)).toBe(false);
});

test("opens a late view on the alternate screen, with the history to scroll after it", async ({
  page,
}) => {
  const id = await shell(page);
  await lessOverHistory(page, id);
  const late = await page.context().newPage();
  await late.goto(`/#/shell/${id}`);
  await expect.poll(() => topLine(late, id), { timeout: 15_000 }).toBe("1");
  expect(await onAlternateScreen(late, id)).toBe(true);
  await quitLess(page, id);
  await expect.poll(() => onAlternateScreen(late, id)).toBe(false);
  await expect.poll(() => screen(late, id)).toMatch(PROMPT);
  await scrollsBackToHistory(late, id);
  await late.close();
});
