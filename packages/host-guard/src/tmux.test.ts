import { describe, expect, it } from "vitest";
import { socketRefusal, TmuxServer } from "./tmux.ts";

const uid = 501;
const root = "/tmp/bz-tmux-abc";

describe("the tmux socket guard", () => {
  it("accepts a socket inside the caller's own directory", () => {
    expect(socketRefusal(`${root}/tmux-${uid}/bz-test-1-runtime`, root, uid)).toBeUndefined();
    expect(socketRefusal("/var/folders/x/T/bazhen/tmux.sock", "/var/folders/x/T/bazhen", uid)).toBe(
      undefined,
    );
  });

  it("refuses a socket outside its root, or the root itself", () => {
    expect(socketRefusal("/tmp/bz-tmux-other/s", root, uid)).toMatch("not inside");
    expect(socketRefusal(`${root}/../bz-tmux-other/s`, root, uid)).toMatch("normalized");
    expect(socketRefusal(root, root, uid)).toMatch("not inside");
  });

  it("refuses the user's default server by name, wherever it is", () => {
    expect(socketRefusal(`${root}/tmux-${uid}/default`, root, uid)).toMatch("user's own server");
  });

  it("refuses any root that holds the directory the user's own servers live in", () => {
    for (const shared of ["/tmp", "/private/tmp", `/tmp/tmux-${uid}`, "/"]) {
      expect(socketRefusal(`${shared}/bz/s`.replace("//", "/"), shared, uid)).toMatch(
        "own servers live",
      );
    }
  });

  it("refuses a relative socket or root", () => {
    expect(socketRefusal("s", root, uid)).toMatch("not an absolute");
    expect(socketRefusal(`${root}/s`, "tmp/x", uid)).toMatch("not an absolute");
  });

  it("names its server by path in every command, forcing UTF-8, never by -L", () => {
    const server = TmuxServer.at(`${root}/s`, { root, config: `${root}/tmux.conf` });
    expect(server.argv("list-sessions")).toEqual([
      "tmux",
      "-u",
      "-S",
      `${root}/s`,
      "-f",
      `${root}/tmux.conf`,
      "list-sessions",
    ]);
    expect(() => TmuxServer.at("/tmp/tmux-0/default", { root: "/tmp" })).toThrow(RangeError);
  });
});
