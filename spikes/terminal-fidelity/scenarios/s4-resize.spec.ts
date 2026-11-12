import { devices, test, type Page } from "@playwright/test";
import { OUT, SHELL, SHELL_ENV, capture, createTerm, deleteTerm, info, openView, save, viewport } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";

const LONG = { claude: "show [[fake:long:80]]", codex: "show LONG:80", shell: "seq -f 'shell line %04g' 1 80" };

const state = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).spike;
    return { driver: s.driver, epoch: s.epoch, cols: s.term.cols, rows: s.term.rows };
  });

/** Rows where a view's visible text differs from tmux's own screen: stale or torn cells. */
async function staleRows(p: Page, name: string): Promise<{ row: number; view: string; tmux: string }[]> {
  const v = await viewport(p);
  const t = (await capture(name)).split("\n");
  const out = [];
  for (let i = 0; i < Math.min(v.length, t.length); i++)
    if ((v[i] ?? "").trimEnd() !== (t[i] ?? "").trimEnd()) out.push({ row: i, view: v[i] ?? "", tmux: t[i] ?? "" });
  return out;
}

async function snapshot(label: string, laptop: Page, phone: Page, name: string) {
  await laptop.waitForTimeout(1200);
  const i = await info(name);
  const r = {
    label,
    tmuxWindowPane: i.tmux.split(" ").slice(0, 2).join(" "),
    serverSize: i.size,
    epoch: i.epoch,
    laptop: await state(laptop),
    phone: await state(phone),
    laptopStale: (await staleRows(laptop, name)).slice(0, 3),
    phoneStale: (await staleRows(phone, name)).slice(0, 3),
    resizes: i.resizes,
  };
  await laptop.screenshot({ path: `${OUT}s4-${name}-${label}-laptop.png` });
  await phone.screenshot({ path: `${OUT}s4-${name}-${label}-phone.png` });
  return r;
}

for (const which of ["shell", "claude", "codex"] as const) {
  test(`S4 laptop to phone resize: ${which}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const env = which === "shell" ? null : await setupTuis();
    const name = `s4-${which}`;
    const results: unknown[] = [];
    const lctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pctx = await browser.newContext({ ...devices["Pixel 7"] });
    try {
      if (env) {
        const l = env[which as "claude" | "codex"];
        await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
      } else await createTerm(name, SHELL, { env: SHELL_ENV });
      await new Promise((r) => setTimeout(r, 2500));
      const laptop = await lctx.newPage();
      await openView(laptop, name);
      await laptop.waitForTimeout(2000);
      await laptop.keyboard.type(LONG[which], { delay: 30 });
      await laptop.keyboard.press("Enter");
      await laptop.waitForTimeout(3000);

      // The phone opens: it focuses on load, so it takes the lease (automatic takeover, FD §4.3).
      const phone = await pctx.newPage();
      await phone.goto(`/?name=${name}&font=12`);
      await phone.waitForFunction(() => (window as any).spike?.connected && (window as any).spike.snapshot.ended > 0);
      results.push(await snapshot("laptop-only-then-phone-joins", laptop, phone, name));

      // Phone taps the terminal (touch): stays/becomes driver.
      await phone.locator(".xterm-screen").tap();
      results.push(await snapshot("phone-driver", laptop, phone, name));

      // Laptop clicks back in: takeover, window grows back.
      await laptop.locator(".xterm-screen").click();
      results.push(await snapshot("laptop-driver", laptop, phone, name));

      // Phone again, then a soft keyboard opening: viewport height shrinks over ~300 ms in steps.
      await phone.locator(".xterm-screen").tap();
      await phone.waitForTimeout(1000);
      const before = (await info(name)).resizes;
      const vp = phone.viewportSize()!;
      for (let h = vp.height; h >= vp.height - 330; h -= 30) {
        await phone.setViewportSize({ width: vp.width, height: h });
        await phone.waitForTimeout(25);
      }
      const keyboard = await snapshot("phone-soft-keyboard", laptop, phone, name);
      results.push({ ...keyboard, resizesDuringKeyboardAnimation: keyboard.resizes - before });
      await phone.setViewportSize(vp);
      results.push(await snapshot("phone-keyboard-closed", laptop, phone, name));

      // Phone typing while laptop is driver: dropped and takes the lease (input without the lease).
      await laptop.locator(".xterm-screen").click();
      await laptop.waitForTimeout(800);
      const drops = await phone.evaluate(() => {
        // Simulate a keystroke from a view that is no longer the driver, without a focus event.
        const s = (window as any).spike;
        s.term.input("z", true);
        return s.driver;
      });
      await phone.waitForTimeout(800);
      const i = await info(name);
      results.push({ label: "phone-input-without-lease", phoneWasDriver: drops, views: i.views, epoch: i.epoch, capturedHasZ: (await capture(name)).includes("z") });
    } finally {
      save(`s4-${which}.json`, results);
      for (const r of results) console.log(which, JSON.stringify(r));
      await lctx.close();
      await pctx.close();
      await deleteTerm(name);
      env?.cleanup();
    }
  });
}
