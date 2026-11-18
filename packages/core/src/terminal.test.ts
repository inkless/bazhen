import { describe, expect, it } from "vitest";
import { InvalidTransition } from "./machine.ts";
import { advanceTerminal, terminal } from "./terminal.ts";

describe("terminal state machine", () => {
  it("never concludes lost from an unreachable runtime alone", () => {
    const unknown = terminal.next("running", "runtime.unreachable");
    expect(unknown).toBe("unknown");
    expect(() => terminal.next(unknown, "runtime.unreachable")).toThrow(InvalidTransition);
    expect(terminal.next(unknown, "runtime.reconfirmed")).toBe("running");
  });

  it("becomes lost only when the runtime answers and the target is absent", () => {
    expect(terminal.next("unknown", "target.absent")).toBe("lost");
    expect(terminal.next("exited", "target.absent")).toBe("lost");
  });

  it("records an exit seen once an unreachable runtime answers again", () => {
    expect(terminal.next("unknown", "process.exited")).toBe("exited");
  });

  it("keeps an exited terminal until a deliberate close or respawn", () => {
    expect(() => terminal.next("exited", "process.exited")).toThrow(InvalidTransition);
    expect(terminal.next("exited", "close.requested")).toBe("closing");
  });

  it("runs a process replaced from outside, without taking the next generation", () => {
    expect([
      advanceTerminal({ state: "running", generation: 3 }, "adopted"),
      advanceTerminal({ state: "exited", generation: 3 }, "adopted"),
    ]).toEqual([
      { state: "running", generation: 3 },
      { state: "running", generation: 3 },
    ]);
  });

  it("adopts no process once it is closing, lost or ended", () => {
    expect(
      (["creating", "unknown", "lost", "closing", "closed", "failed"] as const).map((s) =>
        terminal.accepts(s, "adopted"),
      ),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("refuses to revive a closed terminal", () => {
    expect(() => terminal.next("closed", "respawned")).toThrow(InvalidTransition);
  });

  it("takes the next generation on a respawn from exited and on a re-link", () => {
    expect(advanceTerminal({ state: "exited", generation: 3 }, "respawned")).toEqual({
      state: "running",
      generation: 4,
    });
    expect(advanceTerminal({ state: "running", generation: 3 }, "relinked").generation).toBe(4);
    expect(advanceTerminal({ state: "unknown", generation: 3 }, "runtime.reconfirmed")).toEqual({
      state: "running",
      generation: 3,
    });
  });

  it("refuses a respawn the table refuses, rather than bumping the generation", () => {
    expect(() => advanceTerminal({ state: "running", generation: 3 }, "respawned")).toThrow(
      InvalidTransition,
    );
  });
});
