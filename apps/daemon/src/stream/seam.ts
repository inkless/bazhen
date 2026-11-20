import type { ProgramExit, Size } from "@bazhen/core";

/** Where a stream is: the next byte the process of `generation` prints is at `offset`. */
export interface Position {
  readonly generation: number;
  readonly offset: number;
}

/**
 * Output held for a view while its snapshot is on its way. A respawn's reset is held at the new
 * generation's offset 0, before that process's first byte, and takes up no offsets itself. An exit
 * is held in order with the output around it, and takes up none either.
 */
export type Held =
  | { readonly kind: "geometry"; readonly size: Size }
  | { readonly kind: "data"; readonly at: Position; readonly bytes: Uint8Array }
  | { readonly kind: "reset"; readonly generation: number; readonly bytes: Uint8Array }
  | { readonly kind: "exited"; readonly exit: ProgramExit };

/** The bytes a held item adds to what the view lags by. */
export const heldBytes = (item: Held) =>
  item.kind === "geometry" || item.kind === "exited" ? 0 : item.bytes.length;

const compare = (a: Position, b: Position) => a.generation - b.generation || a.offset - b.offset;

/** Whether output held from `from` up to `now` can carry on from a snapshot taken at `taken`. */
export const seamable = (from: Position, now: Position, taken: Position) =>
  compare(taken, from) >= 0 && compare(taken, now) <= 0;

/**
 * What of `held`, which the stream delivered from `from` up to `now`, follows a snapshot taken at
 * `taken`: the output a view that replays the snapshot still needs, none missed or repeated, with
 * a chunk the snapshot covers part of cut where it ends. Null when no such output exists: a
 * snapshot older than `from` lacks the output between them, and one newer than `now` covers
 * output that hasn't arrived.
 */
export function seam(
  held: readonly Held[],
  from: Position,
  now: Position,
  taken: Position,
  queuedBeforeSnapshot = 0,
): Held[] | null {
  if (!seamable(from, now, taken)) return null;
  return held.flatMap((item, index): Held[] => {
    // The snapshot was taken after the latest applied geometry.
    if (item.kind === "geometry") return index >= queuedBeforeSnapshot ? [item] : [];
    if (item.kind === "reset") return item.generation > taken.generation ? [item] : [];
    // A snapshot shows no exit, so one of its own process still follows it; a respawn's is newer.
    if (item.kind === "exited") return item.exit.generation >= taken.generation ? [item] : [];
    const { at, bytes } = item;
    if (at.generation !== taken.generation) return at.generation > taken.generation ? [item] : [];
    const skip = taken.offset - at.offset;
    if (skip <= 0) return [item];
    if (skip >= bytes.length) return [];
    return [{ kind: "data", at: taken, bytes: bytes.subarray(skip) }];
  });
}
