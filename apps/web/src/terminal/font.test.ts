import { describe, expect, it } from "vitest";
import { FACES, facesFor, fontsSettled, terminalFontFamily } from "./font.ts";

const never = new Promise<void>(() => undefined);
const loaded = { load: () => Promise.resolve() };
const failing = { load: () => Promise.reject(new Error("404")) };
const throwing = {
  load: (): Promise<unknown> => {
    throw new Error("no FontFace");
  },
};
const hanging = { load: () => never };

/** Whether `promise` has settled once everything already queued has run. */
const settledNow = (promise: Promise<void>) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);

describe("the terminal's font", () => {
  it("draws text in the bundled face, icons from the bundled symbols, then the system's monospace", () => {
    expect(terminalFontFamily(null)).toBe(
      '"JetBrainsMono NFM", "JetBrainsMono NFM Symbols", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    );
  });

  it("puts a device's own family first, keeping the bundled font behind it for what it lacks", () => {
    expect(terminalFontFamily('"Iosevka Term", monospace')).toBe(
      '"Iosevka Term", monospace, "JetBrainsMono NFM", "JetBrainsMono NFM Symbols", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    );
  });

  it("bundles regular, bold, italic and bold italic text faces, and one symbols face", () => {
    expect(FACES.map((f) => [f.family, f.weight, f.style])).toEqual([
      ["JetBrainsMono NFM", "400", "normal"],
      ["JetBrainsMono NFM", "700", "normal"],
      ["JetBrainsMono NFM", "400", "italic"],
      ["JetBrainsMono NFM", "700", "italic"],
      ["JetBrainsMono NFM Symbols", "400", "normal"],
    ]);
    expect(FACES.map((f) => f.url).every((url) => url.endsWith(".woff2"))).toBe(true);
  });

  it("waits for every bundled face, or only the symbols when the device names its own family", () => {
    expect([facesFor(null), facesFor("Iosevka Term").map((f) => f.family)]).toEqual([
      FACES,
      ["JetBrainsMono NFM Symbols"],
    ]);
  });
});

describe("waiting for the terminal's font", () => {
  it("is ready once every face has loaded", async () => {
    expect(await settledNow(fontsSettled([loaded, loaded], never))).toBe(true);
  });

  it("is not ready while a face is still loading and the deadline hasn't passed", async () => {
    expect(await settledNow(fontsSettled([loaded, hanging], never))).toBe(false);
  });

  it("is ready, never failed, when a face can't load, so the terminal opens on the fallback", async () => {
    expect(await settledNow(fontsSettled([failing, throwing, loaded], never))).toBe(true);
  });

  it("is ready at the deadline though a face is still loading", async () => {
    expect(await settledNow(fontsSettled([hanging], Promise.resolve()))).toBe(true);
  });
});
