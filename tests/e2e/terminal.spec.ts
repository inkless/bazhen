import { expect, test } from "@playwright/test";
import { screen } from "./page.ts";

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
