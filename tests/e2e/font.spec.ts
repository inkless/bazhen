import type { Page } from "@playwright/test";
import { bundledFaces, expect, launch, screen, terminalFontFamily, test } from "./page.ts";

const FACES = [
  "JetBrainsMono NFM 400 normal",
  "JetBrainsMono NFM 700 normal",
  "JetBrainsMono NFM 400 italic",
  "JetBrainsMono NFM 700 italic",
  "JetBrainsMono NFM Symbols 400 normal",
];
const withStatus = (status: string) => FACES.map((face) => `${face}: ${status}`);

/** How wide `text` draws in the terminal's family, as the page's own canvas measures it. */
const widthIn = (page: Page, family: string, text: string) =>
  page.evaluate<number>(`(() => {
    const context = document.createElement("canvas").getContext("2d");
    context.font = ${JSON.stringify(`15px ${family}`)};
    return context.measureText(${JSON.stringify(text)}).width;
  })()`);

test("draws a terminal in the bundled font, loaded before it opens, an icon as wide as a letter", async ({
  page,
}) => {
  await launch(page);
  const family = String(await terminalFontFamily(page));
  expect(family).toMatch(/^"JetBrainsMono NFM", "JetBrainsMono NFM Symbols", /);
  expect(await bundledFaces(page)).toEqual(withStatus("loaded"));
  // U+E0B0, Powerline's divider, and U+F0001, a Material Design icon from plane 15.
  const letter = await widthIn(page, family, "W");
  expect([
    await widthIn(page, family, "\u{e0b0}"),
    await widthIn(page, family, "\u{f0001}"),
  ]).toEqual([letter, letter]);
});

test("opens a terminal on the fallback fonts when the bundled font can't load", async ({
  page,
}) => {
  await page.route("**/*.woff2", (route) => route.abort());
  await launch(page);
  expect(await screen(page)).toContain("Claude Code");
  expect(await bundledFaces(page)).toEqual(withStatus("error"));
});

test("opens a terminal once it has waited 5 s for a font that never arrives", async ({ page }) => {
  await page.route("**/*.woff2", () => undefined);
  const start = Date.now();
  await launch(page);
  expect(Date.now() - start).toBeGreaterThanOrEqual(5_000);
  expect(await bundledFaces(page)).toEqual(withStatus("loading"));
});
