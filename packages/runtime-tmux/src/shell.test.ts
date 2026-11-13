import { describe, expect, it } from "vitest";
import { shellCommand } from "./shell.ts";

describe("shellCommand", () => {
  it("leaves plain words bare", () => {
    expect(shellCommand(["tmux", "-u", "-S", "/run/bazhen/tmux.sock", "attach-session"])).toBe(
      "tmux -u -S /run/bazhen/tmux.sock attach-session",
    );
  });

  it("single-quotes a word a shell would split, expand or end", () => {
    expect(shellCommand(["-t", "$7", "/Users/a b/run", "x;y", ""])).toBe(
      "-t '$7' '/Users/a b/run' 'x;y' ''",
    );
  });

  it("closes the quote around a single quote and escapes it", () => {
    expect(shellCommand(["/tmp/it's"])).toBe("'/tmp/it'\\''s'");
  });

  it("writes a backslash outside the quotes, where fish reads it as an escape", () => {
    expect(shellCommand(["a\\b"])).toBe("'a'\\\\'b'");
  });

  it("quotes a word starting with = or %, which zsh and fish expand", () => {
    expect(shellCommand(["=tmux", "%1", "a=b"])).toBe("'=tmux' '%1' a=b");
  });
});
