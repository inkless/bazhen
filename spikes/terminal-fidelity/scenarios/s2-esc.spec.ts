import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { OUT, api, createTerm, deleteTerm, openView, save, waitForText } from "./helpers.ts";

const PROBE = new URL("../probe.ts", import.meta.url).pathname;
const VARIANTS: [string, string[][]][] = [
  ["baseline", []],
  ["escape-time 1", [["set", "-g", "escape-time", "1"]]],
  ["escape-time 10", [["set", "-g", "escape-time", "10"]]],
  ["extended-keys off", [["set", "-g", "extended-keys", "off"]]],
  ["extkeys off + escape-time 10", [["set", "-g", "extended-keys", "off"], ["set", "-g", "escape-time", "10"]]],
];

test("S2 lone Esc delivery by tmux option", async ({ page }) => {
  const results: unknown[] = [];
  for (const [label, sets] of VARIANTS) {
    // reset to the repo config's values, then apply the variant
    await api("POST", "/api/tmux", { args: ["set", "-g", "escape-time", "0"] }).catch(() => {});
    await api("POST", "/api/tmux", { args: ["set", "-g", "extended-keys", "on"] }).catch(() => {});
    const log = `${OUT}s2-esc.jsonl`;
    await createTerm("s2-esc", ["node", PROBE, log]);
    for (const s of sets) await api("POST", "/api/tmux", { args: s });
    const shown = await api("POST", "/api/tmux", { args: ["show", "-g", "escape-time"] });
    await openView(page, "s2-esc");
    await waitForText(page, "probe ready");
    const read = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).vis);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const afterEsc = read();
    await page.keyboard.press("x");
    await page.waitForTimeout(200);
    const r = { label, shown: shown.out.trim(), afterEsc400ms: afterEsc, afterX: read() };
    results.push(r);
    console.log(JSON.stringify(r));
    await deleteTerm("s2-esc");
  }
  save("s2-esc.json", results);
});
