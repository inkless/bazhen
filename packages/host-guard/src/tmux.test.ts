import { describe, expect, it } from "vitest";
import { environmentScript, socketRefusal } from "./tmux.ts";

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
