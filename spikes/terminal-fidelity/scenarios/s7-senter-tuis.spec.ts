import { test, type Page } from "@playwright/test";
import { createTerm, deleteTerm, openView, save, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const READY = { claude: /❯/, codex: /›/ };
async function classify(page: Page): Promise<string> {
  const v = (await viewport(page)).join("\n");
  const lines = v.split("\n");
  const a = lines.map((x) => x.includes("alpha")).lastIndexOf(true);
  const b = lines.map((x) => x.includes("beta")).lastIndexOf(true);
  if (/⏺ ok|echo: alpha/.test(v)) return "submitted";
  return b === a + 1 ? "newline" : b === a ? "same line" : `other (${a},${b})`;
}

test("S7 Shift+Enter in the real TUIs, by client encoding", async ({ page }) => {
  test.setTimeout(600_000);
  const env = await setupTuis();
  const rows: unknown[] = [];
  try {
    for (const which of ["claude", "codex"] as const) for (const menter of (process.env["MENTERS"] ?? "off,csi27,csiu,esccr,lf").split(",")) {
      const name = `s7t-${which}`;
      const l = env[which];
      await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
      await page.waitForTimeout(2500);
      await openView(page, name, `&menter=${menter}`);
      for (let i = 0; i < 100 && !READY[which].test((await viewport(page)).join("\n")); i++) await page.waitForTimeout(100);
      await page.waitForTimeout(1000);
      const r: Record<string, string> = { which, menter };
      await page.keyboard.type("alpha", { delay: 30 });
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("beta", { delay: 30 });
      await page.waitForTimeout(1500);
      r["Shift+Enter"] = await classify(page);
      rows.push(r);
      console.log(JSON.stringify(r));
      await deleteTerm(name);
    }
  } finally {
    save(`s7-senter-tuis${process.env["TAG"] ?? ""}.json`, rows);
    env.cleanup();
  }
});
