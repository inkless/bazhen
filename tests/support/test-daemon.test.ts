import { describe, expect, it } from "vitest";
import { testDaemonBin } from "./test-daemon.ts";

describe("the daemon a test run names", () => {
  it("is none unset or empty, and the path when it is absolute", () => {
    expect([
      testDaemonBin({}),
      testDaemonBin({ BAZHEN_TEST_DAEMON_BIN: "" }),
      testDaemonBin({ BAZHEN_TEST_DAEMON_BIN: "/opt/bazhen-daemon" }),
    ]).toEqual([undefined, undefined, "/opt/bazhen-daemon"]);
  });

  it("refuses a path that isn't absolute", () => {
    expect(() => testDaemonBin({ BAZHEN_TEST_DAEMON_BIN: "bin/bazhen-daemon" })).toThrow(
      "BAZHEN_TEST_DAEMON_BIN names bin/bazhen-daemon, which isn't an absolute path",
    );
  });
});
