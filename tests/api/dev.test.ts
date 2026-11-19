import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevRun } from "./dev.ts";

let dev: DevRun;

beforeAll(async () => {
  dev = await DevRun.start();
}, 120_000);

afterAll(async () => {
  await dev.stop();
});

describe("moon run :dev", () => {
  it("leaves the terminal only to the foreground job", () => {
    expect(dev.backgroundHolders()).toEqual([]);
  });

  it("gives neither app the terminal's input, so vite takes no key as a shortcut", () => {
    expect(dev.appInputs()).toEqual({ daemon: ["/dev/null"], web: ["/dev/null"] });
  });

  // moon passes the Ctrl-C on to both apps and exits without waiting for them to stop, so whether
  // an app's own "stopped" line is printed is a race, and the apps are waited for here; the daemon
  // is built to survive being cut short. moon marks the tasks it interrupted as failed, then dies of
  // the SIGINT itself, as a shell expects of an interrupted program: 128 + 2.
  it("ends both apps on Ctrl-C, says it was interrupted, and dies of the SIGINT", async () => {
    const { daemon, web } = dev.apps();
    expect([daemon.length > 0, web.length > 0]).toEqual([true, true]);
    expect(await dev.interrupt()).toBe(130);
    expect(dev.text).toContain("(interrupted)");
    expect(await DevRun.survivors([...daemon, ...web])).toEqual([]);
  });
});
