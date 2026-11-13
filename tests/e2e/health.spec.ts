import { expect, test } from "@playwright/test";

test("the web client shows the daemon's live health through the dev proxy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^\d+\.\d+$/ })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /tmux 3\./ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a device's stored theme overrides the system's before the page draws", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  // Runs in the page, which has the DOM this package's types leave out.
  const background = () => page.evaluate("getComputedStyle(document.body).backgroundColor");
  const light = await background();

  await page.evaluate(() => localStorage.setItem("bazhen.theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(light);
});
