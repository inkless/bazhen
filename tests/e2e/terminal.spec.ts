import { expect, test, type Page, type Request } from "@playwright/test";
import { foregrounds, openSecondView, screen, terminalBackground } from "./page.ts";

test("launches Claude Code from the page and types into its terminal", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  const terminal = page.getByRole("region", { name: "terminal" });
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
  await terminal.locator(".xterm-screen").click();
  await expect(terminal.getByText("Driving")).toBeVisible();
  await page.keyboard.type("typed in the browser");
  await expect.poll(() => screen(page)).toContain("typed in the browser");
});

test("says in words why it can't launch an agent in a directory", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill("relative/dir");
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    '"relative/dir" is not a full path: start it with / or ~/',
  );
});

const isLaunch = (r: Request) =>
  r.method() === "POST" && new URL(r.url()).pathname === "/v1/agents";

/** The painted background of the element xterm.js draws into. */
const hostBackground = (page: Page) =>
  page
    .getByRole("region", { name: "terminal" })
    .locator(":scope > div")
    .evaluate((e) => e.ownerDocument.defaultView?.getComputedStyle(e).backgroundColor);

/**
 * The greys the pinned Claude Code draws its secondary text in, at the 256 colours tmux gives it:
 * one per theme, so which one is on screen says which theme it started in.
 */
const CLAUDE_GREY = { dark: "246", light: "241" } as const;

/** Launches Claude Code from `page` and waits for its TUI. */
async function launchClaude(page: Page) {
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
}

test("recolours an open terminal with the theme and the system's scheme, on the same stream", async ({
  page,
  browser,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const streams: string[] = [];
  page.on("websocket", (ws) => streams.push(ws.url()));
  await launchClaude(page);
  const dark = await terminalBackground(page);
  const darkHost = await hostBackground(page);
  const opened = streams.length;

  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Light" }).click();
  await expect.poll(() => terminalBackground(page)).not.toBe(dark);
  const light = await terminalBackground(page);
  // Claude Code itself keeps the theme it started in, and the page says so.
  await expect(
    page.getByRole("status").filter({ hasText: "until they are respawned" }),
  ).toBeVisible();
  // The strip below the last row, which xterm.js doesn't paint, follows too.
  expect(await hostBackground(page)).not.toBe(darkHost);
  await theme.getByRole("radio", { name: "System" }).click();
  await expect.poll(() => terminalBackground(page)).toBe(dark);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => terminalBackground(page)).toBe(light);
  // The same view throughout: no stream opened since, its screen never redrawn from a snapshot.
  expect(streams).toHaveLength(opened);
  expect(await screen(page)).toContain("Claude Code");

  // A phone on the same terminal follows its own system's scheme.
  const phone = await openSecondView(browser, "Claude Code", {
    hasTouch: true,
    colorScheme: "dark",
  });
  expect(await terminalBackground(phone)).toBe(dark);
  await phone.close();
});

test("starts Claude Code in the theme of the page it is launched from", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const first = page.waitForRequest(isLaunch);
  await launchClaude(page);
  await expect.poll(() => foregrounds(page)).toContain(CLAUDE_GREY.dark);

  await page.emulateMedia({ colorScheme: "light" });
  const second = page.waitForRequest(isLaunch);
  await launchClaude(page);
  await expect.poll(() => foregrounds(page), { timeout: 20_000 }).toContain(CLAUDE_GREY.light);
  expect(await foregrounds(page)).not.toContain(CLAUDE_GREY.dark);
  expect([(await first).postDataJSON(), (await second).postDataJSON()]).toEqual([
    expect.objectContaining({ theme: "dark" }),
    expect.objectContaining({ theme: "light" }),
  ]);
});
