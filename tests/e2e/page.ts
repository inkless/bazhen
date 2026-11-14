import {
  expect,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";
import { giveTranscript } from "../support/transcript.ts";

type Hook =
  | "screen"
  | "viewportTop"
  | "atBottom"
  | "alternate"
  | "gliding"
  | "background"
  | "foregrounds";

/**
 * Reads one of a terminal view's test hooks: `terminalId`'s, or with none the page's first, as
 * when it shows a single terminal.
 */
const read = (page: Page, hook: Hook, terminalId?: string) =>
  page.evaluate(
    ([name, id]) => {
      const views: unknown = Reflect.get(globalThis, "bazhenViews");
      const view: unknown =
        id === undefined ? Object.values(Object(views))[0] : Reflect.get(Object(views), id);
      const fn: unknown = Reflect.get(Object(view), name);
      return typeof fn === "function" ? (fn() as unknown) : undefined;
    },
    [hook, terminalId] as const,
  );

/** A terminal's screen as text, read from xterm's buffer whichever renderer draws it. */
export async function screen(page: Page, terminalId?: string): Promise<string> {
  const text = await read(page, "screen", terminalId);
  return typeof text === "string" ? text : "";
}

/** Launches Claude Code from the page and waits for its TUI; answers the agent's id. */
export async function launch(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
  return new URL(page.url()).hash.replace("#/agent/", "");
}

/** The buffer line at the top of the terminal's view: lower once it has scrolled back. */
export async function viewportTop(page: Page, terminalId?: string): Promise<number> {
  const top = await read(page, "viewportTop", terminalId);
  return typeof top === "number" ? top : -1;
}

/** Whether the view shows the terminal's live screen, not the page's scrollback above it. */
export const atBottom = async (page: Page, terminalId?: string) =>
  (await read(page, "atBottom", terminalId)) === true;

/** Whether a released swipe is still carrying the terminal on. */
export const gliding = async (page: Page, terminalId?: string) =>
  (await read(page, "gliding", terminalId)) === true;

/** Whether the daemon has told the page the program is on its alternate screen. */
export const onAlternateScreen = async (page: Page, terminalId?: string) =>
  (await read(page, "alternate", terminalId)) === true;

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

/**
 * Gives an agent's Claude Code session a conversation to resume, as its hooks would report it.
 * Its own TUI names a transcript it hasn't written, so only once that TUI has exited.
 */
export async function givePageAgentTranscript(page: Page, agentId: string): Promise<void> {
  const { session, protocolVersion } = await page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const agents: unknown = Reflect.get(Object(state), "agents");
    const agent: unknown = Array.isArray(agents)
      ? agents.find((a: unknown) => Reflect.get(Object(a), "id") === id)
      : undefined;
    const health: unknown = await (await fetch("/v1/health")).json();
    return {
      session: String(Reflect.get(Object(Reflect.get(Object(agent), "externalRef")), "id")),
      protocolVersion: String(Reflect.get(Object(health), "protocolVersion")),
    };
  }, agentId);
  await giveTranscript(String(process.env["BZ_E2E_HOME"]), protocolVersion, agentId, session);
}

/**
 * A terminal view's status as the page shows it. A screen reader hears it from a separate live
 * region, once it has held for a second.
 */
export const status = (within: Page | Locator) =>
  within.locator('section[aria-label="terminal"] > p[aria-hidden="true"]');
