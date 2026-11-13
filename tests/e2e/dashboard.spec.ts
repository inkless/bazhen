import { hostname } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import { givePageAgentTranscript, kill, screen } from "./page.ts";

/** Launches Claude Code from the page and waits for its TUI; answers the agent's id. */
async function launch(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
  return new URL(page.url()).hash.replace("#/agent/", "");
}

/** Launches an agent from outside the page, as another device would; answers the status. */
function launchElsewhere(page: Page): Promise<number> {
  return page.evaluate(
    async (cwd) =>
      (
        await fetch("/v1/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            harness: "claude-code",
            cwd,
          }),
        })
      ).status,
    String(process.env["BZ_E2E_WORK"]),
  );
}

const workspace = (page: Page) => page.getByRole("article", { name: "agent" });

const json = (status: number, body: object) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * Answers every close of `agentId` from the page as a daemon whose agent's old tmux server may
 * still run it: refused unconfirmed, and a forced one accepted. Returns the forced bodies.
 */
async function unconfirmedCloses(page: Page, agentId: string): Promise<unknown[]> {
  const forced: unknown[] = [];
  await page.route(`**/v1/agents/${agentId}/close`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    const force = Reflect.get(Object(body), "force") === true;
    if (force) forced.push(body);
    await route.fulfill(
      force
        ? json(200, { agentId, eventIds: [] })
        : json(409, { error: "server_unconfirmed", message: "its old server may still run it" }),
    );
  });
  return forced;
}
/** Every close of `agentId` the page sends, as it sends them. */
function closeRequests(page: Page, agentId: string): string[] {
  const closes: string[] = [];
  const close = `/v1/agents/${agentId}/close`;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(close)) closes.push(r.url());
  });
  return closes;
}

const stateOf = (page: Page, state: string) =>
  workspace(page).locator(".workspace-head").getByText(state, { exact: true });

test("shows the fleet under its host, and closes an agent from its workspace", async ({ page }) => {
  const agentId = await launch(page);
  const agents = page.getByRole("list", { name: "agents" });
  await expect(agents.getByRole("heading", { level: 2 })).toHaveText(new RegExp(`^${hostname()}`));
  await expect(agents.locator('[aria-current="true"]')).toBeVisible();

  await workspace(page).getByText("Attach from a terminal").click();
  await expect(workspace(page).locator(".attach code")).toContainText(" attach-session -t ");

  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close agent" }).click();
  await expect(stateOf(page, "closed")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("region", { name: "terminal" })).toHaveCount(0);
  await expect(workspace(page).getByRole("button", { name: /Close agent|Respawn/ })).toHaveCount(0);
  await expect(agents.locator('[aria-current="true"]')).toHaveCount(0);

  await page.getByRole("button", { name: /Show ended agents/ }).click();
  await agents.locator('[aria-current="true"]').click();
  expect(new URL(page.url()).hash).toBe(`#/agent/${agentId}`);
  await expect(page.getByRole("region", { name: "terminal" })).toHaveCount(0);
});

test("respawns an agent whose process ended, onto a fresh terminal", async ({ page }) => {
  const agentId = await launch(page);
  const killed = await kill(page, agentId);
  expect(killed).toBe(200);
  await expect(stateOf(page, "exited")).toBeVisible({ timeout: 10_000 });
  // It never reached a model; given a conversation, its session can be resumed.
  await givePageAgentTranscript(page, agentId);

  await workspace(page).getByRole("button", { name: "Respawn" }).click();
  await expect(stateOf(page, "running")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
});

test("keeps a refusal on screen while the fleet goes on changing", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill("relative/dir");
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  const refusal = page.getByRole("alert");
  await expect(refusal).toContainText("is not a full path");
  const agents = page.getByRole("list", { name: "agents" }).locator("button.agent");
  const before = await agents.count();
  expect(await launchElsewhere(page)).toBe(200);
  await expect(agents).toHaveCount(before + 1);
  await expect(refusal).toContainText("is not a full path");
});

test("copies the attach command on a page with no clipboard API, as over plain http", async ({
  page,
}) => {
  // Runs in the page, which has the DOM this package's types leave out.
  await page.addInitScript({
    content: `
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.addEventListener("copy", () => { globalThis.copiedText = String(getSelection()); });
    `,
  });
  await launch(page);
  await workspace(page).getByText("Attach from a terminal").click();
  await workspace(page).getByRole("button", { name: "Copy" }).click();
  await expect(workspace(page).getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  const command = await workspace(page).locator(".attach code").textContent();
  expect(await page.evaluate(() => Reflect.get(globalThis, "copiedText"))).toBe(command);
});

test("offers a forced close only once a close comes back unconfirmed, and sends it behind a confirm", async ({
  page,
}) => {
  const agentId = await launch(page);
  const forced = await unconfirmedCloses(page, agentId);
  const force = workspace(page).getByRole("button", { name: "Force close…" });
  await expect(force).toHaveCount(0);

  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close agent" }).click();
  await expect(force).toBeVisible();

  const confirm = page.getByRole("dialog", { name: "Force close agent" });
  await force.click();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(forced).toEqual([]);

  await force.click();
  await confirm.getByRole("button", { name: "Force close" }).click();
  await expect.poll(() => forced.length).toBe(1);
  expect(forced[0]).toMatchObject({ force: true });
});

test("the close confirm is a modal: Escape, Cancel and a tap outside each leave the agent alone", async ({
  page,
}) => {
  const agentId = await launch(page);
  const closes = closeRequests(page, agentId);
  const trigger = workspace(page).getByRole("button", { name: "Close agent…" });
  const dialog = page.getByRole("dialog", { name: "Close agent" });

  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Its claude-code process and terminal end");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);

  await expect(stateOf(page, "running")).toBeVisible();
  expect(closes).toEqual([]);
});

test("sends a close once however fast its confirm is tapped twice", async ({ page }) => {
  const agentId = await launch(page);
  const closes = closeRequests(page, agentId);
  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close agent" }).dblclick();
  await expect(stateOf(page, "closed")).toBeVisible({ timeout: 10_000 });
  expect(closes).toHaveLength(1);
});
