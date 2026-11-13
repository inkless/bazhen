import { describe, expect, it } from "vitest";
import { environmentScript, parseLstart, serverRefusal, socketRefusal } from "./tmux.ts";

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

describe("the recorded tmux server, by what ps says of it", () => {
  const socket = "/var/folders/x/T/bazhen/tmux.sock";
  const identity = { pid: "4242", start: "1794000000" };
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

  it("reads ps's lstart in the C locale and UTC as epoch seconds", () => {
    expect(parseLstart("Thu Nov 12 17:10:38 2026")).toBe(Date.UTC(2026, 10, 12, 17, 10, 38) / 1000);
    expect(parseLstart("Mon Nov  2 01:02:03 2026")).toBe(Date.UTC(2026, 10, 2, 1, 2, 3) / 1000);
    expect(parseLstart("jeu. 12 nov. 17:10:38 2026")).toBeUndefined();
  });

  it("knows the server by the -S that started it, or by its process title", () => {
    expect([linux, macos, titled].map((facts) => serverRefusal(facts, identity, socket))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("refuses a pid with no process", () => {
    expect(serverRefusal(undefined, identity, socket)).toBe("no such process");
  });

  it("refuses a process that is not tmux, even one naming the socket", () => {
    for (const comm of ["node", "tmux: client", "/usr/bin/tmuxinator"])
      expect(serverRefusal({ ...linux, comm }, identity, socket)).toMatch("command is");
  });

  it("refuses a tmux that started more than two seconds from the recorded start", () => {
    expect(serverRefusal({ ...linux, start: 1_794_000_003 }, identity, socket)).toMatch(
      "another time",
    );
    expect(serverRefusal(linux, { ...identity, start: "" }, socket)).toMatch("another time");
  });

  it("refuses a tmux server for another socket, or one whose path only begins with ours", () => {
    for (const args of [
      "tmux: server (/tmp/bz-tmux-other/s)",
      `tmux: server (${socket}2)`,
      `tmux -u -S ${socket}2 new-session -d`,
    ])
      expect(serverRefusal({ ...linux, args }, identity, socket)).toMatch("another socket");
  });

  it("refuses the user's own default server, which names no socket of ours", () => {
    for (const args of ["tmux: server (/tmp/tmux-501/default)", "tmux", "tmux new-session -A"])
      expect(serverRefusal({ ...linux, args }, identity, socket)).toMatch("another socket");
  });
});
