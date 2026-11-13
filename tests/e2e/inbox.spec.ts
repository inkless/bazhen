import { expect, test, type Page } from "@playwright/test";
import { screen } from "./page.ts";

// The page goes on reading its state as a test ends, and a route still fetching then would fail
// the test after its assertions passed.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Launches Claude Code from the page and waits for its TUI; answers the agent's id. */
async function launch(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
  return new URL(page.url()).hash.replace("#/agent/", "");
}

let serial = 0;
const item = (agentId: string, kind: string, summary: string, actions: string[]) => ({
  id: `attn_0190000000007000800000000000${String(++serial).padStart(4, "0")}`,
  agentId,
  state: "open",
  closeReason: null,
  summary,
  kind,
  taskId: null,
  messageId: null,
  // Each one opened a minute before the last, so the newest-first order is fixed.
  openedAt: new Date(Date.now() - serial * 60_000).toISOString(),
  actions,
});

/** Shows the page the daemon's own state with these items added, as if harnesses had raised them. */
async function injectItems(page: Page, items: object[]): Promise<void> {
  await page.route("**/v1/state", async (route) => {
    const res = await route.fetch();
    const state: unknown = await res.json();
    const attention: unknown = Reflect.get(Object(state), "attention");
    await route.fulfill({
      response: res,
      json: {
        ...Object(state),
        attention: [...(Array.isArray(attention) ? attention : []), ...items],
      },
    });
  });
}

/** Shows these items, and answers each action on them; answers what the page sent, by path. */
async function withItems(page: Page, items: object[]): Promise<Map<string, unknown>> {
  await injectItems(page, items);
  const sent = new Map<string, unknown>();
  await page.route("**/v1/attention/*/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    sent.set(path, route.request().postDataJSON());
    const messageId = path.endsWith("/reply") ? "msg_01900000000070008000000000000001" : undefined;
    await route.fulfill({ json: { eventIds: [1], ...(messageId && { messageId }) } });
  });
  return sent;
}

test("answers what needs the human from the inbox, the most urgent first, each as offered", async ({
  page,
}) => {
  const agentId = await launch(page);
  const failed = item(agentId, "undeliverable", "A message could not be delivered", [
    "reply",
    "resend",
    "dismiss",
  ]);
  const approval = item(agentId, "approval", "Bash: rm -rf build", ["allow", "deny"]);
  const question = item(agentId, "question", "Which database?", []);
  const sent = await withItems(page, [failed, approval, question]);
  await page.reload();

  await page.getByRole("button", { name: "Inbox (3)" }).click();
  const inbox = page.getByRole("list", { name: "open items" });
  await expect(inbox.getByRole("listitem")).toHaveText([/Approval/, /Question/, /Not delivered/]);
  // Each row offers exactly what the daemon listed for it, and nothing it didn't.
  const buttons = (name: RegExp) =>
    inbox.getByRole("listitem", { name }).getByRole("button").allTextContents();
  expect([
    await buttons(/Approval/),
    await buttons(/Question/),
    await buttons(/Not delivered/),
  ]).toEqual([
    [expect.any(String), "Allow", "Deny"],
    [expect.any(String), "Open terminal"],
    [expect.any(String), "Reply with new text", "Send the message again", "Dismiss"],
  ]);

  await inbox
    .getByRole("listitem", { name: /Approval/ })
    .getByRole("button", { name: "Allow" })
    .click();
  const undelivered = inbox.getByRole("listitem", { name: /Not delivered/ });
  await expect(undelivered.getByRole("button", { name: "Send the message again" })).toBeVisible();
  await undelivered.getByRole("button", { name: "Reply with new text" }).click();
  await undelivered.getByLabel("Reply").fill("Try again later");
  await undelivered.getByRole("button", { name: "Send reply" }).click();
  await expect
    .poll(() => [
      Reflect.get(Object(sent.get(`/v1/attention/${approval.id}/answer`)), "decision"),
      Reflect.get(Object(sent.get(`/v1/attention/${failed.id}/reply`)), "body"),
    ])
    .toEqual(["allow", "Try again later"]);

  const asked = inbox.getByRole("listitem", { name: /Question/ });
  await expect(asked).toContainText("Answer in the terminal.");
  await asked.getByRole("button", { name: "Open terminal" }).click();
  await expect(page).toHaveURL(new RegExp(`#/agent/${agentId}$`));
  await expect(page.getByRole("list", { name: "needs you" }).getByRole("listitem")).toHaveCount(3);
});

test("holds a row's actions while its answer is on its way, and gives them back after a refusal", async ({
  page,
}) => {
  const agentId = await launch(page);
  const approval = item(agentId, "approval", "Bash: make release", ["allow", "deny"]);
  await injectItems(page, [approval]);
  const held = Promise.withResolvers<void>();
  let answers = 0;
  await page.route("**/v1/attention/*/answer", async (route) => {
    answers++;
    await held.promise;
    await route.fulfill({
      status: 409,
      json: { error: "conflict", message: "already answered in the terminal" },
    });
  });
  await page.goto("/#/inbox");
  const row = page.getByRole("list", { name: "open items" }).getByRole("listitem");
  await row.getByRole("button", { name: "Allow" }).click();
  await expect(row.getByRole("button", { name: "Allow" })).toBeDisabled();
  await row.getByRole("button", { name: "Deny" }).click({ force: true });
  held.resolve();
  await expect(page.getByRole("alert")).toHaveText("already answered in the terminal");
  await expect(row.getByRole("button", { name: "Allow" })).toBeEnabled();
  expect(answers).toBe(1);
});

test("fits a phone's width, and marks the inbox as the page shown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const agentId = await launch(page);
  const failed = item(agentId, "undeliverable", "A message could not be delivered", [
    "reply",
    "resend",
    "dismiss",
  ]);
  await withItems(page, [failed]);
  await page.goto("/#/inbox");
  const inboxLink = page.getByRole("button", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAttribute("aria-current", "page");
  const buttons = page.getByRole("list", { name: "open items" }).getByRole("button");
  await expect(buttons).toHaveCount(4);
  const rights = await buttons.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().right)),
  );
  expect(rights.filter((right) => right > 390)).toEqual([]);
});
