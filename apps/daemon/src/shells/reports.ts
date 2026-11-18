import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ShellDecline, ShellPrompt, ShellReport } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";

/** What became of a report: kept, older than the kept line, or not the shell's own. */
export type ReportOutcome = "kept" | "stale" | "refused";

/** How far ahead of the daemon's clock a report's time may be. */
const AHEAD_MICROS = 60_000_000;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * A new shell's token, which its integration reports with, and the hash the store keeps of it.
 * The token itself goes only into the shell's environment.
 */
export function newShellToken(random: (size: number) => Buffer = randomBytes): {
  token: string;
  hash: string;
} {
  const token = random(32).toString("base64url");
  return { token, hash: hashOf(token) };
}

/** Where a shell's first-prompt report goes once its token has vouched for it. */
export interface PromptListener {
  /** The shell's editor is reading, and reads a marked paste where `brackets` says so. */
  prompted(terminalId: string, brackets: boolean): void;
  /** The shell won't take a line typed back. */
  declined(terminalId: string): void;
}

/**
 * Takes what shells' integrations report over the socket. A report counts only with the token
 * the shell was started with, so another shell, or an agent, which has the socket too, can't set
 * a shell's last line. Every program running in the shell inherits its token, though, and can.
 */
export class ShellReports {
  private readonly store: Store;
  private readonly prompts: PromptListener;
  private readonly nowMicros: () => number;

  constructor(
    store: Store,
    prompts: PromptListener,
    nowMicros: () => number = () => Date.now() * 1000,
  ) {
    this.store = store;
    this.prompts = prompts;
    this.nowMicros = nowMicros;
  }

  report(terminalId: string, report: ShellReport): ReportOutcome {
    if (!this.owns(terminalId, report.token)) return "refused";
    // A shell's clock, or a report forged with a time far ahead, could otherwise keep every later
    // line from counting: a report counts as at most a minute ahead of the daemon's own clock.
    const at = Math.min(report.at, this.nowMicros() + AHEAD_MICROS);
    return this.store.noteShellCommand(terminalId, at, report.command) ? "kept" : "stale";
  }

  /** The shell reached its first prompt: whether the report was the shell's own. */
  prompt(terminalId: string, report: ShellPrompt): boolean {
    if (!this.owns(terminalId, report.token)) return false;
    this.prompts.prompted(terminalId, report.brackets === true);
    return true;
  }

  /** The shell won't take a line typed back: whether the report was the shell's own. */
  decline(terminalId: string, report: ShellDecline): boolean {
    if (!this.owns(terminalId, report.token)) return false;
    this.prompts.declined(terminalId);
    return true;
  }

  private owns(terminalId: string, token: string): boolean {
    const kept = this.store.shellTokenHash(terminalId);
    if (kept === null) return false;
    const given = Buffer.from(hashOf(token), "hex");
    const expected = Buffer.from(kept, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
