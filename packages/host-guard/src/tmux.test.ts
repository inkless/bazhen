import { describe, expect, it } from "vitest";
import {
  environmentScript,
  parseLstart,
  parsePsLine,
  psFailure,
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
