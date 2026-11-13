import { expect, test, type Page, type Request } from "@playwright/test";
import { foregrounds, kill, openSecondView, screen, terminalBackground } from "./page.ts";

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

const isRespawn = (r: Request) => r.method() === "POST" && r.url().endsWith("/respawn");
const isLaunch = (r: Request) =>
  r.method() === "POST" && new URL(r.url()).pathname === "/v1/agents";

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

test("draws an agent's terminal in the theme it started in, and respawns it in the page's", async ({
  page,
  browser,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const streams: string[] = [];
  page.on("websocket", (ws) => streams.push(ws.url()));
  await launchClaude(page);
  const agentId = new URL(page.url()).hash.replace("#/agent/", "");
  const dark = await terminalBackground(page);
  const opened = streams.length;

  // The page follows the switch; the terminal keeps the theme Claude Code was started in.
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await terminalBackground(page)).toBe(dark);
  expect(streams).toHaveLength(opened);
  const phone = await openSecondView(browser, "Claude Code", {
    hasTouch: true,
    colorScheme: "light",
  });
  expect(await terminalBackground(phone)).toBe(dark);
  await phone.close();

  // Claude Code reports no activity, so whether it is mid-turn can't be told: no respawn yet.
  const notice = page.getByRole("status", { name: "theme" });
  const row = notice.getByRole("listitem").filter({ hasText: agentId.slice(-6) });
  await expect(
    row.getByRole("button", { name: "Can't tell whether it's mid-turn" }),
  ).toBeDisabled();

  // Once it has exited, it respawns in light, behind the confirm.
  expect(await kill(page, agentId)).toBe(200);
  const respawn = row.getByRole("button", { name: "Respawn in light" });
  await expect(respawn).toBeEnabled({ timeout: 10_000 });
  await respawn.click();
  const respawned = page.waitForRequest(isRespawn);
  await page.getByRole("dialog").getByRole("button", { name: "Respawn in light" }).click();
  expect((await respawned).postDataJSON()).toMatchObject({ theme: "light" });
  // Its new incarnation is drawn light. (A Claude Code that never reached a model has no
  // conversation to resume, so what it draws here says nothing; the launch test covers that.)
  await expect.poll(() => terminalBackground(page), { timeout: 20_000 }).not.toBe(dark);
  await expect(row).toBeHidden();
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
