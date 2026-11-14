import headless from "@xterm/headless";
import type { Size } from "@bazhen/core";
import { fakeContractHarness, snapshotContract, type Replayed } from "@bazhen/core/testing";

/** As a browser's terminal replays it. */
async function replay(vt: Uint8Array, size: Size): Promise<Replayed> {
  const term = new headless.Terminal({ ...size, allowProposedApi: true });
  let replies = "";
  term.onData((data) => (replies += data));
  await new Promise<void>((resolve) => term.write(vt, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    (buffer.getLine(y)?.translateToString(true) ?? "").trim(),
  );
  const shown = { buffer: buffer.type, modes: { ...term.modes }, lines, replies };
  term.dispose();
  return shown;
}

snapshotContract("FakeRuntime in snapshot mode", { ...fakeContractHarness("snapshot"), replay });
