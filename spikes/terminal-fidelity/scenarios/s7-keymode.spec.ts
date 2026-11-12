import { test } from "@playwright/test";
import { api, createTerm, deleteTerm, openView } from "./helpers.ts";
import { setupTuis } from "./tuis.ts";
test("S7 which key mode each TUI requests", async ({ page }) => {
  const env = await setupTuis();
  try {
    for (const which of ["claude", "codex"] as const) {
      const l = env[which];
      const name = `s7k-${which}`;
      await createTerm(name, l.argv, { cwd: l.cwd, env: l.env });
      await openView(page, name);
      await page.waitForTimeout(4000);
      const out = await api("POST", "/api/tmux", { args: ["display-message", "-p", "-t", `bz-${name}:0`, "#{pane_key_mode} | ext=#{extended-keys} fmt=#{extended-keys-format}"] });
      const opts = await api("POST", "/api/tmux", { args: ["show", "-g", "extended-keys"] });
      const fmt = await api("POST", "/api/tmux", { args: ["show", "-g", "extended-keys-format"] });
      console.log(which, JSON.stringify({ keyMode: out.out.trim(), global: opts.out.trim(), format: fmt.out.trim() }));
      await deleteTerm(name);
    }
  } finally {
    env.cleanup();
  }
});
