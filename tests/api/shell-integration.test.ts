import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellCommandResponse, StateSnapshot } from "@bazhen/protocol";
import {
  Daemon,
  shellWithRc,
  typeOnHolder,
  typesBack,
  waitUntil,
  type IntegratedShell,
} from "./daemon.ts";
import { closeHoldersUnder } from "../support/holder-close.ts";

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

/**
 * A background job started and its pid shown, then shown again after another line has run. Its pid
 * is never quoted, where zsh would read `!"` as history expansion. It ends by itself.
 */
const BACKGROUND: Record<IntegratedShell, { start: string; show: string }> = {
  zsh: { start: "sleep 1 & echo bg=$!", show: "echo now=$!" },
  bash: { start: "sleep 1 & echo bg=$!", show: "echo now=$!" },
  fish: { start: "sleep 1 &; echo bg=$last_pid", show: "echo now=$last_pid" },
};
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
        .poll(() => daemon.terminalScreen(terminalId), { timeout: 20_000 })
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
      const token = String((await daemon.terminalEnv(terminalId)).BAZHEN_SHELL_TOKEN);

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
        .poll(() => daemon.terminalScreen(terminalId), { timeout: 15_000 })
        .toContain("[st=1]");
      view.type("true\r");
      await expect
        .poll(async () => (await daemon.terminalScreen(terminalId)).trimEnd().split("\n").at(-1), {
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

    it("leaves the user's last background job as the shell's own", async () => {
      const { terminalId, view } = await driven();
      view.type(`${BACKGROUND[kind].start}\r`);
      await expect
        .poll(() => daemon.terminalScreen(terminalId), { timeout: 15_000 })
        .toMatch(/^bg=\d+$/m);
      view.type("true\r");
      view.type(`${BACKGROUND[kind].show}\r`);
      await expect
        .poll(() => daemon.terminalScreen(terminalId), { timeout: 15_000 })
        .toMatch(/^now=\d+$/m);
      const screen = await daemon.terminalScreen(terminalId);
      const started = /^bg=(\d+)$/m.exec(screen)?.[1];
      const now = /^now=(\d+)$/m.exec(screen)?.[1];
      view.close();
      expect(now).toBe(started);
    });

    // These two come last, and only one of them runs: each ends the daemon and every terminal, as a
    // reboot would.
    it.runIf(typesBack(kind))(
      "types the line back at a restarted shell's prompt, exactly and without running it",
      async () => {
        const { terminalId, view } = await driven();
        view.type(`${TYPED}\r`);
        await expect.poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 }).toBe(TYPED);
        const ran = `${(await daemon.terminalEnv(terminalId)).HOME} a  b`;
        view.close();
        await daemon.crash();
        await closeHoldersUnder(daemon.home);
        await daemon.restart();

        const lost = StateSnapshot.parse((await daemon.request("/v1/state")).body).shells.find(
          (s) => s.id === terminalId,
        );
        expect([lost?.state, lost?.retypeable]).toEqual(["lost", true]);
        const restarted = await daemon.request(`/v1/shells/${terminalId}/restart`, {
          method: "POST",
          body: { idempotencyKey: "retype", generation: lost?.generation, retype: true },
        });
        const { terminalId: next } = ShellCommandResponse.parse(restarted.body);
        const lastLine = async () =>
          (await daemon.terminalScreen(next)).trimEnd().split("\n").at(-1);
        await expect.poll(lastLine, { timeout: 20_000 }).toBe(`[st=0] ${TYPED}`);
        // Had Enter been pressed, the line's output and a new prompt would follow it.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect([await lastLine(), (await daemon.terminalScreen(next)).includes(ran)]).toEqual([
          `[st=0] ${TYPED}`,
          false,
        ]);

        const state = StateSnapshot.parse((await daemon.request("/v1/state")).body);
        const events = await daemon.events({ epoch: state.epoch, eventId: 0 });
        await daemon.caughtUp(events);
        const seen = { events: JSON.stringify(events.frames), log: daemon.log() };
        events.close();
        expect([
          seen.events.includes("a  b"),
          seen.log.includes("a  b"),
          daemon.keptShellLine(terminalId),
          daemon.keptShellLine(next),
        ]).toEqual([false, false, null, null]);
      },
    );

    it.runIf(!typesBack(kind))(
      "types no line back into a shell the integration won't type into, and logs why",
      async () => {
        const next = await retypedAfterReboot(daemon, TYPED);
        await expect
          .poll(() => daemon.log(), { timeout: DECLINED_WITHIN_MS })
          .toContain(notRetyped(next));
        expect([
          await lastLine(daemon, next)(),
          (await daemon.terminalScreen(next)).includes("a  b"),
        ]).toEqual(["[st=0]", false]);
      },
      DECLINED_WITHIN_MS + 60_000,
    );
  },
);

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
 * Runs `line` in a new shell, then ends the daemon and every terminal, as a reboot would; runs
 * `before` and starts the daemon again; and restarts the shell, asking for its line typed back.
 * Resolves with the new shell.
 */
async function retypedAfterReboot(daemon: Daemon, line: string, before = () => {}) {
  const opened = await daemon.request("/v1/shells", {
    method: "POST",
    body: { idempotencyKey: `open-${line}`, cwd: daemon.work },
  });
  const { terminalId } = ShellCommandResponse.parse(opened.body);
  const view = await daemon.view(terminalId, "interactive");
  await view.drive();
  await expect
    .poll(() => daemon.terminalScreen(terminalId), { timeout: 20_000 })
    .toContain("[st=0]");
  view.type(`${line}\r`);
  await expect.poll(() => daemon.keptShellLine(terminalId), { timeout: 15_000 }).toBe(line);
  view.close();
  await daemon.crash();
  await closeHoldersUnder(daemon.home);
  before();
  await daemon.restart();
  const restarted = await daemon.request(`/v1/shells/${terminalId}/restart`, {
    method: "POST",
    body: { idempotencyKey: `retype-${line}`, generation: 0, retype: true },
  });
  return ShellCommandResponse.parse(restarted.body).terminalId;
}

/**
 * Whether a restarted shell's line was dropped, or is held back by the hook's copy still waiting
 * for the shell's editor, as it is while what a line typed ahead started reads: an editor that
 * read that line at once never left canonical mode for it.
 */
const heldBack = (daemon: Daemon, terminalId: string) => async () =>
  daemon.log().includes(`shell ${terminalId}: last command not retyped`) ||
  Daemon.promptWaiters(await daemon.terminalPid(terminalId)) === 1;

/**
 * What the daemon logs for a restarted shell whose integration said at its first prompt that it
 * won't take a line typed back.
 */
const notRetyped = (terminalId: string) =>
  `shell ${terminalId}: last command not retyped: the shell's integration said it can't take a line typed back`;
/**
 * Well inside the 30 s the daemon holds a line for a shell that reports no prompt, so a line
 * dropped only then fails the wait.
 */
const DECLINED_WITHIN_MS = 15_000;

const lastLine = (daemon: Daemon, terminalId: string) => async () =>
  (await daemon.terminalScreen(terminalId)).trimEnd().split("\n").at(-1);

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

/**
 * Each test shell's rc with the line editor told to take no bracketed paste, in a UTF-8 locale
 * and, once `marker` exists, a C locale, as a daemon a service manager started without LANG gives its shells: there
 * the line can only arrive as keys.
 */
const KEYS_RC: Record<"zsh" | "bash", (marker: string) => string> = {
  zsh: (marker) =>
    [
      RC_LINE.zsh,
      "PS1='[st=%?] '",
      // The zle module sets zle_bracketed_paste as it loads, so it is loaded before the unset.
      "zmodload zsh/zle",
      "unset zle_bracketed_paste",
      "bindkey -r '^[[200~'",
      `if [[ -e '${marker}' ]]; then export LC_ALL=C; else export LC_ALL=C.UTF-8; fi`,
    ].join("\n"),
  bash: (marker) =>
    [
      RC_LINE.bash,
      "PS1='[st=0] '",
      "bind 'set enable-bracketed-paste off'",
      `if [[ -e '${marker}' ]]; then export LC_ALL=C; else export LC_ALL=C.UTF-8; fi`,
    ].join("\n"),
};

describe.each<"zsh" | "bash">(["zsh", "bash"])(
  "a %s shell whose line editor takes no bracketed paste, restarted with its last line",
  (kind) => {
    let daemon: Daemon;
    let shell: ReturnType<typeof shellWithRc> | undefined;
    beforeAll(async () => {
      shell = shellWithRc(kind, KEYS_RC[kind]);
      daemon = await Daemon.start({
        config: "[shells]\nretype_last_command = true\n",
        env: { SHELL: shell.shell },
      });
    });
    afterAll(async () => {
      await daemon?.stop();
      shell?.cleanup();
    });

    it("types a printable ASCII line back as keys, with no bracketed-paste sequence", async () => {
      shell?.unmark();
      const next = await retypedAfterReboot(daemon, "echo plain-ascii", () => shell?.mark());
      await expect
        .poll(lastLine(daemon, next), { timeout: 20_000 })
        .toBe("[st=0] echo plain-ascii");
      const screen = await daemon.terminalScreen(next);
      expect([screen.includes("200~"), screen.includes("201~")]).toEqual([false, false]);
    });

    // Typed as keys in a C locale, é's bytes would be meta keys.
    it("types back no line beyond printable ASCII, and logs that it didn't", async () => {
      shell?.unmark();
      const next = await retypedAfterReboot(daemon, "echo café", () => shell?.mark());
      await expect
        .poll(() => daemon.log(), { timeout: 20_000 })
        .toContain(`shell ${next}: last command not retyped`);
      expect([await lastLine(daemon, next)(), daemon.log().includes("café")]).toEqual([
        "[st=0]",
        false,
      ]);
    });
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
