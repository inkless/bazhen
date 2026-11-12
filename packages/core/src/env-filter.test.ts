import { describe, expect, it } from "vitest";
import { filterEnv } from "./env-filter.ts";

describe("filterEnv", () => {
  it("keeps the user's own variables, as a new terminal tab would", () => {
    const { env } = filterEnv({ GH_TOKEN: "t", PATH: "/bin", SSH_AUTH_SOCK: "/s" });
    expect(env).toEqual({ GH_TOKEN: "t", PATH: "/bin", SSH_AUTH_SOCK: "/s" });
  });

  it("strips harness session, tmux and presentation variables", () => {
    const { env } = filterEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      TMUX: "/t",
      TERM_PROGRAM_VERSION: "3",
      FORCE_COLOR: "1",
      BAZHEN_AGENT_ID: "agent_x",
      SHLVL: "2",
    });
    expect(env).toEqual({});
  });

  it("keeps CODEX_HOME while stripping other Codex variables", () => {
    expect(filterEnv({ CODEX_HOME: "/h", CODEX_THREAD_ID: "t" }).env).toEqual({ CODEX_HOME: "/h" });
  });

  it("counts what each pattern removed", () => {
    const { removed } = filterEnv({ CLAUDE_CODE_A: "1", CLAUDE_CODE_B: "1", TMUX: "/t" });
    expect(removed).toEqual({ "CLAUDE_CODE_*": 2, TMUX: 1 });
  });

  it("applies the user's extra denials and passthroughs", () => {
    const { env } = filterEnv(
      { MY_SECRET: "s", TERM_PROGRAM: "kitty" },
      { deny: ["MY_*"], passthrough: ["TERM_PROGRAM"] },
    );
    expect(env).toEqual({ TERM_PROGRAM: "kitty" });
  });

  it("lets the user's own denial win over a passthrough", () => {
    expect(filterEnv({ CODEX_HOME: "/h" }, { deny: ["CODEX_HOME"] }).env).toEqual({});
  });

  it("drops unset variables", () => {
    expect(filterEnv({ HOME: undefined }).env).toEqual({});
  });
});
