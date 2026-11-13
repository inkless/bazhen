import { expect, test } from "@playwright/test";

test("the web client shows the daemon's live health through the dev proxy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^\d+\.\d+$/ })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /tmux 3\./ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a device's pinned theme is set before the app's script runs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript({ content: `localStorage.setItem("bazhen.theme", "dark");` });
  // With the app's module never loading, only the page's head can have set it.
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("the page still loads, in the system's theme, when site data is blocked", async ({ page }) => {
  // As Safari does with all cookies blocked: reading localStorage throws.
  await page.addInitScript({
    content: `Object.defineProperty(window, "localStorage", {
      get() { throw new DOMException("blocked", "SecurityError"); },
    });`,
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});
