import { describe, expect, it } from "vitest";
import { filterEnv, InvalidEnvRule } from "./env-filter.ts";

describe("filterEnv", () => {
  it("keeps the user's own variables, as a new terminal tab would", () => {
    const { env } = filterEnv({ GH_TOKEN: "t", PATH: "/bin", SSH_AUTH_SOCK: "/s" });
    expect(env).toEqual({ GH_TOKEN: "t", PATH: "/bin", SSH_AUTH_SOCK: "/s" });
  });

  it("strips harness session, tmux and presentation variables", () => {
    const { env } = filterEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_MESSAGING_SOCKET: "/s",
      TMUX: "/t",
      TERM_PROGRAM_VERSION: "3",
      FORCE_COLOR: "1",
      BAZHEN_AGENT_ID: "agent_x",
      SHLVL: "2",
    });
    expect(env).toEqual({});
  });

  it("keeps the user's harness configuration while stripping harness session variables", () => {
    const { env } = filterEnv({
      CODEX_HOME: "/h",
      CODEX_THREAD_ID: "t",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SESSION_ID: "s",
    });
    expect(env).toEqual({ CODEX_HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  // What Claude Code 2.1.322 sets for its children that names its own session or paths.
  it.each([
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_ENV_FILE",
    "CLAUDE_PROJECT_DIR",
    "AI_AGENT",
  ])("strips %s, which belongs to the session bazhen start ran in", (name) => {
    expect(filterEnv({ [name]: "x" }).env).toEqual({});
  });

  it("counts what each pattern removed", () => {
    const { removed } = filterEnv({ ITERM_PROFILE: "1", ITERM_SESSION_ID: "1", TMUX: "/t" });
    expect(removed).toEqual({ "ITERM_*": 2, TMUX: 1 });
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

  it.each(["*", "", "A*B", "MY VAR"])(
    "refuses the user rule %j, which would match too much",
    (rule) => {
      expect(() => filterEnv({}, { deny: [rule] })).toThrow(InvalidEnvRule);
      expect(() => filterEnv({}, { passthrough: [rule] })).toThrow(InvalidEnvRule);
    },
  );

  it("drops unset variables", () => {
    expect(filterEnv({ HOME: undefined }).env).toEqual({});
  });
});
