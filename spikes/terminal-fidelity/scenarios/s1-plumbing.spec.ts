import { expect, test } from "@playwright/test";
import { SHELL, SHELL_ENV, capture, createTerm, deleteTerm, info, openView, ptys, waitForText } from "./helpers.ts";

test("S1: shell echo, detach leaves pane alive, PTY returns to baseline", async ({ browser }) => {
  const before = await ptys();
  await createTerm("s1", SHELL, { env: SHELL_ENV });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openView(page, "s1");
  await page.keyboard.type("echo hello-$((6*7))");
  await page.keyboard.press("Enter");
  await waitForText(page, "hello-42");
  const during = await info("s1");
  expect(during.attachClient).toBe(true);
  expect(await ptys()).toBe(before + 1);
  await ctx.close();
  await expect.poll(async () => (await info("s1")).attachClient).toBe(false);
  expect(await capture("s1")).toContain("hello-42"); // pane lived on
  await expect.poll(ptys).toBe(before);
  console.log(JSON.stringify({ before, during: during.tmux, clients: during.clients }));
  await deleteTerm("s1");
});
