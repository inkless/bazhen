import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { acceptsInput, engage, NO_LEASE, release } from "./lease.ts";

const laptop = newId("att");
const phone = newId("att");

describe("input lease", () => {
  it("moves to the view the user engages, and raises the epoch", () => {
    const driving = engage(NO_LEASE, laptop, "interactive");
    const taken = engage(driving, phone, "interactive");
    expect(taken).toEqual({ holder: phone, epoch: driving.epoch + 1 });
  });

  it("never goes to an observer", () => {
    expect(engage(NO_LEASE, phone, "observe")).toBe(NO_LEASE);
  });

  it("keeps the epoch when the driver engages again", () => {
    const driving = engage(NO_LEASE, laptop, "interactive");
    expect(engage(driving, laptop, "interactive")).toBe(driving);
  });

  it("drops input from a former driver, even at the epoch it once held", () => {
    const first = engage(NO_LEASE, laptop, "interactive");
    const taken = engage(first, phone, "interactive");
    expect(acceptsInput(taken, laptop, first.epoch)).toBe(false);
    expect(acceptsInput(taken, phone, taken.epoch)).toBe(true);
  });

  it("drops input sent under an older epoch by the same view", () => {
    const first = engage(NO_LEASE, laptop, "interactive");
    const regained = engage(release(first, laptop), laptop, "interactive");
    expect(acceptsInput(regained, laptop, first.epoch)).toBe(false);
  });

  it("is released only by its own holder", () => {
    const driving = engage(NO_LEASE, laptop, "interactive");
    expect(release(driving, phone)).toBe(driving);
    expect(release(driving, laptop)).toEqual({ holder: null, epoch: driving.epoch });
  });
});
