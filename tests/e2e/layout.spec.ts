import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { launch, screen, status, uniqueName, viewportTop } from "./page.ts";

// The page is an app the size of the screen: the document never scrolls, and the terminal is in
// view without scrolling anything, on a phone and an iPad either way up and on a desktop.

const WORK = String(process.env["BZ_E2E_WORK"]);
const PROMPT = /[$#%>][\s ]*$/;

interface Screen {
  readonly name: string;
  readonly options: BrowserContextOptions;
  /** What the user sees: the window's height, less the key bar where it shows. */
  readonly visible: number;
  /** The app's own chrome above the workspace: its padding, header, launch form, links. */
  readonly above: number;
  /** The cap on what sits above an agent's terminals, as a share of the workspace. */
  readonly cap: number;
  /** The terminals' fixed chrome: status lines, the dock's and shells' headers and tabs, gaps. */
  readonly chrome: number;
}

/*
 * The least share of what the user sees the terminals' screens, one above the other, take on the
 * agent's page, with its linked shell, by the rule in docs/standards/ui.md: the workspace's
 * terminals get what the capped part above them leaves, less their fixed chrome. Sizes are
 * app.css's and tokens.css's: a touch screen's controls are 44px, a mouse's 24px; the key bar is
 * 53px (44 + 2 × 4 padding + 1 border); the app's padding 12px top and bottom; a status line 22.4px
 * with 16px margins, 4px where the app shows one thing at a time; and a screen may lose a row
 * (18px) to its host's height, counted in `chrome` once per terminal.
 */
const share = ({ visible, above, cap, chrome }: Screen) =>
  ((visible - above) * (1 - cap) - chrome) / visible;

// One pane, the TUI and shell as tabs: links 44 + gap 8; the dock's row 45, gap 8, status 30.4.
const IPHONE: Screen = {
  name: "an iPhone upright",
  options: phone(390, 844),
  visible: 791,
  above: 76,
  cap: 0.25,
  chrome: 101.4,
};

const SCREENS: readonly Screen[] = [
  IPHONE,
  {
    name: "an iPhone on its side",
    options: phone(844, 390),
    visible: 337,
    above: 76,
    cap: 0.25,
    chrome: 101.4,
  },
  // The rail beside, the dock under the TUI: header 44, launch form 68. Chrome: the attach line
  // 34, gap 12, the TUI's status 54.4, the dock's header 44, gap 8, tabs 45, the shell's header
  // 44, gap 8, status 54.4, gap 8, attach line 22.4, and two rows.
  {
    name: "an iPad upright",
    options: phone(820, 1180),
    visible: 1127,
    above: 136,
    cap: 0.4,
    chrome: 370.6,
  },
  // Too short to stack, so the dock sits beside: the TUI's column is its status and attach line.
  {
    name: "an iPad on its side",
    options: phone(1180, 820),
    visible: 767,
    above: 136,
    cap: 0.4,
    chrome: 106.4,
  },
  // No key bar; header 30, launch form 48; the dock as on an iPad upright, with 24px controls.
  {
    name: "a desktop",
    options: { viewport: { width: 1280, height: 800 } },
    visible: 800,
    above: 102,
    cap: 0.4,
    chrome: 310.6,
  },
  // Too short to stack the TUI and the dock (under 40rem), wide enough to sit them beside each
  // other: as on a desktop, but the TUI's column is its status and attach line, and a row.
  {
    name: "a short, wide desktop",
    options: { viewport: { width: 1280, height: 560 } },
    visible: 560,
    above: 102,
    cap: 0.4,
    chrome: 106.4,
  },
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
 * How much of the height the user sees, above the key bar, the terminals' screens take: the union
 * of their heights, so a dock beside the TUI counts once and one under it counts too.
 */
async function terminalShare(page: Page): Promise<number> {
  const spans = (await terminalBoxes(page))
    .map((b) => [b.y, b.y + b.height] as const)
    .toSorted((a, b) => a[0] - b[0]);
  let covered = 0;
  let reached = Number.NEGATIVE_INFINITY;
  for (const [top, bottom] of spans) {
    covered += Math.max(0, bottom - Math.max(top, reached));
    reached = Math.max(reached, bottom);
  }
  return covered / (await visibleBottom(page));
}

async function open(browser: Browser, options: BrowserContextOptions, hash: string) {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto(`/${hash}`);
  await expect(page.locator(".xterm-screen").first()).toBeVisible();
  await dismissThemeNotice(page);
  return page;
}

/**
 * Dismisses the list of agents started in the other theme, where it shows. It is this run's own:
 * other files start agents in dark on a page in light. A page whose agents it started itself shows
 * none.
 */
async function dismissThemeNotice(page: Page): Promise<void> {
  const notice = page.getByRole("status", { name: "theme" });
  if ((await notice.count()) > 0) await notice.getByRole("button", { name: "Dismiss" }).click();
}

for (const device of SCREENS) {
  const { name, options } = device;
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
      expect(await terminalShare(page), `${hash} at ${name}`).toBeGreaterThanOrEqual(share(device));
      await page.context().close();
    }
  });
}

test("keeps the terminals in view on a phone with the agent's rename form open", async ({
  browser,
}) => {
  const page = await open(browser, IPHONE.options, `#/agent/${agentId}`);
  const agent = page.getByRole("article", { name: "agent" });
  await agent.getByRole("button", { name: "Rename" }).tap();
  await expect(agent.getByRole("form", { name: "rename agent" })).toBeVisible();
  await expect
    .poll(async () => ({ page: await overflow(page), terminal: await terminalsInView(page) }))
    .toEqual({ page: { down: 0, across: 0 }, terminal: true });
  expect(await terminalShare(page)).toBeGreaterThanOrEqual(share(IPHONE));
  await page.context().close();
});

/** POSTs to the daemon as the page's own origin would, as a paired browser must; answers the body. */
async function post(page: Page, path: string, body: object): Promise<unknown> {
  const res = await page.request.post(path, {
    headers: { origin: new URL(page.url()).origin },
    data: { idempotencyKey: crypto.randomUUID(), ...body },
  });
  expect(res.ok(), `${path}: ${await res.text()}`).toBe(true);
  return res.json();
}

/**
 * Each element showing `text` that ends past the window's right edge. The app clips what doesn't
 * fit rather than scrolling the page, so a page that doesn't scroll can still cut a name off. A
 * picker shows its options' text, so it stands for them.
 */
const pastRightEdge = (page: Page, text: string) =>
  page.evaluate<string[]>(`[...document.querySelectorAll("body *")].flatMap((e) => {
    const text = ${JSON.stringify(text)};
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(text))) return [];
    const shown = e.tagName === "OPTION" ? e.closest("select") : e;
    const box = shown.getBoundingClientRect();
    return box.width > 0 && box.right > innerWidth + 0.5 ? [shown.tagName + " " + box.right] : [];
  })`);

/** Closes an agent at the generation the daemon has for it now. */
async function closeAgent(page: Page, id: string): Promise<void> {
  const state: unknown = await (await page.request.get("/v1/state")).json();
  const agents: unknown = Reflect.get(Object(state), "agents");
  const found: unknown = Array.isArray(agents)
    ? agents.find((x: unknown) => Reflect.get(Object(x), "id") === id)
    : undefined;
  await post(page, `/v1/agents/${id}/close`, {
    generation: Reflect.get(Object(found), "generation"),
  });
}

test("fits a 40-character name on a phone, wherever the agent is shown", async ({ browser }) => {
  const page = await (await browser.newContext(IPHONE.options)).newPage();
  await page.goto("/");
  // Nowhere to break it: 31 letters, `-`, and the eight of a base-36 time.
  const name = uniqueName("n".repeat(31));
  expect(name).toHaveLength(40);
  const launched = await post(page, "/v1/agents", { harness: "claude-code", cwd: WORK, name });
  const longId = String(Reflect.get(Object(launched), "agentId"));
  // Later files expect no open task and only their own agents, whatever happens here.
  try {
    const made = await post(page, "/v1/tasks", {
      title: "Long names",
      brief: "Fit a phone.",
      assign: { agentId: longId, role: "worker" },
    });
    const taskId = String(Reflect.get(Object(made), "taskId"));
    try {
      for (const hash of [`#/agent/${longId}`, "", "#/tasks", `#/task/${taskId}`]) {
        await page.goto(`/${hash}`);
        // A phone shows one pane, so the name is also in the hidden rail, and in a picker's options.
        await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
        await dismissThemeNotice(page);
        await expect
          .poll(
            async () => ({ page: await overflow(page), cut: await pastRightEdge(page, name) }),
            { message: hash },
          )
          .toEqual({ page: { down: 0, across: 0 }, cut: [] });
      }
    } finally {
      await post(page, `/v1/tasks/${taskId}/finish`, { outcome: "cancelled" });
    }
  } finally {
    await closeAgent(page, longId);
    await page.context().close();
  }
});

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

test("offers to close the soft keyboard from the key bar while it is up, and closes it", async ({
  browser,
}) => {
  const { page } = await typingInShell(browser, phone(390, 844));
  const done = page.getByRole("button", { name: "Close keyboard" });
  await expect(done).toBeHidden();
  await page.evaluate("bazhenKeyboard(340)");
  await done.tap();
  await expect
    .poll(() => page.evaluate<boolean>(`document.activeElement?.closest(".terminal-host") != null`))
    .toBe(false);
  await page.context().close();
});

/**
 * Drags from the middle of `selector`'s element by `dy`, with `fingers`, as touch events; answers
 * whether the page kept the drag from moving it.
 */
const dragPrevented = (page: Page, selector: string, dy: number, fingers = 1) =>
  page.evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const box = el.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const touches = (dy) =>
      Array.from({ length: ${fingers} }, (_, i) =>
        new Touch({ identifier: i, target: el, clientX: x + i * 40, clientY: y + dy }));
    const init = (dy) => ({ bubbles: true, cancelable: true, touches: touches(dy) });
    el.dispatchEvent(new TouchEvent("touchstart", init(0)));
    const move = new TouchEvent("touchmove", init(${dy}));
    el.dispatchEvent(move);
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }));
    return move.defaultPrevented;
  })()`);

test("keeps a drag over what can't scroll from moving the page, but not a pinch or a text field", async ({
  browser,
}) => {
  const page = await open(browser, phone(390, 844), `#/agent/${agentId}`);
  // The key bar scrolls sideways at this width, which mustn't let a drag up start a page pan.
  const overflows = `(() => { const bar = document.querySelector(".key-bar");
    return bar.scrollWidth > bar.clientWidth; })()`;
  expect([
    await page.evaluate<boolean>(overflows),
    await dragPrevented(page, ".key-bar", -40),
    await dragPrevented(page, ".key-bar", -3),
    await dragPrevented(page, ".key-bar", -40, 2),
    await dragPrevented(page, ".workspace-info input", -40),
  ]).toEqual([true, true, true, false, false]);
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

/** Whether the second terminal, the dock's shell, sits wholly to the right of the TUI. */
async function dockBeside(page: Page): Promise<boolean> {
  const [tui, shell] = await terminalBoxes(page);
  return tui !== undefined && shell !== undefined && shell.x >= tui.x + tui.width;
}

test("sits the dock beside the TUI on a desktop too short to stack them", async ({ browser }) => {
  const page = await open(
    browser,
    { viewport: { width: 1280, height: 560 } },
    `#/agent/${agentId}`,
  );
  await expect(page.locator(".xterm-screen")).toHaveCount(2);
  expect([await dockBeside(page), await terminalsInView(page)]).toEqual([true, true]);
  await page.context().close();
});
