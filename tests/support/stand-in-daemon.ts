// The daemon's side of holder terminals, as a process of its own that a chaos test can kill or
// stop as the daemon would be. It attaches to each terminal through HolderRuntime, as the daemon
// does, attaches again whenever a stream closes, as the daemon's hub does for a terminal that
// still runs, and stops following a terminal only once an attach is refused. It prints what each
// attach saw to stdout, one JSON line per event:
//   {"t":<terminal>,"type":"attached","offset":<n>,"vt":<base64>}
//   {"t":<terminal>,"type":"data","bytes":<base64>}
//   {"t":<terminal>,"type":"closed","why":"behind"|"ended"}
//   {"t":<terminal>,"type":"refused","error":<message>}
//   {"t":"","type":"error","error":<message>}: a failure HolderRuntime reports with no caller
// With --exhaust it first opens descriptors until it can open no more, tries each attach once,
// then frees them and follows as above, printing {"type":"exhausting"}, {"type":"exhausted"} and
// {"type":"freed"}.
// Started by ./holder-spawn.ts's `startStandIn` as
// `node stand-in-daemon.ts <root> <refs JSON> [--exhaust]`.

import { closeSync, openSync } from "node:fs";
import type { RuntimeRef } from "@bazhen/core";
import { HolderRuntime } from "@bazhen/runtime-holder";

const [root, refs, mode] = process.argv.slice(2);
if (root === undefined || refs === undefined) {
  throw new Error("usage: stand-in-daemon <holder root> <refs as JSON>");
}

const isRefs = (value: unknown): value is RuntimeRef[] =>
  Array.isArray(value) &&
  value.every(
    (ref: unknown) =>
      typeof ref === "object" && ref !== null && "terminalId" in ref && "locator" in ref,
  );

const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const runtime = new HolderRuntime({
  root,
  binary: null,
  env: {},
  onError: (error) => say({ t: "", type: "error", error: String(error) }),
});

/** Attaches to `ref` and prints what it sees until the stream closes; false if refused. */
async function attachOnce(ref: RuntimeRef): Promise<boolean> {
  const t = ref.terminalId;
  let attached;
  try {
    attached = await runtime.attach(ref, null);
  } catch (error) {
    say({ t, type: "refused", error: String(error) });
    return false;
  }
  say({ t, type: "attached", offset: attached.offset, vt: base64(attached.vt) });
  const { stream } = attached;
  const why = await new Promise((resolve) => {
    stream.onData((bytes) => say({ t, type: "data", bytes: base64(bytes) }));
    stream.onClose(resolve);
  });
  say({ t, type: "closed", why });
  return true;
}

async function follow(ref: RuntimeRef): Promise<void> {
  while (await attachOnce(ref));
}

/** Opens descriptors until none is left; what it opened, for `free` to close. */
function exhaust(): number[] {
  const held: number[] = [];
  for (;;) {
    try {
      held.push(openSync("/dev/null", "r"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EMFILE") return held;
      throw error;
    }
  }
}

const parsed: unknown = JSON.parse(refs);
if (!isRefs(parsed)) throw new Error("stand-in-daemon: the refs given are not refs");
if (mode === "--exhaust") {
  // Printed before the descriptors run out: Node opens stdout on its first use, which on macOS
  // takes descriptors of its own.
  say({ type: "exhausting", t: "" });
  const held = exhaust();
  say({ type: "exhausted", t: "", fds: held.length });
  // Each attach fails for want of a descriptor; one that got through would follow on its own.
  await Promise.all(parsed.map((ref) => attachOnce(ref)));
  for (const fd of held) closeSync(fd);
  say({ type: "freed", t: "" });
}
await Promise.all(parsed.map(follow));
