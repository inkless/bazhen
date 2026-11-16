import { describe, expect, it } from "vitest";

import { answerPatched, type PatchableRoute } from "./state-route.ts";

interface Response {
  json(): Promise<unknown>;
}

/** A route whose response reads as `body`, and records what it is fulfilled or continued with. */
function route(read: () => Promise<unknown>) {
  const calls: unknown[] = [];
  const fake: PatchableRoute<Response> = {
    fetch: () => Promise.resolve({ json: read }),
    fulfill: (options) => {
      calls.push(["fulfill", options.json]);
      return Promise.resolve();
    },
    continue: () => {
      calls.push(["continue"]);
      return Promise.resolve();
    },
  };
  return { fake, calls };
}

const add = (state: object) => ({ ...state, extra: 1 });

describe("answerPatched", () => {
  it("fulfills with the state patched", async () => {
    const { fake, calls } = route(() => Promise.resolve({ agents: [] }));
    await answerPatched(fake, add);
    expect(calls).toEqual([["fulfill", { agents: [], extra: 1 }]]);
  });

  it("lets a read go on unpatched when a reload disposed its response mid-read", async () => {
    const { fake, calls } = route(() =>
      Promise.reject(new Error("apiResponse.json: Response has been disposed")),
    );
    await answerPatched(fake, add);
    expect(calls).toEqual([["continue"]]);
  });

  it("lets a read go on unpatched when the page took the route first", async () => {
    const calls: string[] = [];
    await answerPatched<Response>(
      {
        fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
        fulfill: () => Promise.reject(new Error("Route is already handled!")),
        continue: () => {
          calls.push("continue");
          return Promise.reject(new Error("Route is already handled!"));
        },
      },
      add,
    );
    expect(calls).toEqual(["continue"]);
  });

  it("does not hide a response that isn't JSON", async () => {
    const { fake, calls } = route(() => Promise.reject(new SyntaxError("Unexpected token <")));
    await expect(answerPatched(fake, add)).rejects.toThrow("Unexpected token <");
    expect(calls).toEqual([]);
  });

  it("does not hide a patch that throws", async () => {
    const { fake, calls } = route(() => Promise.resolve({}));
    await expect(
      answerPatched(fake, () => {
        throw new Error("patch is wrong");
      }),
    ).rejects.toThrow("patch is wrong");
    expect(calls).toEqual([]);
  });
});
