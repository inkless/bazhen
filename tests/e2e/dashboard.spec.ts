import { hostname } from "node:os";
import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  attachCommandFor,
  generationOf,
  givePageAgentTranscript,
  kill,
  launch,
  patchState,
  screen,
  uniqueName,
} from "./page.ts";

/**
 * Launches an agent from outside the page, as another device would, under `name` if given;
 * answers the status.
 */
function launchElsewhere(page: Page, name?: string): Promise<number> {
  return page.evaluate(
    async ({ cwd, asked }) =>
      (
        await fetch("/v1/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            harness: "claude-code",
            cwd,
            ...(asked === undefined ? {} : { name: asked }),
          }),
        })
      ).status,
    { cwd: String(process.env["BZ_E2E_WORK"]), asked: name },
  );
}

const workspace = (page: Page) => page.getByRole("article", { name: "agent" });

/** The path of every POST the page sends to a path ending `suffix`, as it sends them. */
function posts(page: Page, suffix: string): string[] {
  const sent: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "POST" && path.endsWith(suffix)) sent.push(path);
  });
  return sent;
}

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
  // Launched without a name, it is given its project's next number; then its project and harness.
  await expect(workspace(page).locator(".workspace-head > :is(h2, .meta, .state)")).toHaveText(
    [/^[\w-]+-\d+$/, basename(String(process.env["BZ_E2E_WORK"])), "claude-code", "running"],
    { timeout: 20_000 },
  );

  await workspace(page).getByText("Attach from a terminal").click();
  await expect(workspace(page).locator(".attach code")).toHaveText(
    await attachCommandFor(page, agentId),
  );

  await workspace(page).getByRole("button", { name: "Close agent…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close agent" }).click();
  await expect(stateOf(page, "closed")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("region", { name: "terminal" })).toHaveCount(0);
  await expect(
    workspace(page).getByRole("button", { name: /Close agent|Respawn|Rename/ }),
  ).toHaveCount(0);
  await expect(agents.locator('[aria-current="true"]')).toHaveCount(0);

  await page.getByRole("button", { name: /Show ended agents/ }).click();
  await agents.locator('[aria-current="true"]').click();
  expect(new URL(page.url()).hash).toBe(`#/agent/${agentId}`);
  await expect(page.getByRole("region", { name: "terminal" })).toHaveCount(0);
});

/** A message `from` sent `to` with SendMessage, `minutesAgo`, as the daemon observed it. */
const sent = (
  from: string,
  to: string,
  summary: string,
  accepted: boolean,
  minutesAgo: number,
) => ({
  id: `obs_0190000000007000800000000000${String(minutesAgo).padStart(4, "0")}`,
  from,
  to,
  summary,
  accepted,
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

test("lists the messages an agent sent and was sent with SendMessage, newest first", async ({
  page,
}) => {
  const agentId = await launch(page);
  const peer = "agent_01900000000070008000000000000099";
  // As if the agents' hooks had reported them; the daemon records a send only from a real one.
  const observed = [
    sent(agentId, peer, "Rebased", true, 2),
    sent(peer, agentId, "Review?", false, 1),
  ];
  await patchState(page, (state) => ({ ...state, observed }));
  // The page is already on the agent, so only a reload reads the state again.
  await page.reload();
  const messages = workspace(page).getByRole("region", { name: "Messages sent with SendMessage" });
  await expect(messages.getByRole("listitem")).toHaveText([
    /^From agent 000099 Review\? .* SendMessage · not sent$/,
    /^To agent 000099 Rebased .* SendMessage · delivery not tracked$/,
  ]);
});

test("names an agent at launch, renames it from its workspace, and refuses a name another holds", async ({
  page,
}) => {
  const name = uniqueName("scout");
  const agentId = await launch(page, name);
  const current = page.getByRole("list", { name: "agents" }).locator('[aria-current="true"]');
  const heading = workspace(page).getByRole("heading", { level: 2 });
  await expect(heading).toHaveText(name);
  await expect(current).toContainText(name);

  const renames = posts(page, "/rename");
  const rename = workspace(page).getByRole("button", { name: "Rename" });
  await rename.click();
  const form = workspace(page).getByRole("form", { name: "rename agent" });
  const field = form.getByLabel("Name");
  await expect(field).toBeFocused();
  await field.fill("-not-a-name");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("a name is 1 to 40");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(rename).toBeFocused();
  expect(renames).toEqual([]);

  // Sent by its id: once it lands, a retry by the old name would find no agent.
  const renamed = uniqueName("reviewer");
  await rename.click();
  await field.fill(renamed);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(heading).toHaveText(renamed);
  await expect(current).toContainText(renamed);
  await expect(form).toHaveCount(0);
  await expect(rename).toBeFocused();
  expect(renames).toEqual([`/v1/agents/${agentId}/rename`]);

  const taken = uniqueName("taken");
  expect(await launchElsewhere(page, taken)).toBe(200);
  await workspace(page).getByRole("button", { name: "Rename" }).click();
  await form.getByLabel("Name").fill(taken);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText(`another agent is named ${taken}`);
  await expect(heading).toHaveText(renamed);
});

test("refuses a launch under a name that isn't one, beside the field, and sends nothing", async ({
  page,
}) => {
  await page.goto("/");
  const launches = posts(page, "/v1/agents");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  const name = page.locator(".launch").getByLabel("Name");
  await name.fill("-bad");
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect(page.getByRole("alert")).toContainText("a name is 1 to 40");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  expect(launches).toEqual([]);
});

test("respawns an agent whose process ended, onto a fresh terminal", async ({ page }) => {
  const agentId = await launch(page);
  const killed = await kill(page, agentId);
  expect(killed).toBe(200);
  await expect(stateOf(page, "exited")).toBeVisible({ timeout: 10_000 });
  // It never reached a model; given a conversation, its session can be resumed.
  await givePageAgentTranscript(page, agentId);

  await workspace(page).getByRole("button", { name: "Respawn" }).click();
  // The conversation it was given is no real one, so the new TUI gives up on it and ends, never
  // running: what is tested here is the new process in the terminal, not the resume.
  await expect.poll(() => generationOf(page, agentId), { timeout: 20_000 }).toBe(1);
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

  await expect(stateOf(page, "running")).toBeVisible({ timeout: 20_000 });
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
