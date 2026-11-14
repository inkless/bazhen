// Run in a pane as `node recorder.ts <log> [mode…]`: turns on the private modes named (DECSET
// numbers, say 2004 or 1), then logs each chunk of input as `<epoch ms> <hex>`, one per line.
import { appendFileSync } from "node:fs";

const [log, ...modes] = process.argv.slice(2);
if (log === undefined) throw new Error("usage: recorder <log> [mode…]");
process.stdin.setRawMode(true);
for (const mode of modes) process.stdout.write(`\x1b[?${mode}h`);
process.stdout.write("recorder ready\r\n");
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(log, `${Date.now()} ${chunk.toString("hex")}\n`);
});
