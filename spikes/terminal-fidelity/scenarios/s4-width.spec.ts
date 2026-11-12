import { devices, test } from "@playwright/test";
import { capture, createTerm, deleteTerm, info, openView, save, viewport } from "./helpers.ts";
const SIM = new URL("../tui-sim.ts", import.meta.url).pathname;
test("S4 stale cells after shrink, by content kind", async ({ browser }) => {
  const out: unknown[] = [];
  for (const kind of ["ascii", "cjk", "emoji", "combining"]) {
    const name = `s4w-${kind}`;
    await createTerm(name, ["node", SIM, kind]);
    const lctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pctx = await browser.newContext({ ...devices["Pixel 7"] });
    try {
      const laptop = await lctx.newPage();
      await openView(laptop, name);
      await laptop.waitForTimeout(800);
      const phone = await pctx.newPage();
      await phone.goto(`/?name=${name}&font=12`);
      await phone.waitForTimeout(1500);
      const v = await viewport(phone);
      const lv = await viewport(laptop);
      const h = (await info(name)).headless;
      const hv = h.lines.slice(h.baseY, h.baseY + 3);
      const t = (await capture(name)).split("\n");
      const diff = (a: string[]) => a.slice(0, 10).filter((x, i) => x.trimEnd() !== (t[i] ?? "").trimEnd()).length;
      const r = { kind, phoneRowsDiffer: diff(v), laptopObserverRowsDiffer: diff(lv), headlessRowsDiffer: diff(h.lines.slice(h.baseY, h.baseY + 10)), row0: { phone: v[0], headless: hv[0], tmux: t[0] } };
      out.push(r);
      console.log(JSON.stringify(r));
    } finally {
      await lctx.close(); await pctx.close(); await deleteTerm(name);
    }
  }
  save("s4-width.json", out);
});
