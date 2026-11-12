import { describe, expect, it } from "vitest";
import { exitStatus } from "./exit-status.ts";

describe("exitStatus", () => {
  it("reads an exit code", () => {
    expect(exitStatus("3", "")).toEqual({ type: "exited", code: 3 });
  });

  it.each(["term", "TERM", "15"])("names the signal tmux printed as %j SIGTERM", (raw) => {
    expect(exitStatus("", raw)).toEqual({ type: "signalled", signal: "SIGTERM" });
  });

  it("prefers a signal's canonical name to its aliases", () => {
    expect(exitStatus("", "6")).toEqual({ type: "signalled", signal: "SIGABRT" });
  });

  it("calls a death with neither a code nor a signal unknown", () => {
    expect(exitStatus("", "")).toEqual({ type: "unknown" });
  });
});
