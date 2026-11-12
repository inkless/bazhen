import { expect, test } from "@playwright/test";

test("the web client shows the daemon's live health through the dev proxy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^\d+\.\d+$/ })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /tmux 3\./ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
