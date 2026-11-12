import { expect, type Browser, type Page } from "@playwright/test";

/** The terminal's screen as text, read from xterm's buffer whichever renderer draws it. */
export const screen = (page: Page) =>
  page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "bazhenScreen");
    return typeof read === "function" ? String(read()) : "";
  });

/** The buffer line at the top of the terminal's view: lower once it has scrolled back. */
export const viewportTop = (page: Page) =>
  page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "bazhenViewport");
    return typeof read === "function" ? Number(read()) : -1;
  });

/** A second device: another browser opened on the newest agent's terminal, showing `text`. */
export async function openSecondView(browser: Browser, text: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("list", { name: "agents" }).getByRole("button").last().click();
  await expect.poll(() => screen(page)).toContain(text);
  return page;
}
