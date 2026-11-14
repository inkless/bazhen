import { afterAll, describe, expect, it } from "vitest";
import type { TerminalTags } from "@bazhen/core";
import { filterEnv, newId } from "@bazhen/core";
import { HISTORY_LINES } from "@bazhen/protocol";
import { sessionName, TmuxError, TmuxRuntime } from "@bazhen/runtime-tmux";
import { nodePtySpawner } from "@bazhen/daemon/pty";
import { TerminalHub } from "@bazhen/daemon/stream";
import { ptyHandleCount, sleep, testServer, tmuxOut } from "./helpers.ts";

const server = testServer("runtime");
// As if `bazhen start` ran inside another Claude Code session, with a token of the user's own.
const launchedFrom = { ...process.env, CLAUDECODE: "1", BZ_USER_VALUE: "kept" };
const runtime = new TmuxRuntime({
  server,
  pty: nodePtySpawner,
  env: filterEnv(launchedFrom).env,
});
const size = { cols: 100, rows: 30 };
const spec = (
  argv: [string, ...string[]],
  tags: TerminalTags = { kind: "agent", agentId: newId("agent") },
) => ({
  terminalId: newId("term"),
  tags,
  argv,
  cwd: process.cwd(),
  env: {},
  size,
  generation: 0,
});

afterAll(() => server.kill());

const screen = (session: string | undefined) =>
  tmuxOut(server, "capture-pane", "-p", "-t", `${String(session)}:0`);

describe("tmux runtime on a private server", () => {
  it("gives a new terminal its full history, on a server an older daemon started with less", async () => {
    await runtime.create(spec(["sleep", "30"]));
    tmuxOut(server, "set-option", "-g", "history-limit", "50");
    const ref = await runtime.create(spec(["sleep", "30"]));
    expect(
      tmuxOut(
        server,
        "display-message",
        "-p",
        "-t",
        String(ref.locator.paneId),
        "#{history_limit}",
      ).trim(),
    ).toBe(String(HISTORY_LINES));
  });

  it("attaches with the whole of a history longer than a megabyte", async () => {
    const wide = {
      ...spec(["sh", "-c", "seq -f '%0999g' 1 2000; echo done; sleep 30"]),
      size: { cols: 200, rows: 30 },
    };
    const ref = await runtime.create(wide);
    await expect.poll(() => screen(ref.locator.session), { timeout: 10_000 }).toContain("done");
    const { stream, history } = await runtime.attach(ref, null, HISTORY_LINES);
    stream.close();
    // Whole lines up to the screen, so the capture wasn't cut short. The very last row above the
    // screen can be the start of a line the screen goes on with.
    expect([history.length > 1024 * 1024, history.split("\n").at(-2)]).toEqual([
      true,
      expect.stringMatching(/^\d{999}$/),
    ]);
  });

  it("opens on the most recent history that fits, when a whole history is too large", async () => {
    const small = new TmuxRuntime({
      server,
      pty: nodePtySpawner,
      env: filterEnv(launchedFrom).env,
      captureMaxBytes: 256 * 1024,
    });
    // 2,000 lines of 50 cells, each in its own 24-bit foreground and background: about 4 MB.
    const art =
      'awk \'BEGIN { for (i = 1; i <= 2000; i++) { s = ""; for (j = 0; j < 50; j++) ' +
      's = s sprintf("\\033[38;2;%d;%d;100;48;2;%d;%d;50m\\342\\226\\200", i % 256, j * 5, j * 5, i % 256); ' +
      'print s "\\033[0m " i } print "done" }\'; sleep 30';
    const ref = await small.create(spec(["sh", "-c", art]));
    await expect.poll(() => screen(ref.locator.session), { timeout: 10_000 }).toContain("done");
    const { stream, history } = await small.attach(ref, null, HISTORY_LINES);
    stream.close();
    const numbers = history.split("\n").map((line) => Number(/ (\d+)$/.exec(line)?.[1]));
    const onScreen = Number(/ (\d+)$/m.exec(screen(ref.locator.session))?.[1]);
    expect([
      history.includes("\x1b[38;2;"),
      numbers.length > 0,
      numbers.length < 2000,
      numbers.every((n, i) => n === onScreen - numbers.length + i),
    ]).toEqual([true, true, true, true]);
  });

  it("reads its terminals back when started without a UTF-8 locale", async () => {
    const bare = testServer("runtime-no-locale");
    const { LANG: _l, LC_ALL: _a, LC_CTYPE: _c, ...noLocale } = filterEnv(process.env).env;
    try {
      const plain = new TmuxRuntime({ server: bare, pty: nodePtySpawner, env: noLocale });
      const s = spec(["cat"]);
      const ref = await plain.create(s);
      expect(ref.locator.session).toBe(sessionName(s.terminalId));
      const found = (await plain.inventory()).find((e) => e.ref.terminalId === s.terminalId);
      expect(found?.ref.locator).toEqual(ref.locator);
    } finally {
      bare.kill();
    }
  });

  it("keeps the browser on its normal screen, where it has scrollback", async () => {
    const ref = await runtime.create(spec(["sh", "-c", "echo on-screen; sleep 30"]));
    const { stream } = await runtime.attach(ref, size, 0);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("latin1")));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("on-screen");
    expect(seen).not.toContain("\x1b[?1049h");
    stream.close();
  });

  it("sends a themed terminal's blank cells to its client in the theme's colours, as truecolour", async () => {
    const ref = await runtime.create({ ...spec(["sleep", "30"]), theme: "light" });
    const { stream } = await runtime.attach(ref, size, 0);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("latin1")));
    // The light theme's text #202225 and background #fdfdfd, which the browser then draws as given.
    await expect
      .poll(() => seen, { timeout: 3000 })
      .toContain("\x1b[38;2;32;34;37m\x1b[48;2;253;253;253m");
    stream.close();
  });

  it("passes Ctrl-B to the program instead of treating it as a tmux prefix", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const { stream } = await runtime.attach(ref, size, 0);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    stream.write(Buffer.from("\x02c"));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("^B");
    const session = ref.locator.session;
    expect(session).toBeTypeOf("string");
    const windows = tmuxOut(server, "list-windows", "-t", String(session));
    expect(windows.trim().split("\n")).toHaveLength(1);
    stream.close();
  });

  it("keeps a trailing semicolon in an argv element", async () => {
    const ref = await runtime.create(spec(["sh", "-c", 'printf "<%s>" "$1"; sleep 30', "_", "x;"]));
    const { stream } = await runtime.attach(ref, size, 0);
    let seen = "";
    stream.onData((b) => (seen += Buffer.from(b).toString("utf8")));
    await expect.poll(() => seen, { timeout: 3000 }).toContain("<x;>");
    stream.close();
  });

  it("gives a pane the filtered environment and Bazhen's variables, never the daemon's own", async () => {
    process.env["BZ_DAEMON_ONLY"] = "leaked";
    try {
      const ref = await runtime.create({
        ...spec([
          "sh",
          "-c",
          'printf "<%s|%s|%s|%s>" "$BZ_USER_VALUE" "$BAZHEN_AGENT_ID" "${CLAUDECODE-unset}" "${BZ_DAEMON_ONLY-unset}"; sleep 30',
        ]),
        env: { BAZHEN_AGENT_ID: "agent-x" },
      });
      await expect
        .poll(() => screen(ref.locator.session), { timeout: 3000 })
        .toContain("<kept|agent-x|unset|unset>");
    } finally {
      delete process.env["BZ_DAEMON_ONLY"];
    }
  });

  it("keeps the user's values in the server's memory, never in a session's tmux argv", async () => {
    const ref = await runtime.create({ ...spec(["cat"]), env: { BAZHEN_AGENT_ID: "agent-x" } });
    const session = String(ref.locator.session);
    expect(tmuxOut(server, "show-environment", "-g")).toContain("BZ_USER_VALUE=kept");
    expect(tmuxOut(server, "show-environment", "-t", session)).not.toContain("BZ_USER_VALUE");
    expect(tmuxOut(server, "show-environment", "-t", session)).toContain("BAZHEN_AGENT_ID=agent-x");
  });

  it("copies no attaching client's variables into the session", () => {
    // An empty array option prints only its name; the default lists DISPLAY, SSH_AUTH_SOCK, …
    expect(tmuxOut(server, "show-options", "-g", "update-environment").trim()).toBe(
      "update-environment",
    );
  });

  it("ignores a session carrying a terminal id but no kind, as Bazhen never writes one", async () => {
    const forged = newId("term");
    tmuxOut(server, "new-session", "-d", "-s", "foreign", "cat");
    tmuxOut(server, "set-option", "-t", "foreign", "@bazhen_terminal_id", forged);
    const ids = (await runtime.inventory()).map((e) => e.ref.terminalId);
    expect(ids).not.toContain(forged);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("reports a failed tmux command as a TmuxError carrying what tmux said", async () => {
    const s = spec(["cat"]);
    await runtime.create(s);
    const error: unknown = await runtime.create(s).catch((e: unknown) => e);
    expect(error).toMatchObject({
      args: expect.arrayContaining(["new-session"]),
      stderr: expect.stringMatching(/duplicate session/),
    });
    expect(error).toBeInstanceOf(TmuxError);
  });

  it("reports a resize that fails, instead of dropping the error", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const { stream } = await runtime.attach(ref, size, 0);
    await runtime.close(ref);
    await expect(stream.resize({ cols: 80, rows: 24 })).rejects.toThrow(TmuxError);
    stream.close();
  });

  it("tells whether the program is drawing on its alternate screen", async () => {
    const ref = await runtime.create(
      spec(["sh", "-c", "printf main; sleep 0.5; printf '\\033[?1049halt'; sleep 30"]),
    );
    const { stream } = await runtime.attach(ref, size, 0);
    const before = await stream.alternateScreen();
    await expect.poll(() => screen(ref.locator.session), { timeout: 3000 }).toContain("alt");
    expect([before, await stream.alternateScreen()]).toEqual([false, true]);
    stream.close();
  });

  it("keeps blank lines at the end of the history", async () => {
    const ref = await runtime.create(
      spec([
        "sh",
        "-c",
        'seq 1 40; echo; echo; echo; for i in $(seq 1 29); do echo "screen $i"; done; printf "end"; sleep 30',
      ]),
    );
    await expect.poll(() => screen(ref.locator.session), { timeout: 3000 }).toContain("end");
    const { stream, history } = await runtime.attach(ref, size, 6);
    expect(history.split("\n")).toEqual(["38", "39", "40", "", "", ""]);
    stream.close();
  });

  it("attaches with no history for a program on its alternate screen", async () => {
    const ref = await runtime.create(
      spec(["sh", "-c", "seq 1 100; printf '\\033[?1049hon the alternate screen'; sleep 30"]),
    );
    await expect
      .poll(() => screen(ref.locator.session), { timeout: 3000 })
      .toContain("on the alternate screen");
    const { stream, history, alternate } = await runtime.attach(ref, size, 50);
    expect([history, alternate]).toEqual(["", true]);
    stream.close();
  });

  it("attaches with no history when the program's output still fits on the screen", async () => {
    const ref = await runtime.create(spec(["sh", "-c", "echo only-line; sleep 30"]));
    await expect.poll(() => screen(ref.locator.session), { timeout: 3000 }).toContain("only-line");
    const { stream, history } = await runtime.attach(ref, size, 5);
    expect(history).toBe("");
    stream.close();
  });

  it("attaches with the history just above the screen, including lines a smaller client pushed off it", async () => {
    const ref = await runtime.create(
      spec(["sh", "-c", 'for i in $(seq 1 100); do echo "line $i"; done; sleep 30']),
    );
    await expect.poll(() => screen(ref.locator.session), { timeout: 3000 }).toContain("line 100");
    const { stream, history } = await runtime.attach(ref, { cols: 100, rows: 20 }, 5);
    const top = Number(/line (\d+)/.exec(screen(ref.locator.session))?.[1]);
    expect(history.split("\n")).toEqual([5, 4, 3, 2, 1].map((back) => `line ${top - back}`));
    stream.close();
  });

  it("returns to its PTY baseline after views come and go through the daemon's hub", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const hub = new TerminalHub(runtime, {
      started: () => {},
      ended: () => {},
      granted: () => {},
      epoch: () => 0,
      closing: () => false,
      theme: () => "dark",
    });
    const viewer = {
      mode: "interactive" as const,
      send: (_bytes: Uint8Array, written?: () => void) => written?.(),
      notify: () => {},
      unsent: () => 0,
      close: () => {},
      declaresEpoch: true,
    };
    const baseline = ptyHandleCount();
    for (let i = 0; i < 30; i++) {
      const a = await hub.join(ref, viewer, size);
      const b = await hub.join(ref, viewer, size);
      a.leave();
      b.leave();
    }
    await expect.poll(ptyHandleCount, { timeout: 3000 }).toBeLessThanOrEqual(baseline);
  });

  it("returns to its PTY handle baseline after repeated attach and detach", async () => {
    const ref = await runtime.create(spec(["cat"]));
    const baseline = ptyHandleCount();
    let closes = 0;
    for (let i = 0; i < 30; i++) {
      const { stream } = await runtime.attach(ref, size, 0);
      stream.onClose(() => closes++);
      await sleep(20);
      stream.close();
    }
    await expect.poll(ptyHandleCount, { timeout: 3000 }).toBeLessThanOrEqual(baseline);
    expect(closes).toBe(30);
  });
});
