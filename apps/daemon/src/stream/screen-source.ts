import type { HistoryAttached, Size, Snapshot, SnapshotAttached } from "@bazhen/core";
import { ScreenEmulator } from "./emulator.ts";
import type { Position } from "./seam.ts";

/** Where a view that opens gets its screen from, and what it is exact at. */
export interface ScreenSource {
  /** Every byte the stream delivers, in order. */
  write(bytes: Uint8Array): void;
  /** The history and screen as VT bytes, and the position they are exact at, given the stream's. */
  snapshot(now: Position): Promise<{ readonly vt: Uint8Array; readonly at: Position }>;
  /** Takes effect after the output already written. */
  resize(size: Size): void;
  dispose(): void;
}

/**
 * The daemon's own copy of a terminal whose client redraws it, which answers the client's queries
 * and is exact as of every byte written before a snapshot is asked for.
 */
export function emulatorScreen(
  attached: HistoryAttached,
  colours: () => { readonly text: string; readonly background: string },
): ScreenSource {
  const { stream } = attached;
  const emulator = new ScreenEmulator(stream.size, (reply) => stream.write(reply), colours);
  // Before any of the client's output, whose first redraw paints the screen below it.
  emulator.seed(attached.history);
  return {
    write: (bytes) => emulator.write(bytes),
    snapshot: async (now) => ({ vt: Buffer.from(await emulator.snapshot()), at: now }),
    resize: (size) => emulator.resize(size),
    dispose: () => emulator.dispose(),
  };
}

/**
 * A terminal whose runtime holds its state: every snapshot is the runtime's, and its queries are
 * the runtime's to answer. The one it attached on serves the first view, while nothing has been
 * delivered after it.
 */
export function runtimeScreen(attached: SnapshotAttached): ScreenSource {
  // Only `opened` may hold the attach snapshot: its vt is the whole history, kept no longer than
  // the first view needs it.
  const { stream } = attached;
  let opened: Snapshot | undefined = attached;
  return {
    write: () => {},
    snapshot: async (now) => {
      const first = opened;
      opened = undefined;
      const usable =
        first !== undefined && first.generation === now.generation && first.offset === now.offset;
      const taken = usable ? first : await stream.snapshot();
      return { vt: taken.vt, at: { generation: taken.generation, offset: taken.offset } };
    },
    resize: () => {},
    dispose: () => (opened = undefined),
  };
}
