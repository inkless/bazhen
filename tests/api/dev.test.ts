import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevRun } from "./dev.ts";

let dev: DevRun;

beforeAll(async () => {
  dev = await DevRun.start();
}, 120_000);

afterAll(async () => {
  await dev.stop();
});

describe("make dev", () => {
  it("leaves the terminal only to the foreground job", () => {
    expect(dev.backgroundHolders()).toEqual([]);
  });

  it("gives neither app the terminal's input, so vite takes no key as a shortcut", () => {
    expect(dev.appInputs()).toEqual({ daemon: ["/dev/null"], web: ["/dev/null"] });
  });

  // The Ctrl-C reaches both apps from the terminal, as they run in its foreground process group with
  // make, which waits for them to end. make then says which targets it interrupted and dies of the
  // SIGINT itself, as a shell expects of an interrupted program: 128 + 2. The apps are waited for
  // here too, as one may have left a process of its own behind.
  it("ends both apps on Ctrl-C, says it was interrupted, and dies of the SIGINT", async () => {
    const { daemon, web } = dev.apps();
    expect([daemon.length > 0, web.length > 0]).toEqual([true, true]);
    expect(await dev.interrupt()).toBe(130);
    expect(dev.text).toMatch(/\*\*\* \[.*\bdev\] Interrupt/);
    expect(await DevRun.survivors([...daemon, ...web])).toEqual([]);
  });
});
