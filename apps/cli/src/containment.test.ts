import { describe, expect, it } from "vitest";
import { containmentLines } from "./containment.ts";

const GIB = 1024 ** 3;
const scoped = (systemd: number) => ({
  state: "scoped" as const,
  systemd,
  oomPolicy: systemd >= 253,
  terminal: { asked: "50%", bytes: 31 * GIB },
  total: { asked: "80%", bytes: 50 * GIB },
  swap: { asked: "0", bytes: 0 },
});
const holder = (contained: boolean | null | undefined) => ({
  terminalId: "term_a",
  build: null,
  protocol: ["1.2"],
  ...(contained === undefined ? {} : { contained }),
});

describe("what doctor says of containment", () => {
  it("names every cap as configured and as enforced", () => {
    expect(containmentLines(scoped(255), [], ["holder"])).toEqual([
      "containment: each holder terminal in a systemd scope of its own, at most " +
        "50% (31.0 GiB) each with 0 (none) of swap, and 80% (50.0 GiB) together",
    ]);
  });

  it("says it hasn't checked before any holder terminal has started", () => {
    expect(containmentLines({ state: "unchecked" }, [], ["holder"])).toEqual([
      "containment: not checked yet (no holder terminal has started since the daemon did)",
    ]);
  });

  it("notes that before systemd 253 the kernel alone decides what dies", () => {
    expect(containmentLines(scoped(252), [], ["holder"])).toContain(
      "  note: systemd 252 predates OOMPolicy for scopes (253), " +
        "so the kernel alone decides what dies past a cap",
    );
  });

  it("says why nothing is contained, and what that risks", () => {
    expect(
      containmentLines({ state: "uncontained", why: "darwin has no cgroups" }, [], []),
    ).toEqual([
      "containment: none (darwin has no cgroups)",
      "  warning: one terminal's runaway memory can end every other terminal",
    ]);
  });

  it("counts the holder terminals outside a scope, but not ones it couldn't read", () => {
    const holders = [holder(false), holder(false), holder(true), holder(null), holder(undefined)];
    expect(containmentLines(scoped(255), holders, ["holder"])).toContain(
      "  2 holder terminals run outside a scope; restart them to contain them",
    );
  });

  it("asks for no restart when restarting wouldn't contain the terminal", () => {
    const uncontained = { state: "uncontained" as const, why: "no user manager" };
    expect(containmentLines(uncontained, [holder(false)], ["holder"])).toContain(
      "  1 holder terminal runs outside a scope",
    );
  });

  it("says tmux terminals are never contained, where tmux runs", () => {
    expect(containmentLines(scoped(255), [], ["tmux", "holder"])).toContain(
      "  tmux terminals are not contained",
    );
  });
});
