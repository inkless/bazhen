import { expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

type Hook = "screen" | "viewportTop" | "alternate";

/** Reads one of the terminal view's test hooks: the page shows one terminal at a time. */
const read = (page: Page, hook: Hook) =>
  page.evaluate((name) => {
    const views: unknown = Reflect.get(globalThis, "bazhenViews");
    const view: unknown = Object.values(Object(views))[0];
    const fn: unknown = Reflect.get(Object(view), name);
    return typeof fn === "function" ? (fn() as unknown) : undefined;
  }, hook);

/** The terminal's screen as text, read from xterm's buffer whichever renderer draws it. */
export async function screen(page: Page): Promise<string> {
  const text = await read(page, "screen");
  return typeof text === "string" ? text : "";
}

/** The buffer line at the top of the terminal's view: lower once it has scrolled back. */
export async function viewportTop(page: Page): Promise<number> {
  const top = await read(page, "viewportTop");
  return typeof top === "number" ? top : -1;
}

/** Whether the daemon has told the page the program is on its alternate screen. */
export const onAlternateScreen = async (page: Page) => (await read(page, "alternate")) === true;

/** A second device: another browser opened on the newest agent's terminal, showing `text`. */
export async function openSecondView(
  browser: Browser,
  text: string,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const page = await (await browser.newContext(options)).newPage();
  await page.goto("/");
  await page.getByRole("list", { name: "agents" }).getByRole("button").last().click();
  await expect.poll(() => screen(page)).toContain(text);
  return page;
}
