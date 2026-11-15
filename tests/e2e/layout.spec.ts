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

interface Screen {
  readonly name: string;
  readonly options: BrowserContextOptions;
  /** What share of what the user sees, at least, the terminals get. */
  readonly share: number;
}

const SCREENS: readonly Screen[] = [
  { name: "an iPhone upright", options: phone(390, 844), share: 0.5 },
  { name: "an iPhone on its side", options: phone(844, 390), share: 0.3 },
  { name: "an iPad upright", options: phone(820, 1180), share: 0.5 },
  { name: "an iPad on its side", options: phone(1180, 820), share: 0.4 },
  { name: "a desktop", options: { viewport: { width: 1280, height: 800 } }, share: 0.3 },
];

function phone(width: number, height: number): BrowserContextOptions {
  return { hasTouch: true, isMobile: true, viewport: { width, height } };
}

/** An agent with a shell linked to it, and a standalone shell, opened once for the whole file. */
let agentId = "";
let shellId = "";
const shells: string[] = [];

/** Opens a shell, standalone in the work directory or linked to an agent; answers its id. */
const openShell = (page: Page, where: { cwd: string } | { linkedAgentId: string }) =>
  page.evaluate(async (body) => {
    const res = await fetch("/v1/shells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...body }),
    });
    return String(Reflect.get(Object(await res.json()), "terminalId"));
  }, where);

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  agentId = await launch(page);
  shells.push(await openShell(page, { linkedAgentId: agentId }));
  shellId = await openShell(page, { cwd: WORK });
  shells.push(shellId);
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto("/");
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
          confirmedProgram: Reflect.get(
            Object(Reflect.get(Object(found), "foreground")),
            "command",
          ),
        }),
      });
    }
  }, shells);
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

/** Where the key bar is, or `null` where it doesn't show, as on a desktop. */
async function keyBarBox(page: Page) {
  const bar = page.getByRole("toolbar", { name: "terminal keys" });
  return (await bar.count()) === 0 ? null : bar.boundingBox();
}

/** The bottom of what the user can see: the window's, or the key bar's top while it shows. */
async function visibleBottom(page: Page): Promise<number> {
  const bar = await keyBarBox(page);
  return Math.min(windowOf(page).height, bar?.y ?? Number.POSITIVE_INFINITY);
}

/** The screen of every terminal the page shows. */
async function terminalBoxes(page: Page) {
  const boxes = await Promise.all(
    (await page.locator(".xterm-screen").all()).map((s) => s.boundingBox()),
  );
  return boxes.flatMap((box) => (box === null ? [] : [box]));
}

/** Whether every terminal's whole screen is inside the window and above the key bar. */
async function terminalsInView(page: Page): Promise<boolean> {
  const boxes = await terminalBoxes(page);
  const right = windowOf(page).width;
  const bottom = await visibleBottom(page);
  return (
    boxes.length > 0 &&
    boxes.every((b) => b.y >= 0 && b.x >= 0 && b.x + b.width <= right && b.y + b.height <= bottom)
  );
}

/**
 * How much of the height the user sees, above the key bar, the terminals' screens take: the
 * screens one above the other in the first one's column, where a dock beside it would count twice.
 */
async function terminalShare(page: Page): Promise<number> {
  const boxes = await terminalBoxes(page);
  const column = boxes.filter((b) => b.x === boxes[0]?.x);
  const tall = column.reduce((sum, b) => sum + b.height, 0);
  return Math.round((tall / (await visibleBottom(page))) * 100) / 100;
}

async function open(browser: Browser, options: BrowserContextOptions, hash: string) {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto(`/${hash}`);
  await expect(page.locator(".xterm-screen").first()).toBeVisible();
  return page;
}

for (const { name, options, share } of SCREENS) {
  test(`fits ${name}, with the agent's terminals and a shell's in view and no page scroll`, async ({
    browser,
  }) => {
    for (const hash of [`#/agent/${agentId}`, `#/shell/${shellId}`]) {
      const page = await open(browser, options, hash);
      await expect
        .poll(async () => ({ page: await overflow(page), terminal: await terminalsInView(page) }), {
          message: `${hash} at ${name}`,
        })
        .toEqual({ page: { down: 0, across: 0 }, terminal: true });
      expect(await terminalShare(page), `${hash} at ${name}`).toBeGreaterThanOrEqual(share);
      await page.context().close();
    }
  });
}

/**
 * A soft keyboard, as the page sees one: the visual viewport shrinks from the bottom, a frame at a
 * time, and says so, while the window keeps its size, as iOS does.
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
    globalThis.bazhenKeyboard = async (px) => {
      const from = covered;
      for (let frame = 1; frame <= 12; frame++) {
        await new Promise(requestAnimationFrame);
        covered = Math.round(from + ((px - from) * frame) / 12);
        fake.dispatchEvent(new Event("resize"));
      }
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

/** Each resize the page sends for its terminals, as it sends them. */
function resizesSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes('"resize"')) sent.push(payload);
    });
  });
  return sent;
}

/** How many resizes went out from `since` on, once the page has had time to send any more. */
async function resizesAfter(page: Page, sent: readonly string[], since: number) {
  // Longer than the viewport takes to settle, so a second resize would have gone by now.
  await page.waitForTimeout(600);
  return sent.length - since;
}

/** A phone showing the standalone shell, typed into, with its prompt on the last row. */
async function typingInShell(browser: Browser, options: BrowserContextOptions) {
  const page = await (await browser.newContext(options)).newPage();
  await softKeyboard(page);
  const sent = resizesSent(page);
  await page.goto(`/#/shell/${shellId}`);
  const pane = page.getByRole("article", { name: /^shell / });
  await pane.locator(".xterm-screen").tap();
  await expect(status(pane)).toHaveText("Driving");
  await page.keyboard.type("clear; seq 200");
  await page.keyboard.press("Enter");
  await expect.poll(() => screen(page, shellId)).toMatch(/^200\s*$/m);
  return { page, pane, sent };
}

for (const { name, options } of SCREENS.slice(0, 2)) {
  test(`resizes the terminal once for the soft keyboard, to above it, on ${name}`, async ({
    browser,
  }) => {
    const { page, pane, sent } = await typingInShell(browser, options);
    const covered = Math.round(windowOf(page).height * 0.4);
    const beforeShow = sent.length;
    await page.evaluate(`bazhenKeyboard(${covered})`);
    await expect
      .poll(() => aboveKeyboard(page, covered))
      .toEqual({ bar: true, cursor: true, page: { down: 0, across: 0 } });
    expect(await resizesAfter(page, sent, beforeShow)).toBe(1);
    await expect(status(pane)).toBeVisible();

    // As iOS closes it: the terminal loses focus first, then the keyboard animates away.
    const beforeHide = sent.length;
    await page.evaluate("document.activeElement.blur()");
    await page.evaluate("bazhenKeyboard(0)");
    await expect(page.getByRole("button", { name: "Fleet", exact: true })).toBeVisible();
    expect(await resizesAfter(page, sent, beforeHide)).toBe(1);
    await page.context().close();
  });
}

test("closes the soft keyboard from the key bar, taking focus off the terminal", async ({
  browser,
}) => {
  const { page } = await typingInShell(browser, phone(390, 844));
  await page.getByRole("button", { name: "Close keyboard" }).tap();
  await expect
    .poll(() => page.evaluate<boolean>(`document.activeElement?.closest(".terminal-host") != null`))
    .toBe(false);
  await page.context().close();
});

test("keeps focus on the page when a phone swaps the fleet for the agent opened from it", async ({
  browser,
}) => {
  const page = await (await browser.newContext(phone(390, 844))).newPage();
  await page.goto("/");
  await page.getByRole("list", { name: "agents" }).getByRole("button").last().tap();
  await expect(page.getByRole("article", { name: "agent" })).toBeVisible();
  await expect
    .poll(() => page.evaluate<boolean>(`document.activeElement?.closest(".centre") != null`))
    .toBe(true);
  await page.context().close();
});
