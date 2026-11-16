import { describe, expect, it } from "vitest";
import { buildLines } from "./build.ts";

const OURS = "a".repeat(64);
const THEIRS = "b".repeat(64);

describe("buildLines", () => {
  it("names the daemon's version and protocol, and nothing more when the protocol is ours", () => {
    expect(buildLines({ appVersion: "0.1.0", protocolId: OURS }, OURS, ", running")).toEqual([
      "bazhen 0.1.0 (protocol aaaaaaaaaaaa), running",
    ]);
  });

  it("says to restart a daemon whose protocol isn't ours", () => {
    expect(buildLines({ appVersion: "0.1.0", protocolId: THEIRS }, OURS)).toEqual([
      "bazhen 0.1.0 (protocol bbbbbbbbbbbb)",
      "  warning: this CLI speaks protocol aaaaaaaaaaaa; the daemon runs another build of " +
        "Bazhen: restart it with `bazhen stop`, then `bazhen start`",
    ]);
  });
});
