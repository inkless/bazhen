import { existsSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectHolder, HolderDisconnected } from "./client.ts";
import { listenFakeHolder, type FakeHolderServer } from "./testing/fake-holder.ts";

const ignore = () => {};
const dirs: string[] = [];
const fakes: FakeHolderServer[] = [];

// Under /tmp, as a holder's own socket is: a Unix socket path holds at most 103 bytes.
function socketPath(): string {
  const dir = mkdtempSync("/tmp/bz-holder-client-");
  dirs.push(dir);
  return join(dir, "t.sock");
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("connectHolder", () => {
  it("says hello over a holder's socket and closes the terminal, which removes it", async () => {
    const path = socketPath();
    fakes.push(await listenFakeHolder(path, { hello: { terminalId: "t1" } }));
    const client = await connectHolder(path, { onEvent: ignore });
    expect(client.hello.terminalId).toBe("t1");
    await client.close();
    await expect(client.ended).resolves.toEqual({ reason: "eof" });
    expect(existsSync(path)).toBe(false);
  });

  it("rejects before hello, with the system's code, when there is no socket", async () => {
    const connecting = connectHolder(socketPath(), { onEvent: ignore });
    await expect(connecting).rejects.toBeInstanceOf(HolderDisconnected);
    await expect(connecting).rejects.toMatchObject({ cause: { code: "ENOENT" } });
  });

  it("rejects before hello on a socket whose holder is gone", async () => {
    const live = socketPath();
    const fake = await listenFakeHolder(live);
    // A second name for the socket outlives the listener, as a dead holder's file does.
    const path = `${live}.stale`;
    linkSync(live, path);
    await fake.close();
    await expect(connectHolder(path, { onEvent: ignore })).rejects.toMatchObject({
      end: { reason: "error" },
      cause: { code: "ECONNREFUSED" },
    });
  });
});
