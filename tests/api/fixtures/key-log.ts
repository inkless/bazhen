import { existsSync, readFileSync } from "node:fs";

/** What the key probe logged: each chunk of input, when it arrived, and its bytes in hex. */
export function readKeyLog(path: string): { at: number; hex: string }[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [at = "0", hex = ""] = line.split(" ");
      return { at: Number(at), hex };
    });
}
