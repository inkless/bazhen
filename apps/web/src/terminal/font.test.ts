import { describe, expect, it } from "vitest";
import { FACES, fontsSettled, inTime, terminalFontFamily } from "./font.ts";

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

  it("bundles regular, bold, italic and bold italic text faces, and symbols for every style", () => {
    expect(FACES.map((f) => [f.family, f.weight, f.style])).toEqual([
      ["JetBrainsMono NFM", "400", "normal"],
      ["JetBrainsMono NFM", "700", "normal"],
      ["JetBrainsMono NFM", "400", "italic"],
      ["JetBrainsMono NFM", "700", "italic"],
      ["JetBrainsMono NFM Symbols", "400 700", "normal"],
      ["JetBrainsMono NFM Symbols", "400 700", "italic"],
    ]);
    expect(FACES.map((f) => f.url).every((url) => url.endsWith(".woff2"))).toBe(true);
  });

  it("draws an icon in every style from the one symbols file", () => {
    const symbols = FACES.filter((f) => f.family === "JetBrainsMono NFM Symbols");
    expect(new Set(symbols.map((f) => f.url)).size).toBe(1);
  });
});

describe("waiting for the terminal's font", () => {
  it("settles once every face has loaded", async () => {
    expect(await settledNow(fontsSettled([loaded, loaded]))).toBe(true);
  });

  it("is not settled while a face is still loading", async () => {
    expect(await settledNow(fontsSettled([loaded, hanging]))).toBe(false);
  });

  it("settles, never failed, when a face can't load, so the terminal opens on the fallback", async () => {
    expect(await settledNow(fontsSettled([failing, throwing, loaded]))).toBe(true);
  });

  it("is in time when the faces settle before the deadline", async () => {
    expect(await inTime(fontsSettled([loaded]), never)).toBe(true);
  });

  it("is late at the deadline though a face is still loading", async () => {
    expect(await inTime(fontsSettled([hanging]), Promise.resolve())).toBe(false);
  });
});
