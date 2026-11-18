import type { Page, WebSocketRoute } from "@playwright/test";
import { answerPatched } from "../support/state-route.ts";
import { RUNTIMES } from "./daemons.ts";
import { expect, launch, runtime, screen, status, test } from "./page.ts";

/** What the header says of the runtime named `kind`. */
const stateOf = (page: Page, kind: string) =>
  page
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${kind}$`) })
    .locator("xpath=following-sibling::dd[1]");

test("the web client shows the daemon's live health through the dev proxy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: /^[0-9a-f]{12}$/ })).toBeVisible();
  // The daemon's own runtime is read, with its version; the other, with no terminal on it, isn't.
  await expect(stateOf(page, runtime())).toHaveText(/^(healthy|not-running) \(.+\)$/);
  for (const other of RUNTIMES.filter((r) => r !== runtime()))
    await expect(stateOf(page, other)).toHaveText("unused");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("asks to reload a page the daemon's protocol has moved past", async ({ page }) => {
  const health = { status: "ok", appVersion: "0.1.0", protocolId: "0".repeat(64) };
  await page.route("**/v1/health", (route) =>
    route.fulfill({
      json: { ...health, runtimes: [{ kind: "holder", state: "healthy", version: "holder/1.2" }] },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "This page and the daemon are different builds of Bazhen",
  );
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

/** Passes each event stream the page opens through the test, which can close it as a restart would. */
async function passEventStreams(page: Page): Promise<WebSocketRoute[]> {
  const streams: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/v1\/events/, (ws) => {
    streams.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    ws.onClose(() => server.close());
    server.onClose(() => ws.close());
  });
  return streams;
}

/** Answers `/v1/health` as the daemon does, but with the protocol id `served()` names, if any. */
async function answerHealth(page: Page, served: () => string | undefined) {
  await page.route("**/v1/health", (route) =>
    answerPatched(route, (health) => ({
      ...health,
      protocolId: served() ?? Reflect.get(health, "protocolId"),
    })),
  );
}

test("asks to reload once the event stream comes back to a daemon of another build", async ({
  page,
}) => {
  let served: string | undefined;
  await answerHealth(page, () => served);
  const streams = await passEventStreams(page);
  await page.goto("/");
  await expect.poll(() => streams.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  served = "0".repeat(64);
  await streams[0]?.close();
  await expect(page.getByRole("alert")).toContainText(
    "This page and the daemon are different builds of Bazhen",
  );
});

/** Answers `/v1/state` as the daemon does until `broken()`, then with a state no build can read. */
async function answerState(page: Page, broken: () => boolean) {
  await page.route("**/v1/state", (route) =>
    broken() ? route.fulfill({ json: { agents: "not a list" } }) : route.fallback(),
  );
}

test("asks to reload when a restarted daemon's state is one this page can't read", async ({
  page,
}) => {
  let served: string | undefined;
  await answerHealth(page, () => served);
  await answerState(page, () => served !== undefined);
  const streams = await passEventStreams(page);
  await page.goto("/");
  await expect.poll(() => streams.length).toBe(1);
  served = "0".repeat(64);
  await streams[0]?.close();
  await expect(page.getByRole("alert")).toContainText(
    "This page and the daemon are different builds of Bazhen",
  );
  expect(streams).toHaveLength(1);
});

/**
 * Passes each terminal stream the page opens through the test until `refuse()`. Then the open one
 * drops, and the page's next is refused as the daemon refuses a view of another build.
 */
async function routeTerminalStreams(page: Page) {
  const open: WebSocketRoute[] = [];
  let refusing = false;
  await page.routeWebSocket(/\/v1\/terminals\//, (ws) => {
    if (refusing) {
      ws.send(JSON.stringify({ type: "error", message: "this page is from another build" }));
      void ws.close();
      return;
    }
    open.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
    ws.onClose(() => server.close());
    server.onClose(() => ws.close());
  });
  return {
    refuse: async () => {
      refusing = true;
      await Promise.all(open.map((ws) => ws.close()));
    },
  };
}

test("asks to reload as soon as a terminal's view is refused as another build's", async ({
  page,
}) => {
  let served: string | undefined;
  await answerHealth(page, () => served);
  const streams = await routeTerminalStreams(page);
  await launch(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
  served = "0".repeat(64);
  await streams.refuse();
  await expect(page.getByRole("alert")).toContainText(
    "This page and the daemon are different builds of Bazhen",
  );
});

test("a device's pinned theme is set before the app's script runs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript({ content: `localStorage.setItem("bazhen.theme", "dark");` });
  // With the app's module never loading, only the page's head can have set it.
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

/** As Safari does with all cookies blocked: reaching either of the page's storages throws. */
async function blockSiteData(page: Page) {
  await page.addInitScript({
    content: `for (const name of ["localStorage", "sessionStorage"])
      Object.defineProperty(window, name, {
        get() { throw new DOMException("blocked", "SecurityError"); },
      });`,
  });
}

test("the page still loads and connects, in the system's theme, when site data is blocked", async ({
  page,
}) => {
  await blockSiteData(page);
  await page.goto("/");
  // The heading shows before the daemon answers, so only what the answer shows proves the page
  // survived it.
  await expect(page.getByRole("term").filter({ hasText: "Protocol" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bazhen" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});

test("launches an agent and types into its terminal when site data is blocked", async ({
  page,
}) => {
  await blockSiteData(page);
  await launch(page);
  await page.getByRole("region", { name: "terminal" }).locator(".xterm-screen").click();
  await expect(status(page)).toHaveText("Driving");
  await page.keyboard.type("typed with storage blocked");
  await expect.poll(() => screen(page)).toContain("typed with storage blocked");
});

test("the theme switch pins this device's theme, and back to the system's", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await theme.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
});
