// A fixture falsify-reporter.medium.test.ts copies into a temporary folder as a test file. It
// uses vitest's globals, so nothing has to resolve from that folder.
let tries = 0;
it("passes", () => {});
it("fails", () => {
  expect(1).toBe(2);
});
it.skip("is skipped", () => {});
it.todo("is to do");
// falsify matches a title anywhere in the file, so two describes sharing one are a duplicate.
describe("one", () => {
  it("shares a title", () => {});
});
describe("another", () => {
  it("shares a title", () => {
    throw new Error("the second of two");
  });
});
describe("outer", () => {
  describe("inner", () => {
    it("fails nested", () => {
      throw new Error("nested");
    });
  });
});
it("times out", { timeout: 50 }, () => new Promise((done) => setTimeout(done, 1000)));
it("passes on its retry", { retry: 1 }, () => {
  tries += 1;
  expect(tries).toBe(2);
});
it("fails every try", { retry: 1 }, () => {
  throw new Error("every try");
});
it.fails("is expected to fail", () => {
  throw new Error("as expected");
});
describe.concurrent("concurrently", () => {
  it("passes concurrently", () => {});
  it("fails concurrently", () => {
    throw new Error("concurrently");
  });
});
describe("before a failing afterAll", () => {
  afterAll(() => {
    throw new Error("after all");
  });
  it("passes before a failing afterAll", () => {});
});
