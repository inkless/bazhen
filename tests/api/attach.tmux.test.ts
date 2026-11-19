import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "./daemon.ts";
import { closeWhileAttached } from "./attach-close.ts";

describe("bazhen terminals attach, on a tmux terminal", () => {
  let daemon: Daemon;
  beforeAll(async () => {
    daemon = await Daemon.start({ runtime: "tmux" });
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("ends saying the terminal closed when its agent is closed, offering no respawn", async () => {
    expect(await closeWhileAttached(daemon, "close-attached-tmux")).toEqual([200, 0, false]);
  });
});
