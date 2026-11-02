import { describe, expect, it } from "vitest";
import { InvalidTransition, nextGeneration, nextState } from "./terminal.ts";

describe("terminal state machine", () => {
  it("never concludes lost from an unreachable runtime alone", () => {
    const unknown = nextState("running", { type: "runtime.unreachable" });
    expect(unknown).toBe("unknown");
    expect(() => nextState(unknown, { type: "runtime.unreachable" })).toThrow(InvalidTransition);
    expect(nextState(unknown, { type: "runtime.reconfirmed" })).toBe("running");
  });

  it("becomes lost only when the runtime answers and the target is absent", () => {
    expect(nextState("unknown", { type: "target.absent" })).toBe("lost");
  });

  it("keeps an exited terminal until a deliberate close or respawn", () => {
    expect(() => nextState("exited", { type: "process.exited" })).toThrow(InvalidTransition);
    expect(nextState("exited", { type: "close.requested" })).toBe("closing");
  });

  it("refuses to revive a closed terminal", () => {
    expect(() => nextState("closed", { type: "respawned" })).toThrow(InvalidTransition);
  });

  it("increments the generation only on respawn from exited", () => {
    expect(nextGeneration("exited", { type: "respawned" }, 3)).toBe(4);
    expect(nextGeneration("running", { type: "runtime.reconfirmed" }, 3)).toBe(3);
  });
});
