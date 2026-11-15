import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ShellReport } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";

/** What became of a report: kept, older than the kept line, or not the shell's own. */
export type ReportOutcome = "kept" | "stale" | "refused";

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

/**
 * Takes what shells' integrations report over the socket. A report counts only with the token
 * the shell was started with, so another shell, or an agent, which has the socket too, can't set
 * a shell's last line. Every program running in the shell inherits its token, though, and can.
 */
export class ShellReports {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  report(terminalId: string, report: ShellReport): ReportOutcome {
    const kept = this.store.shellTokenHash(terminalId);
    if (kept === null) return "refused";
    const given = Buffer.from(hashOf(report.token), "hex");
    const expected = Buffer.from(kept, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "refused";
    return this.store.noteShellCommand(terminalId, report.at, report.command) ? "kept" : "stale";
  }
}
