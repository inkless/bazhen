import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevRun } from "./dev.ts";

let dev: DevRun;

beforeAll(async () => {
  dev = await DevRun.start();
}, 120_000);

afterAll(async () => {
  await dev.stop();
});

describe("pnpm dev", () => {
  it("leaves the terminal only to the foreground job", () => {
    expect(dev.backgroundHolders()).toEqual([]);
  });

  it("stops both processes cleanly on Ctrl-C, says so, and exits 0", async () => {
    expect(dev.statuses()).toEqual([]);
    expect(await dev.interrupt()).toEqual({
      exit: 0,
      apps: ["apps/daemon dev: Done", "apps/web dev: Done"],
    });
    expect(dev.text).toContain("apps/daemon dev: bazhen daemon stopped (SIGINT)");
    expect(dev.text).toContain("apps/web dev: bazhen web dev server stopped");
  });
});
