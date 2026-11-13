import { expect, test } from "@playwright/test";
import { issueCode } from "./pairing.ts";

test.use({ storageState: { cookies: [], origins: [] } });

test("an unpaired browser sees only the pairing form, and pairs with a code", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Run bazhen pair in a terminal and enter the code")).toBeVisible();
  await expect(page.getByRole("term")).toHaveCount(0);

  await page.getByLabel("Code").fill("AAAA-AAAA");
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("alert")).toHaveText(/wrong or has expired/);

  const code = await issueCode();
  await page.getByLabel("Code").fill(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase());
  await page.getByLabel("Device name").fill("Test phone");
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
});
