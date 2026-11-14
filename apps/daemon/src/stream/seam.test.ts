import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seam, type Held, type Position } from "./seam.ts";

type Event = { kind: "data"; bytes: Uint8Array } | { kind: "respawn" };

/** One byte of output, or a respawn's reset, as the stream delivered it, in order. */
interface Unit {
  readonly byte: number;
  /** Where a snapshot taken just before this unit is. */
  readonly before: Position;
  /** For a reset, the generation it starts. */
  readonly starts?: number;
}

const RESET = 0xff;

/** Everything delivered from `start`, unit by unit, and where the stream is after each event. */
function deliver(start: Position, events: readonly Event[]) {
  let at = start;
  const units: Unit[] = [];
  const positions: Position[] = [at];
  const items: Held[] = [];
  for (const event of events) {
    if (event.kind === "respawn") {
      units.push({ byte: RESET, before: at, starts: at.generation + 1 });
      at = { generation: at.generation + 1, offset: 0 };
      items.push({ kind: "reset", generation: at.generation, bytes: Uint8Array.of(RESET) });
    } else {
      for (const [i, byte] of event.bytes.entries()) {
        units.push({ byte, before: { ...at, offset: at.offset + i } });
      }
      items.push({ kind: "data", at, bytes: event.bytes });
      at = { ...at, offset: at.offset + event.bytes.length };
    }
    positions.push(at);
  }
  return { units, positions, items };
}

const compare = (a: Position, b: Position) => a.generation - b.generation || a.offset - b.offset;
/** What a snapshot taken at `taken` already shows: a reset from its own generation on. */
const precedes = (u: Unit, taken: Position) =>
  u.starts === undefined ? compare(u.before, taken) < 0 : taken.generation >= u.starts;

const events = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: fc.uint8Array({ minLength: 1, maxLength: 6 }) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  { maxLength: 12 },
);
const toEvents = (raw: readonly (Uint8Array | null)[]): Event[] =>
  raw.map((bytes) => (bytes === null ? { kind: "respawn" } : { kind: "data", bytes }));

/**
 * A stream that delivered `raw` from a start position, a view that began holding its output
 * after `pickFrom` of those events, and a point it may have taken its snapshot at, on or after
 * that: everything it delivered, the snapshot's bytes, and what the seam adds to them.
 */
function scenario(
  raw: readonly (Uint8Array | null)[],
  start: Position,
  pickFrom: number,
  pickTaken: number,
) {
  const before = toEvents(raw);
  const { units, positions } = deliver(start, before);
  const now = positions.at(-1) ?? start;
  const fromIndex = pickFrom % positions.length;
  const from = positions[fromIndex] ?? start;
  const later = [...units.map((u) => u.before), now].filter((p) => compare(p, from) >= 0);
  const taken = later[pickTaken % later.length] ?? now;
  const rest = seam(deliver(from, before.slice(fromIndex)).items, from, now, taken);
  return {
    delivered: units.map((u) => u.byte),
    snapshot: units.filter((u) => precedes(u, taken)).map((u) => u.byte),
    rest: (rest ?? []).flatMap((item) => [...item.bytes]),
  };
}

describe("the seam between a snapshot and the output held while it was taken", () => {
  it("gives a view that replays the snapshot exactly the rest of the stream", () => {
    fc.assert(
      fc.property(
        events,
        fc.record({ generation: fc.nat({ max: 3 }), offset: fc.nat({ max: 100 }) }),
        fc.nat(),
        fc.nat(),
        (raw, start, pickFrom, pickTaken) => {
          const { delivered, snapshot, rest } = scenario(raw, start, pickFrom, pickTaken);
          expect([...snapshot, ...rest]).toEqual(delivered);
        },
      ),
    );
  });

  it("refuses a snapshot older than the held output or newer than the stream", () => {
    const from = { generation: 1, offset: 10 };
    const now = { generation: 1, offset: 20 };
    const held: Held[] = [{ kind: "data", at: from, bytes: new Uint8Array(10) }];
    expect([
      seam(held, from, now, { generation: 1, offset: 9 }),
      seam(held, from, now, { generation: 0, offset: 50 }),
      seam(held, from, now, { generation: 1, offset: 21 }),
      seam(held, from, now, { generation: 2, offset: 0 }),
      seam(held, from, now, from)?.length,
      seam(held, from, now, now)?.length,
    ]).toEqual([null, null, null, null, 1, 0]);
  });

  it("keeps a respawn's reset for a snapshot taken before it, and drops it after", () => {
    const from = { generation: 0, offset: 4 };
    const reset = Uint8Array.of(RESET);
    const next = Uint8Array.of(1, 2);
    const held: Held[] = [
      { kind: "reset", generation: 1, bytes: reset },
      { kind: "data", at: { generation: 1, offset: 0 }, bytes: next },
    ];
    const now = { generation: 1, offset: 2 };
    expect([
      seam(held, from, now, from)?.map((item) => [...item.bytes]),
      seam(held, from, now, { generation: 1, offset: 0 })?.map((item) => [...item.bytes]),
      seam(held, from, now, { generation: 1, offset: 1 })?.map((item) => [...item.bytes]),
    ]).toEqual([[[RESET], [1, 2]], [[1, 2]], [[2]]]);
  });
});
