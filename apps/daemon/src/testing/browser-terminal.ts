import headless from "@xterm/headless";
import type { Size } from "@bazhen/core";
import type { Replayed } from "@bazhen/core/testing";

/** OSC numbers that set a colour slot, and the slot each sets first. */
const SETS: Readonly<Record<number, string>> = { 10: "foreground", 11: "background", 12: "cursor" };
/** OSC numbers that put a slot back to the theme's colour. */
const RESETS: Readonly<Record<number, string>> = {
  110: "foreground",
  111: "background",
  112: "cursor",
};
const SLOTS = ["foreground", "background", "cursor"];

/**
 * Replays `vt` as a browser's terminal does. Headless xterm keeps no colours of its own, so the
 * slots a program set away from the theme are followed as the browser's theme follows them, and
 * xterm still applies every sequence.
 */
export async function replay(vt: Uint8Array | string, size: Size): Promise<Replayed> {
  const term = new headless.Terminal({ ...size, allowProposedApi: true });
  let replies = "";
  term.onData((data) => (replies += data));
  const colours = new Map<string, string>();
  const watch = (ident: number, apply: (params: string[]) => void) =>
    term.parser.registerOscHandler(ident, (data) => {
      apply(data.split(";"));
      return false;
    });
  watch(4, (params) => {
    for (let i = 0; i + 1 < params.length; i += 2) {
      if (params[i + 1] !== "?") colours.set(`palette ${params[i]}`, String(params[i + 1]));
    }
  });
  for (const [ident, first] of Object.entries(SETS)) {
    watch(Number(ident), (params) => {
      params.forEach((spec, i) => {
        const slot = SLOTS[SLOTS.indexOf(first) + i];
        if (slot !== undefined && spec !== "?") colours.set(slot, spec);
      });
    });
  }
  watch(104, (params) => {
    const listed = params.filter((p) => p !== "");
    for (const slot of colours.keys()) {
      if (slot.startsWith("palette ") && (listed.length === 0 || listed.includes(slot.slice(8)))) {
        colours.delete(slot);
      }
    }
  });
  for (const [ident, slot] of Object.entries(RESETS))
    watch(Number(ident), () => colours.delete(slot));
  await new Promise<void>((resolve) => term.write(vt, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    (buffer.getLine(y)?.translateToString(true) ?? "").trim(),
  );
  const shown = {
    buffer: buffer.type,
    modes: { ...term.modes },
    lines,
    replies,
    colours: Object.fromEntries(colours),
  };
  term.dispose();
  return shown;
}
