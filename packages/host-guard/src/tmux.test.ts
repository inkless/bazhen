import { describe, expect, it } from "vitest";
import {
  environmentScript,
  parseCommands,
  parseGroups,
  parseLstart,
  parsePsLine,
  pasteScript,
  PASTE_REFUSED,
  psFailure,
  psPrinted,
  serverVerdict,
  socketRefusal,
} from "./tmux.ts";

const uid = 501;
const root = "/tmp/bz-tmux-abc";
const shared = [`/tmp/tmux-${uid}`, `/private/tmp/tmux-${uid}`];
const refusal = (socket: string, at = root, fold = false) =>
  socketRefusal(socket, at, shared, fold);

describe("the tmux socket guard, by path", () => {
  it("accepts a socket inside the caller's own directory", () => {
    expect(refusal(`${root}/servers/bz-test-1-runtime`)).toBeUndefined();
    expect(refusal("/var/folders/x/T/bazhen/tmux.sock", "/var/folders/x/T/bazhen")).toBeUndefined();
  });

  it("refuses a socket outside its root, or the root itself", () => {
    expect(refusal("/tmp/bz-tmux-other/s")).toMatch("not inside");
    expect(refusal(`${root}/../bz-tmux-other/s`)).toMatch("normalized");
    expect(refusal(root)).toMatch("not inside");
  });

  it("refuses the user's default server by name, wherever it is", () => {
    expect(refusal(`${root}/servers/default`)).toMatch("user's own server");
  });

  it("refuses any root that holds the directory the user's own servers live in", () => {
    for (const at of ["/tmp", "/private/tmp", `/tmp/tmux-${uid}`, "/"]) {
      expect(refusal(`${at}/bz/s`.replace("//", "/"), at)).toMatch("own servers live");
    }
  });

  it("refuses the shared directory by another case where the file system ignores case", () => {
    expect(refusal(`/TMP/tmux-${uid}/bazhen`, "/TMP", true)).toMatch("own servers live");
    expect(refusal(`${root}/servers/DEFAULT`, root, true)).toMatch("user's own server");
  });

  it("refuses a relative socket or root", () => {
    expect(refusal("s")).toMatch("not an absolute");
    expect(refusal(`${root}/s`, "tmp/x")).toMatch("not an absolute");
  });
});

describe("environmentScript", () => {
  it("sets each value as one single-quoted word, a quote written the tmux way", () => {
    expect(
      environmentScript({ PLAIN: "v", HOSTILE: `it's "x" $HOME; run-shell 'id' #{pane_id} \\` }, [
        "GONE",
      ]),
    ).toBe(
      "set-environment -g PLAIN 'v'\n" +
        `set-environment -g HOSTILE 'it'\\''s "x" $HOME; run-shell '\\''id'\\'' #{pane_id} \\'\n` +
        "set-environment -g -u GONE\n",
    );
  });

  it("is empty when nothing changes", () => {
    expect(environmentScript({}, [])).toBe("");
  });

  it.each([
    [{ A: "line\nbreak" }, []],
    [{ A: "carriage\rreturn" }, []],
    [{ A: "nul\0byte" }, []],
    [{ "BASH_FUNC_f%%": "() { :; }" }, []],
    [{}, ["not-a-name"]],
  ])("refuses what no quoting carries safely, naming it: %o %o", (set, unset) => {
    expect(() => environmentScript(set, unset)).toThrow(/refusing to pass to tmux, by name only/);
  });

  it("names a refused variable but never its value", () => {
    expect(() => environmentScript({ SECRET: "token\nvalue" }, [])).toThrow(/^(?!.*token).*SECRET/);
  });
});

/** A paste's whole script into %7, with `paste` as what it runs once the pane is ready. */
const script = (paste: string[]) =>
  [
    "if-shell -F -t %7 '#{||:#{==:#{pane_mode},copy-mode},#{==:#{pane_mode},view-mode}}' 'send-keys -X -t %7 cancel'",
    `if-shell -F -t %7 '#{pane_in_mode}' 'display-message -p "${PASTE_REFUSED.mode}"' {`,
    '  if-shell -t %7 "/state/hook/bazhen-hook pane-ready #{pane_tty} #{pane_pid}" {',
    `    set-buffer -b b-1 -- 'echo "$HOME" '\\''a  b'\\''; #{pane_id} } {'`,
    ...paste.map((line) => `    ${line}`),
    "  } {",
    `    display-message -p "${PASTE_REFUSED.gate}"`,
    "  }",
    "}",
  ]
    .map((line) => `${line}\n`)
    .join("");

describe("pasteScript", () => {
  const hostile = `echo "$HOME" 'a  b'; #{pane_id} } {`;
  const gate = ["/state/hook/bazhen-hook", "pane-ready"] as const;
  it("pastes the text as one single-quoted word, bracketed as the program asks, once the pane is ready", () => {
    expect(pasteScript("b-1", "%7", hostile, false, gate)).toBe(
      script(["paste-buffer -p -d -b b-1 -t %7"]),
    );
  });

  it("marks the paste with the bracketed-paste sequences itself when asked to", () => {
    expect(pasteScript("b-1", "%7", hostile, true, gate)).toBe(
      script([
        "send-keys -t %7 -H 1b 5b 32 30 30 7e",
        "paste-buffer -d -b b-1 -t %7",
        "send-keys -t %7 -H 1b 5b 32 30 31 7e",
      ]),
    );
  });

  it.each(["make\n", "make\r", "a\tb", "\u001b[D", "\u007f", "\0", "\u009b2J", "\u0085"])(
    "refuses text holding a key rather than text: %j",
    (text) => {
      expect(() => pasteScript("b", "%1", text, false, gate)).toThrow(/control character$/);
      expect(() => pasteScript("b", "%1", text, true, gate)).toThrow(/control character$/);
    },
  );

  it("refuses unmarked text beyond printable ASCII, which as keys would be meta keys, and marks it", () => {
    for (const text of ["echo Å", "echo £", "echo 你好", "a\u00a0b"])
      expect(() => pasteScript("b", "%1", text, false, gate)).toThrow(/beyond printable ASCII/);
    expect(pasteScript("b", "%1", "echo Å 你好", true, gate)).toContain("'echo Å 你好'");
  });

  it("refuses text that would end a marked paste early, so what follows is typed as keys", () => {
    expect(() => pasteScript("b", "%1", "a\u001b[201~rm -rf ~", true, gate)).toThrow(
      /control character$/,
    );
  });

  it.each([
    ["b c", "%1", gate],
    ["b", "%1; kill-server", gate],
    ["b", "main", gate],
    ["b", "%1", ["/hook; rm -rf ~", "pane-ready"]],
    ["b", "%1", ["/my hook", "pane-ready"]],
  ] as const)(
    "refuses a buffer, pane or gate that isn't plain names and ids: %j %j %j",
    (buffer, target, gated) => {
      expect(() => pasteScript(buffer, target, "make", false, gated)).toThrow(RangeError);
    },
  );
});

describe("the recorded tmux server, by what ps shows of it", () => {
  const socket = "/var/folders/x/T/bazhen/tmux.sock";
  const identity = { pid: "4242", start: "1794000000" };
  const at = "Fri Nov 13 07:20:00 2026";
  // As ps showed them in the test container (tmux 3.5a) and on macOS (tmux 3.6b).
  const linux = {
    comm: "tmux: server",
    start: 1_794_000_001,
    args: `tmux -u -S ${socket} -f /tmp/s.conf new-session -d -s bz-1 -- env -u TMUX -- sleep 300`,
  };
  const titled = { comm: "tmux", start: 1_794_000_000, args: `tmux: server (${socket})` };
  const macos = {
    comm: "/opt/homebrew/bin/tmux",
    start: 1_794_000_000,
    args: `tmux -u -S ${socket} -f /var/folders/x/T/bazhen/tmux.conf new-session -d -s bz-1`,
  };
  const is = (reading: Parameters<typeof serverVerdict>[0], id = identity) =>
    serverVerdict(reading, id, socket).is;

  it("reads ps's lstart in the C locale and UTC as epoch seconds", () => {
    expect(parseLstart("Thu Nov 12 17:10:38 2026")).toBe(Date.UTC(2026, 10, 12, 17, 10, 38) / 1000);
    expect(parseLstart("Mon Nov  2 01:02:03 2026")).toBe(Date.UTC(2026, 10, 2, 1, 2, 3) / 1000);
    expect(parseLstart("jeu. 12 nov. 17:10:38 2026")).toBeUndefined();
  });

  it("splits a ps line into its start and a column that holds spaces", () => {
    const start = Date.UTC(2026, 10, 13, 7, 20, 0) / 1000;
    expect([
      parsePsLine(`${at} tmux: server\n`),
      parsePsLine(`Fri Nov 13 07:20:00 2026     tmux -u -S ${socket} new-session`),
    ]).toEqual([
      { start, rest: "tmux: server" },
      { start, rest: `tmux -u -S ${socket} new-session` },
    ]);
  });

  it("reads a line it can't parse as nothing", () => {
    for (const line of ["", "tmux", "jeu. 13 nov. 07:20:00 2026 tmux", at])
      expect(parsePsLine(line)).toBeUndefined();
  });

  it("calls a pid absent only when ps exits 1 having printed nothing", () => {
    expect([
      psFailure({ code: 1, stdout: "", stderr: "" }),
      psFailure({ code: 1, stdout: "", stderr: "ps: illegal option -- w\nusage: ps" }),
      psFailure({ code: 2, stdout: "", stderr: "" }),
      psFailure({ code: "ETIMEDOUT", killed: true }),
      psFailure(new Error("spawn ps ENOENT")),
    ]).toEqual(["absent", "unreadable", "unreadable", "unreadable", "unreadable"]);
  });

  it("knows the server by the -S that started it, or by its process title", () => {
    expect([linux, macos, titled].map((facts) => is(facts))).toEqual([
      "serves",
      "serves",
      "serves",
    ]);
  });

  it("calls the server gone only when no process has its pid, or a different one does", () => {
    const other = { comm: "node", start: 1_700_000_000, args: "node app.js" };
    expect([is("absent"), is(other)]).toEqual(["gone", "gone"]);
  });

  it("is unsure, never gone, of what ps could not show", () => {
    expect(serverVerdict("unreadable", identity, socket)).toEqual({
      is: "unsure",
      why: "ps could not be read",
    });
  });

  it("is unsure, never gone, of anything tmux-like or naming our socket with a skewed start", () => {
    const skewed = 1_794_000_010;
    for (const facts of [
      { ...linux, start: skewed, comm: ".tmux-wrapped" },
      { comm: ".tmux-wrapped", start: skewed, args: "/nix/store/x/bin/.tmux-wrapped new-session" },
      { ...linux, start: skewed, args: `tmux -u -S /private${socket} new-session` },
      { comm: "node", start: skewed, args: `node watcher.js ${socket}` },
    ])
      expect(is(facts)).toBe("unsure");
  });

  it("is unsure of the server itself started at another time, as a clock step makes it look", () => {
    expect(is({ ...linux, start: 1_794_000_003 })).toBe("unsure");
  });

  it("is unsure of a process started when the server did that it can't tell is that server", () => {
    for (const comm of [
      "node",
      "tmux: client",
      "/usr/bin/tmuxinator",
      ".tmux-wrapped",
      "<defunct>",
    ])
      expect(is({ ...linux, comm })).toBe("unsure");
  });

  it("is unsure of a tmux server for another socket, or one whose path only begins with ours", () => {
    for (const args of [
      "tmux: server (/tmp/bz-tmux-other/s)",
      `tmux: server (${socket}2)`,
      `tmux -u -S ${socket}2 new-session -d`,
    ])
      expect(is({ ...linux, args })).toBe("unsure");
  });

  it("never serves the user's own default server, which names no socket of ours", () => {
    for (const args of ["tmux: server (/tmp/tmux-501/default)", "tmux", "tmux new-session -A"])
      expect(is({ ...linux, args })).not.toBe("serves");
  });

  it("is unsure, never gone, against a recorded start it can't read", () => {
    expect(is({ comm: "node", start: 1, args: "node" }, { pid: "4242", start: "" })).toBe("unsure");
  });
});

describe("foreground groups read back", () => {
  it("reads each pid's group, a process with no terminal's as -1, and skips any other line", () => {
    const out = "  4242  4250\n    17    -1\nnot a row\n  9 x\n";
    expect(parseGroups(out)).toEqual(
      new Map([
        [4242, 4250],
        [17, -1],
      ]),
    );
  });
});

/** A `ps` run that failed, as its promise form rejects: an error carrying `fields`. */
const failed = (fields: Record<string, unknown>) => ({
  error: Object.assign(new Error("Command failed: ps"), fields),
});

describe("what a ps run over many pids printed", () => {
  const lines = " 4242 Mon Nov 16 23:19:26 2026 node\n";

  it("takes procps's partial output, exiting 0, as the pids it found", () => {
    expect(psPrinted({ stdout: lines })).toBe(lines);
  });

  it("takes procps's exit 1 with nothing printed as no pid found", () => {
    expect(psPrinted(failed({ code: 1, stdout: "", stderr: "" }))).toBe("");
  });

  it("takes BSD's exit 1 for a missing pid as the ones it still printed", () => {
    expect(psPrinted(failed({ code: 1, stdout: lines, stderr: "" }))).toBe(lines);
  });

  it("is unreadable for any other failure, whatever it printed", () => {
    expect([
      psPrinted(failed({ code: 1, stdout: lines, stderr: "ps: illegal option -- w\nusage: ps" })),
      psPrinted(failed({ code: 2, stdout: lines, stderr: "" })),
      psPrinted(failed({ code: null, killed: true, signal: "SIGTERM", stdout: lines, stderr: "" })),
      psPrinted(failed({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: lines, stderr: "" })),
      psPrinted({ error: new Error("spawn ps ENOENT") }),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("processes' commands read back", () => {
  const start = Date.UTC(2026, 10, 16, 23, 19, 26) / 1000;

  it("reads each pid's start and whole command, spaces and a macOS path included", () => {
    const out = [
      "    1 Mon Nov 16 23:19:26 2026 systemd",
      " 4242 Mon Nov 16 23:19:26 2026 tmux: server",
      "70001 Mon Nov 16 23:19:26 2026 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "",
    ].join("\n");
    expect(parseCommands(out)).toEqual(
      new Map([
        [1, { start, comm: "systemd" }],
        [4242, { start, comm: "tmux: server" }],
        [70001, { start, comm: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" }],
      ]),
    );
  });

  it("reads nothing printed as no process", () => {
    expect(parseCommands("")).toEqual(new Map());
  });

  it("refuses the whole read for any line it can't parse", () => {
    for (const bad of ["not a row", " 4242 jeu. 16 nov. 23:19:26 2026 node", " 4242 node"])
      expect(parseCommands(` 17 Mon Nov 16 23:19:26 2026 node\n${bad}\n`)).toBeUndefined();
  });
});
