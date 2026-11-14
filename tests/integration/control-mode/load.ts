import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** About 50 lines a second, coloured, as a busy agent prints. */
export const BUSY_AGENT = `sh -c 'i=0; while :; do i=$((i+1)); printf "\\033[32m●\\033[0m step %d: reading src/module/file.ts and writing a longer line of agent output\\n" $i; sleep 0.02; done'`;

export const FLOOD = "yes";

/** A 50 MB file of numbered lines, and a pane command that prints it forever. */
export function bigFileLoop(dir: string): string {
  const file = join(dir, "big.txt");
  const line = "x".repeat(70);
  const rows: string[] = [];
  for (let i = 0; i < 650_000; i++) rows.push(`${i} ${line}`);
  writeFileSync(file, `${rows.join("\n")}\n`);
  return `sh -c 'while :; do cat ${file}; done'`;
}
