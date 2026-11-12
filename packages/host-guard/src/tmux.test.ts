import { describe, expect, it } from "vitest";
import { socketRefusal } from "./tmux.ts";

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
