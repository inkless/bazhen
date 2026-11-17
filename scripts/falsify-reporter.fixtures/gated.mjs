// A fixture falsify-reporter.medium.test.ts copies into a temporary folder as a test file. It
// uses vitest's globals, so nothing has to resolve from that folder.
import { existsSync, writeFileSync } from "node:fs";
it("fails first", () => {
  throw new Error("early");
});
it("passes first", () => {});
it("waits on the gate", async ({ annotate }) => {
  // A worker sends results in batches, and may hold the last until its next update. annotate
  // sends what it holds and waits until vitest has given it to every reporter, so by the time
  // the marker appears both results above are recorded.
  await annotate("waiting on the gate");
  writeFileSync(process.env.WAITING, "");
  while (!existsSync(process.env.GATE)) await new Promise((done) => setTimeout(done, 20));
});
