import { expect, test } from "@playwright/test";
import { dismissNotices, issueCode } from "./pairing.ts";

test.use({ storageState: { cookies: [], origins: [] } });
// Each test pairs a browser, whose notice would otherwise stay open into the next spec's inbox.
test.afterEach(() => dismissNotices());

test("an unpaired browser sees only the pairing form, and pairs with a code", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Run bazhen devices pair in a terminal and enter the code"),
  ).toBeVisible();
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

test("shows a browser its own pairing in the inbox, which only this machine can dismiss", async ({
  page,
}) => {
  await page.goto("/");
  const code = await issueCode();
  await page.getByLabel("Code").fill(code);
  await page.getByLabel("Device name").fill("Own phone");
  await page.getByRole("button", { name: "Pair" }).click();
  await page.getByRole("button", { name: "Inbox (1)" }).click();
  const notices = page.getByRole("list", { name: "notices" });
  await expect(notices.getByRole("listitem")).toHaveText([/New device.*Own phone/]);
  await expect(notices.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(notices).toContainText("bazhen devices dismiss dev_");
  await dismissNotices();
  await page.reload();
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("list", { name: "notices" })).toHaveCount(0);
});
