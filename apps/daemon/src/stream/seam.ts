/** Where a stream is: the next byte the process of `generation` prints is at `offset`. */
export interface Position {
  readonly generation: number;
  readonly offset: number;
}

/**
 * Output held for a view while its snapshot is on its way. A respawn's reset is held at the new
 * generation's offset 0, before that process's first byte, and takes up no offsets itself.
 */
export type Held =
  | { readonly kind: "data"; readonly at: Position; readonly bytes: Uint8Array }
  | { readonly kind: "reset"; readonly generation: number; readonly bytes: Uint8Array };

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
): Held[] | null {
  if (!seamable(from, now, taken)) return null;
  return held.flatMap((item): Held[] => {
    if (item.kind === "reset") return item.generation > taken.generation ? [item] : [];
    const { at, bytes } = item;
    if (at.generation !== taken.generation) return at.generation > taken.generation ? [item] : [];
    const skip = taken.offset - at.offset;
    if (skip <= 0) return [item];
    if (skip >= bytes.length) return [];
    return [{ kind: "data", at: taken, bytes: bytes.subarray(skip) }];
  });
}
