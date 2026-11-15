import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, shellWithRc, waitUntil, type IntegratedShell } from "./daemon.ts";

/** The line docs/shell-integration.md gives each shell's rc file. */
const RC_LINE: Record<IntegratedShell, string> = {
  zsh: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/zsh ]] && source "$BAZHEN_SHELL_INTEGRATION/zsh"',
  bash: '[[ -n $BAZHEN_SHELL_INTEGRATION && -r $BAZHEN_SHELL_INTEGRATION/bash ]] && . "$BAZHEN_SHELL_INTEGRATION/bash"',
  fish: 'test -n "$BAZHEN_SHELL_INTEGRATION"; and test -r "$BAZHEN_SHELL_INTEGRATION/fish"; and source "$BAZHEN_SHELL_INTEGRATION/fish"',
};

/**
 * Each test shell's rc: a prompt that shows the last line's status, around the integration's line,
 * as a prompt framework would. bash's prompt reads the status in a prompt command set before the
 * integration's line, one that hands the status on and ends in `;`, and in one added after it, and
 * shows the lower of the two, so a hook that hands on another status shows 0 wherever it runs.
 */
const RC: Record<IntegratedShell, string> = {
  zsh: `${RC_LINE.zsh}\nPS1='[st=%?] '`,
  bash: [
    "__before_hook() { __before=$?; return $__before; }",
    "PROMPT_COMMAND='__before_hook;'",
    RC_LINE.bash,
    "PROMPT_COMMAND+=$'\\n''__after=$?'",
    "PS1='[st=$(( __before < __after ? __before : __after ))] '",
  ].join("\n"),
  fish: `${RC_LINE.fish}\nfunction fish_prompt; echo -n "[st=$status] "; end`,
};

const TYPED = `echo "$HOME" 'a  b'`;
const HIDDEN = " export TOKEN=s3cret-kept-out";

describe.each<IntegratedShell>(["zsh", "bash", "fish"])(
  "a %s shell with the integration on",
  (kind) => {
    let daemon: Daemon;
    let shell: ReturnType<typeof shellWithRc> | undefined;
    beforeAll(async () => {
      shell = shellWithRc(kind, RC[kind]);
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
    /**
     * A new shell, and a view driving it, once the shell has drawn its first prompt: a key typed
     * before its line editor starts can be lost, or taken by something its rc asks first.
     */
    async function driven() {
      const opened = await daemon.request("/v1/shells", {
        method: "POST",
        body: { idempotencyKey: `open-${++keys}`, cwd: daemon.work },
      });
      const { terminalId } = ShellCommandResponse.parse(opened.body);
      const view = await daemon.view(terminalId, "interactive");
      await view.drive();
      // Polled with expect, so a prompt that never comes fails showing what the screen did hold.
      await expect
        .poll(() => daemon.shellScreen(terminalId), { timeout: 20_000 })
        .toContain("[st=0]");
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

    it("leaves the prompt the status of the line that ran", async () => {
      const { terminalId, view } = await driven();
      view.type("false\r");
      await expect
        .poll(() => daemon.shellScreen(terminalId), { timeout: 15_000 })
        .toContain("[st=1]");
      view.type("true\r");
      await expect
        .poll(() => daemon.shellScreen(terminalId).trimEnd().split("\n").at(-1), {
          timeout: 15_000,
        })
        .toBe("[st=0]");
      view.close();
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
