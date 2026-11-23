import { describe, expect, it } from "vitest";
import {
  REAPER_ENV,
  SHIM,
  decodeMarker,
  encodeMarker,
  onPath,
  probeRefusal,
  reaperStart,
  replaceEnv,
  shimArgv,
  type ReaperStart,
} from "./reaper.ts";

/** The env a start re-execs with; it fails a test whose start doesn't re-exec. */
function execEnv(start: ReaperStart): NodeJS.ProcessEnv {
  if (start.kind !== "exec") throw new Error(`a ${start.kind} start, not an exec`);
  return start.env;
}

const stat = (pid: number, state: string, ppid: number) =>
  `${pid} (cat) ${state} ${ppid} ${pid} ${pid} 0 -1 4194560`;

describe("the marker", () => {
  it.each([null, "", "C", "en_US.UTF-8", "\u00ff\u0001 odd=bytes"])(
    "carries LC_CTYPE %j and the pid across an encoding",
    (lcCtype) => {
      expect(decodeMarker(encodeMarker({ pid: 4242, lcCtype }))).toEqual({ pid: 4242, lcCtype });
    },
  );

  it.each([
    undefined,
    "",
    "not base64 json",
    Buffer.from("[]").toString("base64"),
    Buffer.from('{"pid":"1","lcCtype":null}').toString("base64"),
    Buffer.from('{"pid":1.5,"lcCtype":null}').toString("base64"),
    Buffer.from('{"pid":7}').toString("base64"),
    Buffer.from('{"pid":7,"lcCtype":3}').toString("base64"),
  ])("is no marker as %j", (text) => {
    expect(decodeMarker(text)).toBeUndefined();
  });
});

describe("reaperStart", () => {
  const node = "/usr/bin/node";
  const argv = ["--no-warnings", "/repo/scripts/capped.ts", "--memory", "1G"];

  it("re-execs through python3, with a marker for its own pid and LC_CTYPE", () => {
    const start = reaperStart({ PATH: "/bin", LC_CTYPE: "C" }, 4242, node, argv, "/bin/python3");
    expect(start).toEqual({
      kind: "exec",
      file: "/bin/python3",
      argv: ["/bin/python3", "-I", "-S", "-c", SHIM, node, ...argv],
      env: {
        PATH: "/bin",
        LC_CTYPE: "C",
        [REAPER_ENV]: encodeMarker({ pid: 4242, lcCtype: "C" }),
      },
    });
  });

  it("records an unset LC_CTYPE as null", () => {
    const start = reaperStart({}, 4242, node, argv, "/bin/python3");
    expect(decodeMarker(execEnv(start)[REAPER_ENV])).toEqual({
      pid: 4242,
      lcCtype: null,
    });
  });

  it("back from its re-exec, drops the marker and undoes python's LC_CTYPE", () => {
    const env = {
      PATH: "/bin",
      LC_CTYPE: "C.UTF-8",
      [REAPER_ENV]: encodeMarker({ pid: 4242, lcCtype: null }),
    };
    expect(reaperStart(env, 4242, node, argv, "/bin/python3")).toEqual({
      kind: "reaper",
      env: { PATH: "/bin" },
    });
  });

  it("back from its re-exec, restores the LC_CTYPE it had", () => {
    const env = { LC_CTYPE: "C.UTF-8", [REAPER_ENV]: encodeMarker({ pid: 9, lcCtype: "" }) };
    expect(reaperStart(env, 9, node, argv, "/bin/python3")).toEqual({
      kind: "reaper",
      env: { LC_CTYPE: "" },
    });
  });

  it("re-execs a nested capped, whose inherited marker names another pid", () => {
    const env = { [REAPER_ENV]: encodeMarker({ pid: 4242, lcCtype: null }) };
    const start = reaperStart(env, 5151, node, argv, "/bin/python3");
    expect(decodeMarker(execEnv(start)[REAPER_ENV])?.pid).toBe(5151);
  });

  it("says why where there is no python3", () => {
    expect(reaperStart({}, 4242, node, argv, undefined)).toEqual({
      kind: "none",
      why: "there is no python3 to set the flag",
    });
  });
});

describe("shimArgv", () => {
  it("keeps python's own site and environment out", () => {
    expect(shimArgv("/p", "/n", ["a"]).slice(0, 4)).toEqual(["/p", "-I", "-S", "-c"]);
  });
});

describe("onPath", () => {
  it("finds the first executable on an absolute PATH entry, skipping relative ones", () => {
    const found = onPath("python3", ".:bin:/a:/b", (file) => file === "/b/python3");
    expect(found).toBe("/b/python3");
    expect(onPath("python3", "bin", () => true)).toBeUndefined();
  });
});

describe("replaceEnv", () => {
  it("leaves exactly the new env, removing names it lacks", () => {
    const target: NodeJS.ProcessEnv = { A: "1", B: "2" };
    replaceEnv(target, { B: "3", C: "4" });
    expect(target).toEqual({ B: "3", C: "4" });
  });
});

describe("probeRefusal", () => {
  const self = `4242 (node) R 1 4242 4242 0 -1`;

  it("passes an orphan reparented to this process, while it lives", () => {
    expect(probeRefusal(4242, self, stat(777, "S", 4242))).toBeUndefined();
  });

  it.each([
    ["an orphan reparented elsewhere", self, stat(777, "S", 1500), "isn't reparented to it"],
    ["an orphan gone", self, undefined, "gone before it was read"],
    ["an orphan already a zombie", self, stat(777, "Z", 4242), "gone before it was read"],
    ["no /proc", undefined, stat(777, "S", 4242), "no /proc"],
    ["another namespace's /proc", `1 (node) R 0 1 1`, stat(777, "S", 4242), "pid namespace"],
  ])("refuses %s", (_, selfStat, orphan, why) => {
    expect(probeRefusal(4242, selfStat, orphan)).toContain(why);
  });
});
