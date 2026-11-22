// A slow prompt, a line typed ahead as the shell starts, and a shell with no line editor: these
// cases rest on the TypeScript daemon's prompt-waiter and its timing, and run against it as
// before. The Rust daemon is to cover them in its own tests, deterministically; until then this
// file stays off tests/rust-daemon.txt.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import { Daemon, shellWithRc, typeOnHolder, typesBack, type IntegratedShell } from "./daemon.ts";
import {
  DECLINED_WITHIN_MS,
  lastLine,
  notRetyped,
  RC_LINE,
  retypedAfterReboot,
} from "./shell-integration-shells.ts";

/**
 * Each test shell's rc for a prompt that takes a while to draw, as a git-aware one does, after the
 * integration's hook has run: a slow prompt, and in zsh a slow zle-line-init, in fish a slow right
 * prompt, which run after the editor has left canonical mode and before it asks for bracketed
 * paste. And, once `marker` exists, a Z key that types X instead. A line typed back before the
 * editor reads would show twice, echoed by the terminal and then by the editor; one typed as keys
 * would run the editor's binding for Z. Typed by hand into the first shell, before the marker
 * exists, a Z is a Z. bash's case tells only whether the wait for the editor works, not whether
 * the paste is marked: readline asks for bracketed paste as it leaves canonical mode, so a paste
 * typed after that is marked either way.
 */
const SLOW_RC: Record<IntegratedShell, (marker: string) => string> = {
  zsh: (marker) =>
    [
      RC_LINE.zsh,
      "setopt PROMPT_SUBST",
      "PS1='$(sleep 0.3)[st=%?] '",
      // In the shell's own process, as most widgets run: its process group keeps the foreground.
      "zmodload zsh/zselect",
      "zle-line-init() { zselect -t 30 }",
      "zle -N zle-line-init",
      `if [[ -e '${marker}' ]]; then __bz_z() { LBUFFER+=X }; zle -N __bz_z; bindkey Z __bz_z; fi`,
    ].join("\n"),
  bash: (marker) =>
    [RC_LINE.bash, "PS1='$(sleep 0.3)[st=0] '", `[[ -e '${marker}' ]] && bind '"Z": "X"'`].join(
      "\n",
    ),
  fish: (marker) =>
    [
      RC_LINE.fish,
      'function fish_prompt; sleep 0.3; echo -n "[st=0] "; end',
      "function fish_right_prompt; sleep 0.3; end",
      `test -e '${marker}'; and bind Z 'commandline -i X'`,
    ].join("\n"),
};

const SLOW_TYPED = `echo Z "$HOME"`;

/**
 * Whether a restarted shell's line was dropped, or is held back by the hook's copy still waiting
 * for the shell's editor, as it is while what a line typed ahead started reads: an editor that
 * read that line at once never left canonical mode for it.
 */
const heldBack = (daemon: Daemon, terminalId: string) => async () =>
  daemon.log().includes(`shell ${terminalId}: last command not retyped`) ||
  Daemon.promptWaiters(await daemon.terminalPid(terminalId)) === 1;

describe.each<IntegratedShell>(["zsh", "bash", "fish"])(
  "a %s shell whose prompt is slow to draw, restarted with its last line",
  (kind) => {
    let daemon: Daemon;
    let shell: ReturnType<typeof shellWithRc> | undefined;
    beforeAll(async () => {
      shell = shellWithRc(kind, SLOW_RC[kind]);
      daemon = await Daemon.start({
        config: "[shells]\nretype_last_command = true\n",
        env: { SHELL: shell.shell },
      });
    });
    afterAll(async () => {
      await daemon?.stop();
      shell?.cleanup();
    });

    it("types nothing behind a line typed ahead as the shell starts, which what it runs would read", async () => {
      shell?.unmark();
      const next = await retypedAfterReboot(daemon, "echo typed-back");
      // Typed straight into the new terminal as its shell starts, well before its slow prompt is
      // drawn, so it is read before anything pasted could be.
      const holder = String(daemon.holderAt(next));
      await typeOnHolder(holder, "cat > typed-ahead.out\r");
      const running = async () =>
        StateSnapshot.parse((await daemon.request("/v1/state")).body).shells.find(
          (s) => s.id === next,
        )?.foreground?.command;
      await expect.poll(running, { timeout: 20_000 }).toBe("cat");
      await expect.poll(heldBack(daemon, next), { timeout: 20_000 }).toBe(true);
      await typeOnHolder(holder, "\x04");
      await expect
        .poll(lastLine(daemon, next), { timeout: 20_000 })
        .toMatch(/^\[st=0\]( echo typed-back)?$/);
      expect(daemon.workFile("typed-ahead.out")).toBe("");
    }, 90_000);

    it.runIf(typesBack(kind))(
      "types the line once the editor reads, once, and as a paste rather than as keys",
      async () => {
        shell?.unmark();
        const next = await retypedAfterReboot(daemon, SLOW_TYPED, () => shell?.mark());
        await expect.poll(lastLine(daemon, next), { timeout: 20_000 }).toBe(`[st=0] ${SLOW_TYPED}`);
        const screen = await daemon.terminalScreen(next);
        expect([screen.split("echo").length - 1, screen.includes("X")]).toEqual([1, false]);
      },
    );

    it.runIf(!typesBack(kind))(
      "types no line back into a shell the integration won't type into, though its prompt is slow",
      async () => {
        shell?.unmark();
        const next = await retypedAfterReboot(daemon, SLOW_TYPED, () => shell?.mark());
        await expect
          .poll(() => daemon.log(), { timeout: DECLINED_WITHIN_MS })
          .toContain(notRetyped(next));
        // The shell says so as its first prompt starts, before the slow prompt is drawn.
        await expect.poll(lastLine(daemon, next), { timeout: 20_000 }).toBe("[st=0]");
        expect((await daemon.terminalScreen(next)).includes("X")).toBe(false);
      },
      DECLINED_WITHIN_MS + 60_000,
    );
  },
);

describe("a bash shell with no line editor", () => {
  let daemon: Daemon;
  let shell: ReturnType<typeof shellWithRc> | undefined;
  beforeAll(async () => {
    shell = shellWithRc("bash", `${RC_LINE.bash}\nset +o emacs +o vi\nPS1='[st=0] '`);
    daemon = await Daemon.start({
      config: "[shells]\nretype_last_command = true\n",
      env: { SHELL: shell.shell },
    });
  });
  afterAll(async () => {
    await daemon?.stop();
    shell?.cleanup();
  });

  it("leaves no copy of the hook waiting for an editor once the shell is gone", async () => {
    const opened = await daemon.request("/v1/shells", {
      method: "POST",
      body: { idempotencyKey: "open", cwd: daemon.work },
    });
    const { terminalId } = ShellCommandResponse.parse(opened.body);
    await expect
      .poll(() => daemon.terminalScreen(terminalId), { timeout: 20_000 })
      .toContain("[st=0]");
    const pid = await daemon.terminalPid(terminalId);
    // The terminal stays canonical, so the copy waits, for up to 10 s, until the shell has gone:
    // its terminal hangs up as the shell's closes, which ends the wait.
    await expect.poll(() => Daemon.promptWaiters(pid), { timeout: 5_000 }).toBe(1);
    const view = await daemon.view(terminalId, "interactive");
    await view.drive();
    view.type("exit\r");
    await expect.poll(() => Daemon.promptWaiters(pid), { timeout: 3_000 }).toBe(0);
    view.close();
  });
});
