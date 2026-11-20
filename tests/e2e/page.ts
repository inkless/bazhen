import { join } from "node:path";
import {
  test as playwrightTest,
  expect,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";
import { TmuxServer } from "@bazhen/host-guard";
import { answerPatched } from "../support/state-route.ts";
import { giveTranscript } from "../support/transcript.ts";
import { closableAgents, closeAgents, homeOf, isRuntime, type Runtime } from "./daemons.ts";

/** The options each project gives its tests: `home`, its daemon's. */
export interface DaemonOptions {
  readonly home: string;
}

/**
 * Playwright's test, closing the agents each test opened once it ends, and when its worker stops,
 * every agent still open on its daemon: those a `beforeAll` opened, and all of its project's
 * before the next project starts.
 *
 * Its page's routes stop before the test's context closes. The page goes on reading as a test
 * ends, and a route still awaiting `route.fetch` then fails with the context's close, charged to
 * whichever test the worker is running by then. A route that fails while the test runs still
 * fails it.
 */
export const test = playwrightTest.extend<
  { closesItsAgents: void },
  DaemonOptions & { closesAgentsLeft: void }
>({
  home: ["", { scope: "worker", option: true }],
  page: async ({ page }, use) => {
    await use(page);
    // Playwright refuses to unroute a page that is closed, and a test may close its own.
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
  },
  closesAgentsLeft: [
    async ({ home }, use) => {
      await use();
      await closeAgents(home, await closableAgents(home));
    },
    { scope: "worker", auto: true, timeout: 120_000 },
  ],
  closesItsAgents: [
    async ({ home }, use) => {
      const before = new Set((await closableAgents(home)).map(({ id }) => id));
      await use();
      await closeAgents(
        home,
        (await closableAgents(home)).filter(({ id }) => !before.has(id)),
      );
    },
    { auto: true, timeout: 30_000 },
  ],
});

export { expect };

/** The runtime the running test's daemon makes its terminals on: its project's name. */
export function runtime(): Runtime {
  const name = test.info().project.name;
  if (!isRuntime(name)) throw new Error(`project ${name} names no runtime`);
  return name;
}

/** The home of the running test's daemon. */
export const daemonHome = () => homeOf(runtime());

/**
 * The running test's daemon's private tmux server, by its socket in the daemon's home, as teardown
 * finds it. Refused on any other runtime, whose terminals tmux doesn't hold.
 */
export function daemonTmux(): TmuxServer {
  if (runtime() !== "tmux") throw new Error(`the ${runtime()} daemon has no tmux server`);
  const home = daemonHome();
  return TmuxServer.at(join(home, "run", "tmux.sock"), { root: home });
}

type Hook =
  | "screen"
  | "viewportTop"
  | "atBottom"
  | "alternate"
  | "gliding"
  | "background"
  | "foregrounds"
  | "fontFamily"
  | "cursor"
  | "grid";

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

/** A name no other agent of this run holds, so a retried test doesn't find its last one's. */
export const uniqueName = (base: string) => `${base}-${Date.now().toString(36)}`;

/**
 * Launches Claude Code from the page, under `name` if given, and waits for its TUI; answers the
 * agent's id.
 */
export async function launch(page: Page, name?: string): Promise<string> {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  if (name !== undefined) await page.locator(".launch").getByLabel("Name").fill(name);
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

/** The font family the terminal draws in, as xterm.js was given it. */
export async function terminalFontFamily(page: Page): Promise<string | null> {
  const family = await read(page, "fontFamily");
  return typeof family === "string" ? family : null;
}

/** The terminal's columns and rows, `120x40`, which follow the cell its font measures. */
export async function terminalGrid(page: Page, terminalId?: string): Promise<string | null> {
  const grid = await read(page, "grid", terminalId);
  return typeof grid === "string" ? grid : null;
}

export const terminalCursor = (page: Page, terminalId: string) => read(page, "cursor", terminalId);

/** Each of the page's bundled terminal faces, with whether it has loaded, failed or not started. */
export const bundledFaces = (page: Page): Promise<string[]> =>
  page.evaluate<string[]>(`[...document.fonts]
    .map((face) => [face, face.family.replaceAll('"', "")])
    .filter(([, family]) => family.startsWith("JetBrainsMono NFM"))
    .map(([face, family]) => family + " " + face.weight + " " + face.style + ": " + face.status)`);

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

/** The agent's terminal's generation, as the daemon's state says. */
export function generationOf(page: Page, agentId: string): Promise<unknown> {
  return page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const agents: unknown = Reflect.get(Object(state), "agents");
    const agent: unknown = Array.isArray(agents)
      ? agents.find((a: unknown) => Reflect.get(Object(a), "id") === id)
      : undefined;
    return Reflect.get(Object(agent), "generation");
  }, agentId);
}

/**
 * The attach command the page should show for the agent: tmux's, attaching its session, or a
 * holder's, `bazhen terminals attach` with the id of the agent's terminal.
 */
export async function attachCommandFor(page: Page, agentId: string): Promise<RegExp | string> {
  if (runtime() === "tmux") return / attach-session -t /;
  const terminalId = await page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const agents: unknown = Reflect.get(Object(state), "agents");
    const agent: unknown = Array.isArray(agents)
      ? agents.find((a: unknown) => Reflect.get(Object(a), "id") === id)
      : undefined;
    return String(Reflect.get(Object(agent), "terminalId"));
  }, agentId);
  return `bazhen terminals attach ${terminalId}`;
}

/**
 * Gives an agent's Claude Code session a conversation to resume, as its hooks would report it.
 * Its own TUI names a transcript it hasn't written, so only once that TUI has exited.
 */
export async function givePageAgentTranscript(page: Page, agentId: string): Promise<void> {
  const session = await page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const agents: unknown = Reflect.get(Object(state), "agents");
    const agent: unknown = Array.isArray(agents)
      ? agents.find((a: unknown) => Reflect.get(Object(a), "id") === id)
      : undefined;
    return String(Reflect.get(Object(Reflect.get(Object(agent), "externalRef")), "id"));
  }, agentId);
  await giveTranscript(daemonHome(), agentId, session);
}

/**
 * A terminal view's status as the page shows it. A screen reader hears it from a separate live
 * region, once it has held for a second.
 */
export const status = (within: Page | Locator) =>
  within.locator('section[aria-label="terminal"] > p[aria-hidden="true"]');

/** Shows the page the daemon's own state with `patch` applied, as if the daemon had reported it. */
export async function patchState(page: Page, patch: (state: object) => object): Promise<void> {
  await page.route("**/v1/state", (route) => answerPatched(route, patch));
}
