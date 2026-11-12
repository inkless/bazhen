import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OUT, api, createTerm, deleteTerm, openView, save, waitForText } from "./helpers.ts";
const PROBE = new URL("../probe.ts", import.meta.url).pathname;
test("S7 Shift+Enter bytes at the pane: client encoding x tmux options x pane mode", async ({ page }) => {
  const rows: unknown[] = [];
  for (const ext of ["on", "always"]) for (const fmt of ["xterm", "csi-u"]) for (const menter of ["off", "csi27", "csiu"]) for (const pane of ["legacy", "mok2"]) {
    await api("POST", "/api/tmux", { args: ["set", "-g", "extended-keys", ext] }).catch(() => {});
    await api("POST", "/api/tmux", { args: ["set", "-g", "extended-keys-format", fmt] }).catch(() => {});
    const name = "s7p";
    const log = `${OUT}s7p.jsonl`;
    await createTerm(name, ["node", PROBE, log, ...(pane === "mok2" ? ["--mok=2"] : [])]);
    await api("POST", "/api/tmux", { args: ["set", "-g", "extended-keys", ext] });
    await api("POST", "/api/tmux", { args: ["set", "-g", "extended-keys-format", fmt] });
    await openView(page, name, `&menter=${menter}`);
    await waitForText(page, "probe ready");
    const got: Record<string, string> = {};
    for (const key of ["Shift+Enter", "Control+Enter", "Enter"]) {
      const n = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
      got[key] = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(n).map((l) => JSON.parse(l).vis).join(" ");
    }
    const r = { ext, fmt, menter, pane, ...got };
    rows.push(r);
    console.log(JSON.stringify(r));
    await deleteTerm(name);
  }
  save("s7-senter-probe.json", rows);
});
