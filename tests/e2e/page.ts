import { expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

type Hook = "screen" | "viewportTop" | "alternate" | "background" | "foregrounds";

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

/** The background the terminal paints, as xterm.js's theme sets it. */
export async function terminalBackground(page: Page): Promise<string | null> {
  const colour = await read(page, "background");
  return typeof colour === "string" ? colour : null;
}

/** Each colour the terminal's text is written in: `#rrggbb`, a palette index, or `default`. */
export async function foregrounds(page: Page): Promise<string[]> {
  const colours = await read(page, "foregrounds");
  return Array.isArray(colours) ? colours.filter((c) => typeof c === "string") : [];
}

/** Ends the agent's process from outside, as a crash would, through the daemon's signal command. */
export function kill(page: Page, agentId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const agents: unknown = Reflect.get(Object(state), "agents");
    const agent: unknown = Array.isArray(agents)
      ? agents.find((a: unknown) => Reflect.get(Object(a), "id") === id)
      : undefined;
    const res = await fetch(`/v1/agents/${id}/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        generation: Reflect.get(Object(agent), "generation"),
        signal: "SIGKILL",
      }),
    });
    return res.status;
  }, agentId);
}

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
