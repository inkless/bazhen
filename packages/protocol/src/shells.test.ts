import { describe, expect, it } from "vitest";
import { StateSnapshot } from "./agents.ts";
import {
  COMMAND_LINE_MAX_BYTES,
  OpenShellRequest,
  RenameShellRequest,
  RestartShellRequest,
  Shell,
  ShellCommandLine,
  ShellDecline,
  ShellPrompt,
} from "./shells.ts";

const named = (name: string) => RenameShellRequest.safeParse({ idempotencyKey: "k", name });
const agentId = "agent_0190000000007000800000000000aaaa";

describe("shell requests", () => {
  it("opens a linked shell in its agent's directory, so refuses one that names its own", () => {
    const linked = { idempotencyKey: "k", linkedAgentId: agentId };
    expect(OpenShellRequest.safeParse(linked).success).toBe(true);
    expect(OpenShellRequest.safeParse({ ...linked, cwd: "/work" }).success).toBe(false);
  });

  it("reads a snapshot from a daemon older than shells as having none", () => {
    const older = {
      epoch: "e",
      eventId: 0,
      environments: [],
      agents: [],
      attention: [],
      messages: [],
    };
    expect(StateSnapshot.parse(older).shells).toEqual([]);
  });

  it("restarts as before without retype, and takes retype only as true", () => {
    const restart = { idempotencyKey: "k", generation: 0 };
    const parsed = [undefined, true, false, "yes"].map(
      (retype) => RestartShellRequest.safeParse({ ...restart, retype }).success,
    );
    expect(parsed).toEqual([true, true, false, false]);
  });

  it("reads a shell from a daemon older than retyping as not retypeable", () => {
    const older = {
      id: "term_0190000000007000800000000000aaaa",
      environmentId: "env_0190000000007000800000000000aaaa",
      state: "lost",
      generation: 0,
      cwd: "/work",
      linkedAgentId: null,
      theme: "dark",
      attachCommand: null,
      commands: ["close", "restart"],
    };
    expect(Shell.parse(older).retypeable).toBe(false);
  });

  it("takes a prompt report with the shell's token alone, and refuses one without a token", () => {
    const parsed = ["t", "", "x".repeat(129), undefined].map(
      (token) => ShellPrompt.safeParse({ token }).success,
    );
    expect(parsed).toEqual([true, false, false, false]);
  });

  it("takes a shell's word that it won't take a line back with its token alone", () => {
    const parsed = ["t", "", "x".repeat(129), undefined].map(
      (token) => ShellDecline.safeParse({ token }).success,
    );
    expect(parsed).toEqual([true, false, false, false]);
  });

  it("takes a shell's name trimmed, and refuses one that is blank or too long to show", () => {
    expect(named("  dev server ").data?.name).toBe("dev server");
    expect([named("   ").success, named("x".repeat(81)).success]).toEqual([false, false]);
  });

  it("refuses a name holding an escape, a newline or a bidirectional override", () => {
    const refused = ["a\x1b[31mb", "dev\nserver", "a\u009bb", "abc\u202edef", "x\u2066y"];
    expect(refused.map((name) => named(name).success)).toEqual([false, false, false, false, false]);
    expect(named("café ☕ 服务").success).toBe(true);
  });
});

const kept = (line: string) => ShellCommandLine.safeParse(line).success;

describe("a command line kept to type back", () => {
  it("keeps the line as typed, its variables, quotes and spaces unexpanded", () => {
    const line = `echo "$HOME" 'a  b' *.ts | grep -v 'x'; FOO=1 make `;
    expect(ShellCommandLine.parse(line)).toBe(line);
  });

  it("refuses a line that would run, or drive the line editor, when typed back", () => {
    const refused = ["make\n", "make\rrm -rf x", "a\tb", "a\x1b[Db", "a\u009bb", "a\x7fb"];
    expect(refused.map(kept)).toEqual(refused.map(() => false));
  });

  it("refuses a bidirectional override, which shows the line other than it would run", () => {
    expect([kept("ls \u202e/etc"), kept("ls \u2066x"), kept("ls café ☕")]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("refuses a character that draws as nothing, which would hide text in the line typed back", () => {
    const hidden = ["rm\u200b -rf", "a\u200eb", "a\u061cb", "a\u2028b", "a\u2060b", "\ufeffls"];
    expect(hidden.map(kept)).toEqual(hidden.map(() => false));
  });

  it("refuses a line the user kept out of their history with a leading space", () => {
    expect([kept(" export TOKEN=s3cret"), kept("export A=1 ")]).toEqual([false, true]);
  });

  it("keeps a line up to its byte limit, counted in UTF-8, and refuses one byte more", () => {
    const most = "é".repeat(COMMAND_LINE_MAX_BYTES / 2);
    expect([kept(most), kept(`${most}x`), kept("")]).toEqual([true, false, false]);
  });

  it("refuses a lone surrogate, which no shell could have typed", () => {
    expect(kept("echo \ud800")).toBe(false);
  });
});
