// A fixture falsify-reporter.medium.test.ts copies into a temporary folder as a test file. It
// uses vitest's globals, so nothing has to resolve from that folder.
import { missing } from "./missing.mjs";
it("loads", () => {
  missing();
});
