import { describe, expect, it } from "vitest";
import {
  type Candidate,
  type Own,
  mayBeShared,
  sharedAmong,
  socketInodes,
  unixInodes,
} from "./shared.ts";

const candidate = (over: Partial<Candidate> & Pick<Candidate, "name">): Candidate => ({
  pid: 700,
  argv: [],
  sockets: new Set(),
  ...over,
});

const OWN: Own = {
  pausePid: 21051,
  gpgHome: "/home/u/.gnupg",
  gpgSockets: new Set([9001]),
};

describe("sharedAmong", () => {
  it("leaves out podman's pause process only where its pid is the one in pause.pid", () => {
    const pause = candidate({ pid: 21051, name: "catatonit", argv: ["catatonit", "-P"] });
    const other = candidate({ pid: 21052, name: "catatonit", argv: ["catatonit", "-P"] });
    const init = candidate({ pid: 21051, name: "catatonit", argv: ["catatonit", "--", "sh"] });
    expect(sharedAmong([pause, other, init], OWN)).toEqual(new Set([21051]));
    expect(sharedAmong([pause], { gpgSockets: new Set() })).toEqual(new Set());
  });

  it.each([
    ["--homedir", ["gpg-agent", "--homedir", "/home/u/.gnupg", "--daemon"], new Set<number>()],
    ["--homedir=", ["gpg-agent", "--homedir=/home/u/.gnupg", "--daemon"], new Set<number>()],
    ["its socket", ["gpg-agent", "--daemon"], new Set([12, 9001])],
  ])("leaves out the gpg-agent of this process's own home, by %s", (_, argv, sockets) => {
    expect(sharedAmong([candidate({ name: "gpg-agent", argv, sockets })], OWN)).toEqual(
      new Set([700]),
    );
  });

  it.each([
    ["another home", ["gpg-agent", "--homedir", "/tmp/t/.gnupg", "--daemon"], new Set([12])],
    ["no home and no socket of this process's", ["gpg-agent", "--daemon"], new Set<number>()],
  ])("counts a gpg-agent of %s", (_, argv, sockets) => {
    expect(sharedAmong([candidate({ name: "gpg-agent", argv, sockets })], OWN)).toEqual(new Set());
  });

  it("counts a gpg-agent where this process has no gpg home to match", () => {
    const agent = candidate({ name: "gpg-agent", argv: ["gpg-agent", "--daemon"] });
    expect(sharedAmong([agent], { gpgSockets: new Set() })).toEqual(new Set());
  });

  it("goes by name first: an identity under another name is no shared daemon", () => {
    const impostor = candidate({ pid: 21051, name: "sleep", argv: ["sleep", "-P"] });
    expect(sharedAmong([impostor], OWN)).toEqual(new Set());
    expect(mayBeShared("sleep")).toBe(false);
    expect(mayBeShared("gpg-agent")).toBe(true);
  });
});

describe("reading sockets", () => {
  it("finds the inodes bound at a path in /proc/net/unix, whatever spaces the path holds", () => {
    const table = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 9001 /run/user/1000/gnupg/S.gpg-agent",
      "0000000000000000: 00000003 00000000 00000000 0001 03 9002",
      "0000000000000000: 00000002 00000000 00010000 0001 01 9003 /tmp/a b",
    ].join("\n");
    expect(unixInodes(table, "/run/user/1000/gnupg/S.gpg-agent")).toEqual(new Set([9001]));
    expect(unixInodes(table, "/tmp/a b")).toEqual(new Set([9003]));
    expect(unixInodes(table, "/nowhere")).toEqual(new Set());
  });

  it("takes only sockets from a process's fd links", () => {
    expect(socketInodes(["socket:[42]", "pipe:[43]", "/dev/null", "anon_inode:[eventfd]"])).toEqual(
      new Set([42]),
    );
  });
});
