import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { TmuxServer } from "@bazhen/host-guard";
import { readKeyLog } from "../support/key-log.ts";
import { onAlternateScreen, openSecondView, screen, viewportTop, status } from "./page.ts";

// The page's terminal against the real daemon and tmux. Each test launches an agent from the page,
// then runs a key probe in its terminal in place of the agent: the probe logs exactly the bytes
// the program receives, and the page's outgoing WebSocket frames show what the browser sent.

const probe = fileURLToPath(new URL("../support/key-probe.ts", import.meta.url));
const work = String(process.env["BZ_E2E_WORK"]);

/** The daemon's private tmux server, by its socket in the run's own home, as teardown finds it. */
function tmux(...args: string[]): string {
  const home = String(process.env["BZ_E2E_HOME"]);
  return TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).runSync(args);
}

function sessionOf(agentId: string): string {
  const line = tmux("list-panes", "-a", "-F", "#{@bazhen_agent_id} #{session_name}")
    .split("\n")
    .find((l) => l.startsWith(`${agentId} `));
  if (line === undefined) throw new Error(`no session for ${agentId}`);
  return line.split(" ")[1] ?? "";
}

/** The id of the agent launched last, from the daemon's state. */
function newestAgentId(state: unknown): string {
  const agents: unknown = Reflect.get(Object(state), "agents");
  const id: unknown = Array.isArray(agents) ? Reflect.get(Object(agents.at(-1)), "id") : undefined;
  if (typeof id !== "string") throw new Error("the daemon's state lists no agent");
  return id;
}

async function terminalBox(page: Page) {
  const box = await page
    .getByRole("region", { name: "terminal" })
    .locator(".xterm-screen")
    .boundingBox();
  if (box === null) throw new Error("no terminal on the page");
  return box;
}

interface Probe {
  readonly agentId: string;
  readonly session: string;
  /** What the program received since `since`, as hex. */
  received(since: number): string;
  /** Binary frames the page sent: what the browser typed, or answered. */
  readonly sent: Buffer[];
  /** Each stream the page opened, when it opened and when it closed. */
  readonly sockets: readonly { opened: number; closed?: number }[];
}

/** Launches an agent from the page and runs the key probe in its terminal instead. */
async function launchProbe(page: Page, ...options: string[]): Promise<Probe> {
  const sent: Buffer[] = [];
  const sockets: { opened: number; closed?: number }[] = [];
  page.on("websocket", (ws) => {
    // The dev server's hot-reload socket is not a terminal's.
    if (!ws.url().includes("/v1/terminals/")) return;
    const socket: { opened: number; closed?: number } = { opened: Date.now() };
    sockets.push(socket);
    ws.on("close", () => (socket.closed = Date.now()));
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") sent.push(payload);
    });
  });
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(work);
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect(page.getByRole("region", { name: "terminal" })).toBeVisible();
  const agentId = newestAgentId(await (await page.request.get("/v1/state")).json());
  const session = sessionOf(agentId);
  const log = join(work, `keys-${agentId}.log`);
  tmux("respawn-pane", "-k", "-t", `${session}:0`, process.execPath, probe, log, ...options);
  await expect.poll(() => screen(page), { timeout: 10_000 }).toContain("key-probe ready");
  const received = (since: number) =>
    readKeyLog(log)
      .filter((a) => a.at >= since)
      .map((a) => a.hex)
      .join("");
  return { agentId, session, received, sent, sockets };
}

/**
 * Opens the page afresh on the same terminal. Output printed while a view is open can reach it as
 * a redraw of the final screen rather than as lines: tmux does that for fast output. A view that
 * opens afterwards gets the lines from tmux's history.
 */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole("list", { name: "agents" }).getByRole("button").last().click();
  await expect.poll(() => screen(page), { timeout: 10_000 }).toContain("key-probe ready");
}

async function drive(page: Page): Promise<void> {
  await page.getByRole("region", { name: "terminal" }).locator(".xterm-screen").click();
  await expect(status(page)).toHaveText("Driving");
}

/**
 * How long after the lost stream closed its replacement opened: the last two streams, since
 * React's development mode opens and drops one more as the page mounts.
 */
function reattachDelay(sockets: Probe["sockets"]): number {
  const [lost, replacement] = sockets.slice(-2);
  if (lost?.closed === undefined || replacement === undefined) return Number.POSITIVE_INFINITY;
  return replacement.opened - lost.closed;
}

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

/**
 * Passes every terminal stream the page opens through the test. `silenceNewest` cuts the latest
 * both ways, as a laptop's socket is after it sleeps: open as far as the page can tell, reaching
 * nothing.
 */
async function routeStreams(page: Page) {
  const streams: { silent: boolean }[] = [];
  await page.routeWebSocket(/\/v1\/terminals\//, (ws) => {
    const stream = { silent: false };
    streams.push(stream);
    const server = ws.connectToServer();
    ws.onMessage((message) => stream.silent || server.send(message));
    server.onMessage((message) => stream.silent || ws.send(message));
    // A dead socket's close never reaches the daemon either: it keeps the attachment, whose
    // pings the test's own connection goes on answering.
    ws.onClose(() => stream.silent || server.close());
    server.onClose(() => ws.close());
  });
  return {
    count: () => streams.length,
    silenceNewest: () => {
      const newest = streams.at(-1);
      if (newest === undefined) throw new Error("the page opened no terminal stream");
      newest.silent = true;
    },
  };
}

/** What a view that drove shows once another view, on the device every spec pairs as, takes the lease. */
const TAKEN_OVER = "Viewing — e2e is driving";

test("sends ESC CR for Shift+Enter, and a plain CR for Enter", async ({ page }) => {
  const program = await launchProbe(page);
  await drive(page);
  const since = Date.now();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Enter");
  await expect.poll(() => program.received(since)).toBe(hex("\x1b\r\r"));
});

test("sends the wheel as mouse reports to a program that asked for them", async ({ page }) => {
  const program = await launchProbe(page, "--mouse");
  await drive(page);
  const since = Date.now();
  await page.mouse.wheel(0, -100);
  await expect.poll(() => program.received(since)).toContain(hex("\x1b[<64;"));
});

test("scrolls the page's own scrollback on the normal screen, sending nothing", async ({
  page,
}) => {
  const program = await launchProbe(page, "--lines=200");
  await reopen(page);
  await drive(page);
  const [top, before] = [await viewportTop(page), program.sent.length];
  await page.mouse.wheel(0, -400);
  await expect.poll(() => viewportTop(page)).toBeLessThan(top);
  expect(program.sent.length).toBe(before);
});

test("sends nothing for the wheel over an agent on its alternate screen", async ({ page }) => {
  const program = await launchProbe(page, "--lines=200", "--alternate-on-key");
  await reopen(page);
  await drive(page);
  await page.keyboard.type("!");
  await expect.poll(() => onAlternateScreen(page)).toBe(true);
  const [top, before, since] = [await viewportTop(page), program.sent.length, Date.now()];
  await page.mouse.wheel(0, -400);
  // Input is delivered in order: once this key arrives, anything the wheel sent has too.
  await page.keyboard.type("s");
  await expect.poll(() => program.received(since)).toContain(hex("s"));
  expect([await viewportTop(page), program.sent.length, program.received(since)]).toEqual([
    top,
    before + 1,
    hex("s"),
  ]);
});

test("scrolls the scrollback with a swipe on a touch screen", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await launchProbe(page, "--lines=200");
  await reopen(page);
  const box = await terminalBox(page);
  const top = await viewportTop(page);
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2;
  const at = (y: number) => [{ x, y }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(box.y + 20) });
  for (let step = 1; step <= 10; step++) {
    const touchPoints = at(box.y + 20 + step * 30);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => viewportTop(page)).toBeLessThan(top);
  await context.close();
});

test("moves the lease to the view clicked on another device, and its first key arrives", async ({
  page,
  browser,
}) => {
  const program = await launchProbe(page);
  await drive(page);
  const phone = await openSecondView(browser, "key-probe ready");
  await drive(phone);
  await expect(status(page)).toContainText(TAKEN_OVER);
  // Read out to a screen reader too, once it has held for a second.
  await expect(page.locator('section[aria-label="terminal"] [aria-live="polite"]')).toContainText(
    TAKEN_OVER,
  );
  const since = Date.now();
  await phone.keyboard.type("x");
  await expect.poll(() => program.received(since)).toContain(hex("x"));
  await phone.context().close();
});

test("leaves the lease where it is when a view that isn't driving loses focus", async ({
  page,
  browser,
}) => {
  const program = await launchProbe(page);
  await drive(page);
  const phone = await openSecondView(browser, "key-probe ready");
  await drive(phone);
  await expect(status(page)).toContainText(TAKEN_OVER);
  // xterm.js reports losing focus, as tmux asked it to, and the report must not take the lease.
  await page.getByRole("textbox", { name: "Terminal input" }).blur();
  const since = Date.now();
  await phone.keyboard.type("k");
  await expect.poll(() => program.received(since)).toContain(hex("k"));
  await expect(status(phone)).toHaveText("Driving");
  await phone.context().close();
});

test("takes the lease when its window gains focus", async ({ page, browser }) => {
  await launchProbe(page);
  await drive(page);
  const phone = await openSecondView(browser, "key-probe ready");
  await phone.evaluate('window.dispatchEvent(new FocusEvent("focus"))');
  await expect(status(phone)).toHaveText("Driving");
  await expect(status(page)).toContainText(TAKEN_OVER);
  await phone.context().close();
});

test("scrolls a watching phone on a swipe without taking the lease, and takes it on a tap", async ({
  page,
  browser,
}) => {
  const program = await launchProbe(page, "--lines=200");
  await reopen(page);
  await drive(page);
  const phone = await openSecondView(browser, "key-probe ready", { hasTouch: true });
  const box = await terminalBox(phone);
  const cdp = await phone.context().newCDPSession(phone);
  const at = (y: number) => [{ x: box.x + box.width / 2, y }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(box.y + 20) });
  for (let step = 1; step <= 10; step++) {
    const touchPoints = at(box.y + 20 + step * 30);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const since = Date.now();
  await page.keyboard.type("w");
  await expect.poll(() => program.received(since)).toContain(hex("w"));
  await expect(status(page)).toHaveText("Driving");
  await phone.locator(".xterm-screen").tap();
  await expect(status(phone)).toHaveText("Driving");
  // Tapped again once the laptop has taken over: the phone keeps focus, so no focus event fires.
  await page.locator(".xterm-screen").click();
  await expect(status(phone)).toContainText(TAKEN_OVER);
  await phone.locator(".xterm-screen").tap();
  await expect(status(phone)).toHaveText("Driving");
  await phone.context().close();
});

test("reattaches after the daemon's tmux client is lost, at once, and drives again", async ({
  page,
}) => {
  const program = await launchProbe(page);
  await drive(page);
  tmux("detach-client", "-s", program.session);
  await expect(status(page)).toHaveText("Reconnecting…");
  // The page still has focus, which no event will announce again: it claims the lease itself.
  await expect(status(page)).toHaveText("Driving", { timeout: 10_000 });
  // One backoff step, 250 ms, not two: the lost socket is retried once.
  expect(reattachDelay(program.sockets)).toBeLessThan(450);
  const since = Date.now();
  await page.keyboard.type("y");
  await expect.poll(() => program.received(since)).toContain(hex("y"));
});

test("gives up a socket that went silent, drops what was typed on it, and drives again", async ({
  page,
}) => {
  const streams = await routeStreams(page);
  await page.clock.install();
  const program = await launchProbe(page);
  await drive(page);
  const opened = streams.count();
  streams.silenceNewest();
  const before = Date.now();
  await page.keyboard.type("z");
  // Two heartbeats: a ping, then a beat that finds it unanswered, which the view warns of.
  await page.clock.runFor(15_000);
  await expect(status(page)).toHaveText("Checking the connection…");
  // The second miss gives the socket up.
  await page.clock.runFor(20_000);
  await expect.poll(() => streams.count(), { timeout: 10_000 }).toBeGreaterThan(opened);
  await expect(status(page)).toHaveText("Driving", { timeout: 10_000 });
  await page.keyboard.type("y");
  await expect.poll(() => program.received(before)).toContain(hex("y"));
  // `z` went only into the silenced stream: this holds as long as nothing types it again on the new one.
  expect(program.received(before)).not.toContain(hex("z"));
});

test("comes back from a silent socket without taking the lease from a view that took it", async ({
  page,
  browser,
}) => {
  const streams = await routeStreams(page);
  await page.clock.install();
  const program = await launchProbe(page);
  await drive(page);
  const opened = streams.count();
  streams.silenceNewest();
  const phone = await openSecondView(browser, "key-probe ready");
  await drive(phone);
  await page.clock.runFor(35_000);
  await expect.poll(() => streams.count(), { timeout: 10_000 }).toBeGreaterThan(opened);
  // Back, focused, and told another view drives: it waits for the user rather than taking over.
  await expect(status(page)).toContainText(TAKEN_OVER, { timeout: 10_000 });
  const since = Date.now();
  await phone.keyboard.type("p");
  await expect.poll(() => program.received(since)).toContain(hex("p"));
  await expect(status(phone)).toHaveText("Driving");
  await phone.context().close();
});

test("answers none of tmux's terminal queries itself", async ({ page }) => {
  const program = await launchProbe(page);
  // The queries come first on the stream, so by the time the probe's text shows, they are parsed.
  expect(program.sent).toEqual([]);
});
