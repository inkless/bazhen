import { expect, test, type Page } from "@playwright/test";
import { launch, screen } from "./page.ts";

const workspace = (page: Page) => page.getByRole("article", { name: "agent" });
const dock = (page: Page) => workspace(page).getByRole("region", { name: "shells" });
const pane = (page: Page) => dock(page).getByRole("article", { name: /^shell / });

/** The shells the daemon has, oldest first, as the page's own state read gives them. */
const shellIds = (page: Page) =>
  page.evaluate(async () => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const shells: unknown = Reflect.get(Object(state), "shells");
    return Array.isArray(shells)
      ? shells.map((s: unknown) => String(Reflect.get(Object(s), "id")))
      : [];
  });

/** What runs in a shell's foreground, by name, as the page's own state read gives it. */
const foregroundOf = (page: Page, shellId: string) =>
  page.evaluate(async (id) => {
    const state: unknown = await (await fetch("/v1/state")).json();
    const shells: unknown = Reflect.get(Object(state), "shells");
    const found: unknown = Array.isArray(shells)
      ? shells.find((s: unknown) => Reflect.get(Object(s), "id") === id)
      : undefined;
    const command: unknown = Reflect.get(
      Object(Reflect.get(Object(found), "foreground")),
      "command",
    );
    return typeof command === "string" ? command : null;
  }, shellId);

/** Every shell open the page sends, as it sends them. */
function shellOpens(page: Page): string[] {
  const opens: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/v1/shells") opens.push(r.url());
  });
  return opens;
}

/** Opens a shell beside the agent from its dock and answers the new shell's id. */
async function openBeside(page: Page): Promise<string> {
  const before = await shellIds(page);
  await dock(page).getByRole("button", { name: "+ Shell here" }).click();
  await expect.poll(async () => (await shellIds(page)).length).toBe(before.length + 1);
  const shellId = String((await shellIds(page)).find((id) => !before.includes(id)));
  // Until its prompt draws, a login shell may still be running its profile in the foreground,
  // which a close counts as busy; the dock shows the new shell, so its prompt can be waited for.
  await expect.poll(() => screen(page, shellId), { timeout: 15_000 }).toMatch(/[$#%>] *$/m);
  return shellId;
}

/**
 * Types a line into a shell's terminal, as a person would at its prompt: the click that takes it
 * over is not sent to it, so typing waits until this view drives it.
 */
async function typeLine(page: Page, line: string): Promise<void> {
  const terminal = pane(page);
  await terminal.locator(".xterm-screen").click();
  await expect(terminal.getByText("Driving")).toBeVisible();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

test("opens a shell beside an agent, runs a command in it, and closes it, asking while one runs", async ({
  page,
}) => {
  await launch(page);
  const shellId = await openBeside(page);
  await typeLine(page, "echo hello-$((40+2))");
  await expect.poll(() => screen(page, shellId), { timeout: 15_000 }).toContain("hello-42");

  await typeLine(page, "sleep 300");
  await expect(dock(page).getByRole("tab")).toContainText("sleep", { timeout: 15_000 });
  await pane(page).getByRole("button", { name: "Close…" }).click();
  const confirm = page.getByRole("dialog", { name: "Close shell" });
  await expect(confirm).toContainText("sleep is running");
  await confirm.getByRole("button", { name: "Close anyway" }).click();
  await expect(dock(page).getByRole("tab")).toHaveCount(0);
  expect(await shellIds(page)).not.toContain(shellId);
});

test("closes an agent with its shells, but for the one kept, which goes on standalone", async ({
  page,
}) => {
  const agentId = await launch(page);
  const closing = await openBeside(page);
  const kept = await openBeside(page);
  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  const confirm = page.getByRole("dialog", { name: "Close agent" });
  const keep = confirm.getByRole("checkbox");
  await expect(keep).toHaveCount(2);
  await keep.last().check();
  const answer = page.waitForResponse((r) => r.url().endsWith(`/v1/agents/${agentId}/close`));
  await confirm.getByRole("button", { name: "Close agent" }).click();
  const response = await answer;
  expect([response.status(), await response.text()]).toEqual([200, expect.any(String)]);
  await expect.poll(() => shellIds(page), { timeout: 15_000 }).toEqual([kept]);
  expect(closing).not.toBe(kept);
});

test("refuses an agent close that would end a program started after its dialog opened", async ({
  page,
  browser,
}) => {
  const agentId = await launch(page);
  const shellId = await openBeside(page);
  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  const confirm = page.getByRole("dialog", { name: "Close agent" });
  await expect(confirm).not.toContainText("is running");

  // Another device starts a program in the shell while this one's dialog is open.
  const other = await (await browser.newContext()).newPage();
  await other.goto(`/#/agent/${agentId}`);
  await typeLine(other, "sleep 300");
  await expect.poll(() => foregroundOf(page, shellId), { timeout: 15_000 }).toBe("sleep");

  const answer = page.waitForResponse((r) => r.url().endsWith(`/v1/agents/${agentId}/close`));
  await confirm.getByRole("button", { name: "Close agent" }).click();
  const response = await answer;
  expect([response.status(), await response.json()]).toMatchObject([
    409,
    { error: "busy", busy: [{ terminalId: shellId, program: "sleep" }] },
  ]);
  await expect(page.getByRole("alert")).toContainText("sleep");
  expect(await shellIds(page)).toContain(shellId);
});

test("forgets the shells ticked to keep when its close dialog is cancelled", async ({ page }) => {
  await launch(page);
  await openBeside(page);
  const trigger = workspace(page).getByRole("button", { name: "Close agent…" });
  const confirm = page.getByRole("dialog", { name: "Close agent" });
  await trigger.click();
  await confirm.getByRole("checkbox").check();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await trigger.click();
  await expect(confirm.getByRole("checkbox")).not.toBeChecked();
});

test('opens one shell however fast "+ Shell here" is tapped twice', async ({ page }) => {
  await launch(page);
  const opens = shellOpens(page);
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/shells");
  await dock(page).getByRole("button", { name: "+ Shell here" }).dblclick();
  await first;
  await expect(dock(page).getByRole("tab")).toHaveCount(1);
  expect(opens).toHaveLength(1);
});
