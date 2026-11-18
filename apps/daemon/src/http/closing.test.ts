import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ClosingBudget, type Closable } from "./closing.ts";

/** A socket with `bufferedAmount` queued, which records whether it was destroyed. */
class FakeSocket extends EventEmitter implements Closable {
  readonly CLOSED = 3;
  readyState: 0 | 1 | 2 | 3 = 1;
  terminated = false;
  bufferedAmount: number;

  constructor(bufferedAmount: number) {
    super();
    this.bufferedAmount = bufferedAmount;
  }

  close(): void {
    if (this.readyState === 1) this.readyState = 2;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Its peer answered the close, or it was destroyed. */
  closed(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

const sockets = (...bytes: number[]) => bytes.map((b) => new FakeSocket(b));
const terminated = (all: readonly FakeSocket[]) => all.map((s) => s.terminated);

describe("closing budget", () => {
  it("closes each socket, and destroys none while their queues fit", () => {
    const budget = new ClosingBudget(10);
    const all = sockets(4, 6);
    for (const s of all) budget.close(s);
    expect([all.map((s) => s.readyState), terminated(all)]).toEqual([
      [2, 2],
      [false, false],
    ]);
  });

  it("destroys the sockets closed longest ago until the rest fit", () => {
    const budget = new ClosingBudget(10);
    const all = sockets(4, 4, 4, 5);
    for (const s of all) budget.close(s);
    expect(terminated(all)).toEqual([true, true, false, false]);
  });

  it("never destroys the socket it has just closed, though its queue alone is over", () => {
    const budget = new ClosingBudget(10);
    const all = sockets(4, 30);
    for (const s of all) budget.close(s);
    expect(terminated(all)).toEqual([true, false]);
  });

  it("forgets a socket once it closes, so its queue no longer counts", () => {
    const budget = new ClosingBudget(10);
    const first = new FakeSocket(6);
    const rest = sockets(6, 4);
    budget.close(first);
    first.closed();
    for (const s of rest) budget.close(s);
    expect(terminated([first, ...rest])).toEqual([false, false, false]);
  });

  it("counts a queue as it is when the next socket closes, not as it was", () => {
    const budget = new ClosingBudget(10);
    const draining = new FakeSocket(8);
    const next = new FakeSocket(8);
    budget.close(draining);
    draining.bufferedAmount = 2;
    budget.close(next);
    expect(terminated([draining, next])).toEqual([false, false]);
  });

  it("holds nothing for a socket that had already closed", () => {
    const budget = new ClosingBudget(10);
    const gone = new FakeSocket(9);
    const next = new FakeSocket(12);
    gone.closed();
    budget.close(gone);
    budget.close(next);
    expect(terminated([gone, next])).toEqual([false, false]);
  });

  it("counts no more for a socket than was queued at its close, whatever is sent after", () => {
    const budget = new ClosingBudget(10);
    const answering = new FakeSocket(6);
    const next = new FakeSocket(4);
    budget.close(answering);
    answering.bufferedAmount = 20;
    budget.close(next);
    expect(terminated([answering, next])).toEqual([false, false]);
  });
});
