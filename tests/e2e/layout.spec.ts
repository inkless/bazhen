import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { launch, screen, status, viewportTop } from "./page.ts";

// The page is an app the size of the screen: the document never scrolls, and the terminal is in
// view without scrolling anything, on a phone and an iPad either way up and on a desktop.

const WORK = String(process.env["BZ_E2E_WORK"]);
const PROMPT = /[$#%>][\s ]*$/;

const SCREENS: readonly { name: string; options: BrowserContextOptions }[] = [
  { name: "an iPhone upright", options: phone(390, 844) },
  { name: "an iPhone on its side", options: phone(844, 390) },
  { name: "an iPad upright", options: phone(820, 1180) },
  { name: "an iPad on its side", options: phone(1180, 820) },
  { name: "a desktop", options: { viewport: { width: 1280, height: 800 } } },
];

function phone(width: number, height: number): BrowserContextOptions {
  return { hasTouch: true, isMobile: true, viewport: { width, height } };
}

/** An agent and a standalone shell, opened once for the whole file. */
let agentId = "";
let shellId = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  agentId = await launch(page);
  shellId = await page.evaluate(async (cwd) => {
    const res = await fetch("/v1/shells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), cwd }),
    });
    return String(Reflect.get(Object(await res.json()), "terminalId"));
  }, WORK);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("/");
  await page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const listed: unknown = Reflect.get(Object(state), "shells");
    const found: unknown = Array.isArray(listed)
      ? listed.find((s: unknown) => Reflect.get(Object(s), "id") === id)
      : undefined;
    await fetch(`/v1/shells/${id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        generation: Reflect.get(Object(found), "generation"),
        confirmedProgram: Reflect.get(Object(Reflect.get(Object(found), "foreground")), "command"),
      }),
    });
  }, shellId);
  await page.close();
});

/** How far the page reaches past the window, down and across: 0 when nothing can scroll it. */
const overflow = (page: Page) =>
  page.evaluate<{ down: number; across: number }>(`(() => {
    const doc = document.documentElement;
    return {
      down: Math.max(0, doc.scrollHeight - doc.clientHeight),
      across: Math.max(0, doc.scrollWidth - doc.clientWidth),
    };
  })()`);

function windowOf(page: Page): { width: number; height: number } {
  const size = page.viewportSize();
  if (size === null) throw new Error("the page has no fixed viewport");
  return size;
}

/** The bottom of what the user can see: the window's, or the key bar's top while it shows. */
async function visibleBottom(page: Page): Promise<number> {
  const bar = await keyBarBox(page);
  return Math.min(windowOf(page).height, bar?.y ?? Number.POSITIVE_INFINITY);
}

/** Where the key bar is, or `null` where it doesn't show, as on a desktop. */
async function keyBarBox(page: Page) {
  const bar = page.getByRole("toolbar", { name: "terminal keys" });
  return (await bar.count()) === 0 ? null : bar.boundingBox();
}

/** Whether the terminal's whole screen is inside the window and above the key bar. */
async function terminalInView(page: Page): Promise<boolean> {
  const box = await page.locator(".xterm-screen").first().boundingBox();
  if (box === null) return false;
  const right = windowOf(page).width;
  const bottom = await visibleBottom(page);
  return box.y >= 0 && box.x >= 0 && box.x + box.width <= right && box.y + box.height <= bottom;
}

async function open(browser: Browser, options: BrowserContextOptions, hash: string) {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto(`/${hash}`);
  await expect(page.locator(".xterm-screen").first()).toBeVisible();
  return page;
}

for (const { name, options } of SCREENS) {
  test(`fits ${name}, with the agent's terminal and a shell's in view and no page scroll`, async ({
    browser,
  }) => {
    for (const hash of [`#/agent/${agentId}`, `#/shell/${shellId}`]) {
      const page = await open(browser, options, hash);
      await expect
        .poll(async () => ({ page: await overflow(page), terminal: await terminalInView(page) }), {
          message: `${hash} at ${name}`,
        })
        .toEqual({ page: { down: 0, across: 0 }, terminal: true });
      await page.context().close();
    }
  });
}

/**
 * A soft keyboard, as the page sees one: the visual viewport shrinks by `covered` pixels from
 * the bottom, and says so, while the window keeps its size, as iOS does.
 */
function softKeyboard(page: Page) {
  return page.addInitScript(`{
    const real = window.visualViewport;
    const fake = new EventTarget();
    let covered = 0;
    Object.defineProperties(fake, {
      width: { get: () => innerWidth },
      height: { get: () => innerHeight - covered },
      offsetTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => scrollY },
      pageLeft: { get: () => scrollX },
      scale: { get: () => 1 },
    });
    real?.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    globalThis.bazhenKeyboard = (px) => {
      covered = px;
      fake.dispatchEvent(new Event("resize"));
    };
  }`);
}

/** The bottom edge of the row the shell's prompt, and so its cursor, is on. */
async function promptRowBottom(page: Page): Promise<number> {
  const lines = (await screen(page, shellId)).split("\n").slice(await viewportTop(page, shellId));
  const row = lines.findLastIndex((line) => PROMPT.test(line));
  const box = await page.locator(".xterm-screen").first().boundingBox();
  if (row < 0 || box === null) return Number.POSITIVE_INFINITY;
  return box.y + ((row + 1) * box.height) / lines.length;
}

/** Whether the key bar and the cursor's row show above `covered` pixels of keyboard. */
async function aboveKeyboard(page: Page, covered: number) {
  const bar = await keyBarBox(page);
  const bottom = windowOf(page).height - covered;
  return {
    bar: bar !== null && bar.y >= 0 && bar.y + bar.height <= bottom,
    cursor: (await promptRowBottom(page)) <= (bar?.y ?? bottom),
    page: await overflow(page),
  };
}

for (const { name, options } of SCREENS.slice(0, 2)) {
  test(`keeps the cursor's row and the key bar above the soft keyboard on ${name}`, async ({
    browser,
  }) => {
    const page = await (await browser.newContext(options)).newPage();
    await softKeyboard(page);
    await page.goto(`/#/shell/${shellId}`);
    const pane = page.getByRole("article", { name: /^shell / });
    await pane.locator(".xterm-screen").tap();
    await expect(status(pane)).toHaveText("Driving");
    // Enough lines that the prompt, and the cursor with it, ends on the terminal's last row.
    await page.keyboard.type("clear; seq 200");
    await page.keyboard.press("Enter");
    await expect.poll(() => screen(page, shellId)).toMatch(/^200\s*$/m);
    const covered = Math.round(windowOf(page).height * 0.4);
    await page.evaluate(`bazhenKeyboard(${covered})`);
    await expect
      .poll(() => aboveKeyboard(page, covered))
      .toEqual({ bar: true, cursor: true, page: { down: 0, across: 0 } });
    await page.context().close();
  });
}
