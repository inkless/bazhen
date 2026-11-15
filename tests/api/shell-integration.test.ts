import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, shellWithRc, waitUntil, type IntegratedShell } from "./daemon.ts";

/** The line docs/shell-integration.md gives each shell's rc file. */
const RC_LINE: Record<IntegratedShell, string> = {
  zsh: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/zsh ]] && source "$BAZHEN_SHELL_INTEGRATION/zsh"',
  bash: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/bash ]] && . "$BAZHEN_SHELL_INTEGRATION/bash"',
  fish: 'test -n "$BAZHEN_SHELL_INTEGRATION"; and test -r "$BAZHEN_SHELL_INTEGRATION/fish"; and source "$BAZHEN_SHELL_INTEGRATION/fish"',
};

const TYPED = `echo "$HOME" 'a  b'`;
const HIDDEN = " export TOKEN=s3cret-kept-out";

describe.each<IntegratedShell>(["zsh", "bash", "fish"])(
  "a %s shell with the integration on",
  (kind) => {
    let daemon: Daemon;
    let shell: ReturnType<typeof shellWithRc> | undefined;
    beforeAll(async () => {
      shell = shellWithRc(kind, RC_LINE[kind]);
      daemon = await Daemon.start({
        config: "[shells]\nretype_last_command = true\n",
        env: { SHELL: shell.shell },
      });
    });
    afterAll(async () => {
      await daemon?.stop();
      shell?.cleanup();
    });

    let keys = 0;
    /** A new shell, and a view driving it. */
    async function driven() {
      const opened = await daemon.request("/v1/shells", {
        method: "POST",
        body: { idempotencyKey: `open-${++keys}`, cwd: daemon.work },
      });
      const { terminalId } = ShellCommandResponse.parse(opened.body);
      const view = await daemon.view(terminalId, "interactive");
      await view.drive();
      return { terminalId, view };
    }

    it("keeps the line as typed, and puts neither it nor the shell's token where a client or log sees", async () => {
      const { terminalId, view } = await driven();
      view.type(`${TYPED}\r`);
      await expect.poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 }).toBe(TYPED);
      view.type(`${HIDDEN}\r`);
      view.type("true\r");
      await expect.poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 }).toBe("true");
      const token = String(daemon.shellEnv(terminalId).BAZHEN_SHELL_TOKEN);

      const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
      const events = await daemon.events({ epoch: state.epoch, eventId: 0 });
      await daemon.caughtUp(events);
      const seen = {
        state: JSON.stringify(state),
        events: JSON.stringify(events.frames),
        log: daemon.log(),
      };
      events.close();
      view.close();
      const found = Object.entries(seen).flatMap(([where, text]) =>
        ["a  b", "s3cret", token]
          .filter((secret) => text.includes(secret))
          .map((secret) => `${secret} in ${where}`),
      );
      expect([token.length, found]).toEqual([43, []]);
    });

    it("forgets the shell's line once it exits", async () => {
      const { terminalId, view } = await driven();
      view.type("echo kept-until-exit\r");
      await expect
        .poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 })
        .toBe("echo kept-until-exit");
      view.type("exit\r");
      await waitUntil(async () => {
        const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
        return !state.shells.some((s) => s.id === terminalId);
      }, "the shell closed");
      view.close();
      expect(daemon.keptShellLine(terminalId)).toBeNull();
    });
  },
);
