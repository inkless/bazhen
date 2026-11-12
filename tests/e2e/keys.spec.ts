import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { readKeyLog } from "../support/key-log.ts";
import { openSecondView, screen, viewportTop } from "./page.ts";

// The page's terminal against the real daemon and tmux. Each test launches an agent from the page,
// then runs a key probe in its terminal in place of the agent: the probe logs exactly the bytes
// the program receives, and the page's outgoing WebSocket frames show what the browser sent.

const probe = fileURLToPath(new URL("../support/key-probe.ts", import.meta.url));
const work = String(process.env["BZ_E2E_WORK"]);

function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-L", String(process.env["BZ_E2E_SOCKET"]), ...args], {
    env: { ...process.env, TMUX: "" },
  }).toString();
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
}

/** Launches an agent from the page and runs the key probe in its terminal instead. */
async function launchProbe(page: Page, ...options: string[]): Promise<Probe> {
  const sent: Buffer[] = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") sent.push(payload);
    }),
  );
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
  return { agentId, session, received, sent };
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
  await expect(page.getByText("Driving")).toBeVisible();
}

const hex = (text: string) => Buffer.from(text, "latin1").toString("hex");

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
  await expect.poll(() => screen(page)).toContain("on the alternate screen");
  // The daemon tells the page about the alternate screen once the output settles.
  await page.waitForTimeout(500);
  const [top, before, since] = [await viewportTop(page), program.sent.length, Date.now()];
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  expect([await viewportTop(page), program.sent.length, program.received(since)]).toEqual([
    top,
    before,
    "",
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
  await expect(page.getByText("Viewing — click to type")).toBeVisible();
  const since = Date.now();
  await phone.keyboard.type("x");
  await expect.poll(() => program.received(since)).toBe(hex("x"));
  await phone.context().close();
});

test("leaves the lease where it is when a view that isn't driving loses focus", async ({
  page,
  browser,
}) => {
  await launchProbe(page);
  await drive(page);
  const phone = await openSecondView(browser, "key-probe ready");
  await drive(phone);
  await expect(page.getByText("Viewing — click to type")).toBeVisible();
  // xterm.js reports losing focus, as tmux asked it to, and the report must not take the lease.
  await page.getByRole("textbox", { name: "Terminal input" }).blur();
  await page.waitForTimeout(300);
  await expect(phone.getByText("Driving")).toBeVisible();
  await phone.context().close();
});

test("reattaches after the daemon's tmux client is lost, and drives again at once", async ({
  page,
}) => {
  const program = await launchProbe(page);
  await drive(page);
  tmux("detach-client", "-s", program.session);
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  // The page still has focus, which no event will announce again: it claims the lease itself.
  await expect(page.getByText("Driving")).toBeVisible({ timeout: 10_000 });
  const since = Date.now();
  await page.keyboard.type("y");
  await expect.poll(() => program.received(since)).toBe(hex("y"));
});

test("answers none of tmux's terminal queries itself", async ({ page }) => {
  const program = await launchProbe(page);
  await page.waitForTimeout(500);
  expect(program.sent).toEqual([]);
});
