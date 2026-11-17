// child_process as the checks that guard process starts know it: read by the signal scan
// (scripts/signal-paths.ts) and the lint rules (scripts/lint-plugin.ts), so both agree on what a
// start is. No imports, as cargo-gate and oxlint both load it.

/** child_process's process-starting functions. */
export const CHILD_PROCESS_STARTS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

/** The specifiers child_process is imported by. */
export const CHILD_PROCESS_MODULES = ["child_process", "node:child_process"] as const;
