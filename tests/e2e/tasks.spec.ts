import { expect, test, type Page } from "@playwright/test";
import { screen } from "./page.ts";

/** Launches Claude Code from the page and waits for its TUI; answers the agent's id. */
async function launch(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByPlaceholder("/path/to/project").fill(String(process.env["BZ_E2E_WORK"]));
  await page.getByRole("button", { name: "Launch Claude Code" }).click();
  await expect.poll(() => screen(page), { timeout: 20_000 }).toContain("Claude Code");
  return new URL(page.url()).hash.replace("#/agent/", "");
}

test("gives an agent a task from the page, shows it on the agent, unassigns it, and marks it done", async ({
  page,
}) => {
  const agentId = await launch(page);
  await page.getByRole("button", { name: "Tasks" }).click();
  const form = page.getByRole("form", { name: "new task" });
  await form.getByLabel("Title").fill("Fix the build");
  await form.getByLabel("Brief").fill("It fails on Node 26.");
  await form.getByLabel("Agent").selectOption(agentId);
  await form.getByLabel("Role").selectOption("worker");
  await form.getByRole("button", { name: "Create task" }).click();

  const task = page.getByRole("article", { name: "task" });
  await expect(task.getByRole("heading", { name: "Fix the build" })).toBeVisible();
  await expect(task).toContainText("It fails on Node 26.");
  await expect(task.getByRole("list", { name: "assignments" })).toContainText("worker");
  const taskUrl = page.url();

  await page.goto(`/#/agent/${agentId}`);
  const assigned = page.getByRole("list", { name: "assigned tasks" });
  await expect(assigned).toContainText("worker on Fix the build");

  await page.goto(taskUrl);
  // A refused assignment says why, and gives the form back.
  await page.route("**/v1/tasks/*/assign", (route) =>
    route.fulfill({ status: 409, json: { error: "conflict", message: "already on the task" } }),
  );
  const assign = task.getByRole("form", { name: "assign" });
  await assign.getByLabel("Agent").selectOption(agentId);
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByRole("alert")).toHaveText("already on the task");
  await expect(assign.getByRole("button", { name: "Assign" })).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  const on = task.getByRole("list", { name: "assignments" });
  await on.getByRole("button", { name: "Unassign" }).click();
  await expect(on.getByRole("listitem")).toHaveCount(0);
  await task.getByRole("button", { name: "Mark done" }).click();
  await expect(task.getByText("done", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("region", { name: "tasks" })).toContainText("No open tasks.");
});

/**
 * Makes a task through the daemon's API, as another page would; answers its id. It sends the
 * page's Origin, as a browser does on a POST: a paired browser's action without one is refused.
 */
async function makeTask(page: Page, title: string, extra: object = {}): Promise<string> {
  const res = await page.request.post("/v1/tasks", {
    headers: { origin: new URL(page.url()).origin },
    data: { idempotencyKey: crypto.randomUUID(), title, brief: `${title}, in full.`, ...extra },
  });
  expect(res.ok()).toBe(true);
  return String(Reflect.get(Object(await res.json()), "taskId"));
}

const stateOf = async (page: Page, taskId: string) =>
  Reflect.get(Object(await (await page.request.get(`/v1/tasks/${taskId}`)).json()), "state");

test("cancels a task with every open subtask below it, listed first and only on confirm", async ({
  page,
}) => {
  await page.goto("/");
  const parent = await makeTask(page, "Ship it");
  const child = await makeTask(page, "Write the notes", { parentTaskId: parent });
  const grandchild = await makeTask(page, "Check the links", { parentTaskId: child });
  await page.goto(`/#/task/${parent}`);
  const task = page.getByRole("article", { name: "task" });
  await expect(task.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await task.getByRole("button", { name: "Cancel task…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("its 2 open subtasks (Write the notes, Check the links)");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await stateOf(page, grandchild)).toBe("open");

  await task.getByRole("button", { name: "Cancel task…" }).click();
  await page.getByRole("button", { name: "Cancel task and 2 subtasks" }).click();
  await expect
    .poll(async () => [
      await stateOf(page, parent),
      await stateOf(page, child),
      await stateOf(page, grandchild),
    ])
    .toEqual(["cancelled", "cancelled", "cancelled"]);
});

test("says there is no such task for an id it doesn't have, or one that isn't an id", async ({
  page,
}) => {
  await page.goto("/#/task/task_0190000000007000800000000000ffff");
  await expect(page.getByText("No such task.")).toBeVisible();
  await page.goto("/#/task/../agents");
  await page.reload();
  await expect(page.getByText("No such task.")).toBeVisible();
});
