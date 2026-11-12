import { test } from "@playwright/test";
import { OUT, capture, createTerm, deleteTerm, openView, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

for (const which of ["claude", "codex"] as const) {
  test(`S3 smoke ${which}`, async ({ page }) => {
    const env = await setupTuis();
    try {
      const l = env[which];
      await createTerm(`s3-${which}`, l.argv, { cwd: l.cwd, env: l.env, cols: 120, rows: 36 });
      await page.waitForTimeout(4000);
      await openView(page, `s3-${which}`);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}s3-smoke-${which}-1.png` });
      console.log(which, "VIEW\n" + (await viewport(page)).join("\n"));
      await page.keyboard.type(which === "claude" ? "hello [[fake:plain]]" : "hello there");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(5000);
      await page.screenshot({ path: `${OUT}s3-smoke-${which}-2.png` });
      console.log(which, "AFTER\n" + (await viewport(page)).join("\n"));
      console.log(which, "CAPTURE\n" + (await capture(`s3-${which}`)));
    } finally {
      await deleteTerm(`s3-${which}`);
      env.cleanup();
    }
  });
}
