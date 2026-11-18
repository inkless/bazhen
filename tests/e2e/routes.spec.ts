import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { expect, test } from "./page.ts";

// A route that fails after its test has ended fails whichever test its worker is running by then,
// so the second test is the proof for the first: the two run in order, in one worker, or the
// second passes with nothing to catch.
test.describe.configure({ mode: "serial" });

/** Takes every request and answers none, so a fetch through it is still pending at teardown. */
const silent = createServer();
let silentUrl = "";
/** The first test's request, closing; unset unless that test ran in this worker before the second. */
let pendingClosed: Promise<void> | undefined;

async function listen(): Promise<string> {
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  const address = silent.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}/`;
}

test.beforeAll(async () => {
  silentUrl = await listen();
});

test.afterAll(async () => {
  silent.closeAllConnections();
  await new Promise((resolve) => silent.close(resolve));
});

test("ends with a route still fetching from a server that never answers", async ({ page }) => {
  const arrived = new Promise<IncomingMessage>((resolve) => silent.once("request", resolve));
  await page.route("**/never-answered", async (route) => {
    const response = await route.fetch({ url: silentUrl });
    await route.fulfill({ response });
  });
  await page.goto("/");
  await page.evaluate(() => {
    void fetch("/never-answered");
  });
  const request = await arrived;
  pendingClosed = new Promise((resolve) => request.socket.once("close", () => resolve()));
  expect(request.url).toBe("/");
});

test("the test after it is not failed by that route", async ({ page }) => {
  expect(pendingClosed, "the test before this one left no route fetching").toBeDefined();
  await pendingClosed;
  // Playwright answers this only after anything it raised from the close, so a failure the
  // route left behind has reached this test by the time the heading is checked.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
});
