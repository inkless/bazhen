import { describe, expect, it } from "vitest";
import { ScreenEmulator } from "./emulator.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;

const SENTINEL = `${ESC}[c`;
const SENTINEL_REPLY = `${ESC}[?1;2c`;

/**
 * Feeds the emulator what tmux's client prints, and collects what it answers. A device
 * attributes query follows the output, so its answer marks the point where all of it is parsed.
 */
async function answersTo(output: string): Promise<string> {
  let replies = "";
  const { promise: parsed, resolve } = Promise.withResolvers<void>();
  const emulator = new ScreenEmulator((bytes) => {
    replies += Buffer.from(bytes).toString("latin1");
    if (replies.endsWith(SENTINEL_REPLY)) resolve();
  });
  emulator.write(Buffer.from(output + SENTINEL, "latin1"));
  await parsed;
  emulator.dispose();
  return replies.slice(0, -SENTINEL_REPLY.length);
}

describe("the daemon's screen emulator", () => {
  it("answers tmux's primary device attributes query", async () => {
    expect(await answersTo(`${ESC}[c`)).toBe(`${ESC}[?1;2c`);
  });

  it("answers tmux's secondary device attributes query", async () => {
    expect(await answersTo(`${ESC}[>c`)).toBe(`${ESC}[>0;276;0c`);
  });

  it("answers XTVERSION, which no browser terminal answers", async () => {
    expect(await answersTo(`${ESC}[>q`)).toBe(`${ESC}P>|bazhen${ST}`);
  });

  it("answers tmux 3.8's window pixel size query, with the size unknown", async () => {
    expect(await answersTo(`${ESC}[14t`)).toBe(`${ESC}[4;0;0t`);
  });

  it("answers the foreground and background colour queries", async () => {
    expect(await answersTo(`${ESC}]10;?${ST}${ESC}]11;?${ESC}\\`)).toBe(
      `${ESC}]10;rgb:ffff/ffff/ffff${ST}${ESC}]11;rgb:0000/0000/0000${ST}`,
    );
  });

  it("does not answer a sequence that sets a colour rather than asking for it", async () => {
    expect(await answersTo(`${ESC}]11;rgb:1111/1111/1111${ST}`)).toBe("");
  });
});
