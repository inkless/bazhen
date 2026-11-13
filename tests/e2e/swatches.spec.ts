import { expect, test } from "@playwright/test";

test("the dev swatch page shows every colour token in both themes, resolved differently", async ({
  page,
}) => {
  await page.goto("/swatches.html");
  const light = page.getByRole("table", { name: "light theme" });
  const dark = page.getByRole("table", { name: "dark theme" });
  await expect(light.getByRole("row")).not.toHaveCount(0);
  await expect(dark.getByRole("row")).toHaveCount(await light.getByRole("row").count());

  // Each table is drawn in --color-bg under its own color-scheme. Runs in the page, which has the
  // DOM this package's types leave out.
  const [lightBg, darkBg]: unknown[] = await page.evaluate(
    '[...document.querySelectorAll("table")].map((t) => getComputedStyle(t).backgroundColor)',
  );
  expect(lightBg).toEqual(expect.any(String));
  expect(lightBg).not.toBe(darkBg);
});
