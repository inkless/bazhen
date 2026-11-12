import { expect, test } from "@playwright/test";

test("launches Claude Code from the page and types into its terminal", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  const terminal = page.getByRole("region", { name: "terminal" });
  const screen = terminal.locator(".xterm-rows");
  await expect(screen).toContainText("Claude Code", { timeout: 20_000 });
  await terminal.locator(".xterm-screen").click();
  await expect(terminal.getByText("Driving")).toBeVisible();
  await page.keyboard.type("typed in the browser");
  await expect(screen).toContainText("typed in the browser");
});
