import { describe, expect, it } from "vitest";
import { isClosedSocketError } from "./proxy-log.ts";

/** A socket error as Node raises one: a read or write names its syscall, a hang-up none. */
const withCode = (code: string, syscall?: string) =>
  Object.assign(new Error(`${syscall ?? "socket"} ${code}`), { code }, syscall && { syscall });
const red = (text: string) => `\u001b[31m${text}\u001b[39m`;

describe("the web dev server's closed-socket errors", () => {
  it("are the WebSocket proxy's writes to a peer that has gone, as Vite logs them", () => {
    expect([
      isClosedSocketError("ws proxy error:\nError: write EPIPE", {
        error: withCode("EPIPE", "write"),
      }),
      isClosedSocketError(`${red("ws proxy socket error:")}\nError: read ECONNRESET`, {
        error: withCode("ECONNRESET", "read"),
      }),
    ]).toEqual([true, true]);
  });

  it("leave out a daemon that refuses or hangs up, any other code, and the HTTP proxy's", () => {
    expect([
      isClosedSocketError("ws proxy error:\nError: connect ECONNREFUSED", {
        error: withCode("ECONNREFUSED", "connect"),
      }),
      isClosedSocketError("ws proxy error:\nError: socket hang up", {
        error: withCode("ECONNRESET"),
      }),
      isClosedSocketError("ws proxy socket error:\nError: read ETIMEDOUT", {
        error: withCode("ETIMEDOUT", "read"),
      }),
      isClosedSocketError("http proxy error: /v1/health\nError: write EPIPE", {
        error: withCode("EPIPE", "write"),
      }),
      isClosedSocketError("ws proxy error:\nError: write EPIPE"),
    ]).toEqual([false, false, false, false, false]);
  });
});
