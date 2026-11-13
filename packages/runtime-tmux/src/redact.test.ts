import { describe, expect, it } from "vitest";
import { TmuxError } from "./index.ts";
import { redacted } from "./redact.ts";

describe("a tmux command as a log shows it", () => {
  it("hides a terminal's environment values and the keys send-keys types, and keeps the rest", () => {
    const args = [
      ["new-session", "-d", "-s", "bz-1", "-e", "API_TOKEN=s3cret", "--", "zsh"],
      [";", "send-keys", "-t", "%3", "-l", "--", "export PASS=hunter2"],
      [";", "display-message", "-p", "#{pane_id}"],
    ].flat();
    expect(redacted(args)).toEqual(
      [
        ["new-session", "-d", "-s", "bz-1", "-e", "API_TOKEN=…", "--", "zsh"],
        [";", "send-keys", "-t", "%3", "-l", "--", "…"],
        [";", "display-message", "-p", "#{pane_id}"],
      ].flat(),
    );
  });
});

describe("a tmux failure", () => {
  it("names the command redacted, and keeps no cause that names it whole", () => {
    const args = ["new-session", "-e", "API_TOKEN=s3cret", "--", "zsh"];
    const failed = Object.assign(
      new Error("Command failed: tmux new-session -e API_TOKEN=s3cret"),
      {
        code: 1,
        stderr: "duplicate session",
      },
    );
    const err = new TmuxError(args, failed);
    expect([err.message, String(err.cause), err.args.join(" ")].join("\n")).not.toContain("s3cret");
    expect(err.message).toContain("duplicate session");
  });
});
