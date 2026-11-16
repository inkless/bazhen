import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// First in every project: the tests start only inside a capped run.
const CAPPED = "tests/support/capped-setup.ts";
// The holder suite's part that needs a systemd user manager.
const CONTAINMENT = "tests/holder/containment.test.ts";
// In every project: any test may be a property test.
const SEEDED = "tests/support/fast-check-setup.ts";
const RUST_CLI = fileURLToPath(new URL("target/release/bazhen", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "scripts/*.test.ts",
            "tests/support/*.test.ts",
          ],
          exclude: ["**/*.medium.test.ts", "**/node_modules/**"],
          globalSetup: [CAPPED],
          setupFiles: [SEEDED],
          env: { BAZHEN_HOME: "/nonexistent/bazhen-unit-tests" },
          // Vitest blanks CSS it isn't told to keep, even imported as ?raw text; the web tokens
          // are tested by reading their text.
          css: { include: [/apps\/web\/src\/ui\/.+\.css/] },
        },
      },
      {
        test: {
          name: "medium",
          include: [
            "packages/*/src/**/*.medium.test.ts",
            "apps/*/src/**/*.medium.test.ts",
            "scripts/*.medium.test.ts",
          ],
          exclude: ["scripts/hook-bench.medium.test.ts", "**/node_modules/**"],
          globalSetup: [CAPPED, "tests/support/medium-setup.ts"],
          setupFiles: [SEEDED],
        },
      },
      {
        // The CLI as a process: a case may wait out the CLI's own deadlines, and RUN_MS in
        // tests/cli/cli.ts caps each run below this.
        test: {
          name: "cli",
          include: ["tests/cli/**/*.test.ts"],
          globalSetup: [CAPPED, "tests/support/medium-setup.ts"],
          setupFiles: [SEEDED],
          testTimeout: 30_000,
        },
      },
      {
        // The same suite against the Rust CLI, which `pnpm test:medium` builds, while the Node
        // CLI stays the one `pnpm bazhen` runs.
        test: {
          name: "cli-rust",
          include: ["tests/cli/**/*.test.ts"],
          globalSetup: [CAPPED, "tests/support/medium-setup.ts"],
          setupFiles: [SEEDED],
          testTimeout: 30_000,
          env: { BAZHEN_CLI: RUST_CLI },
        },
      },
      {
        // A wall-clock gate, so it runs alone: in parallel with PTY tests it measures them.
        test: {
          name: "bench",
          include: ["scripts/hook-bench.medium.test.ts"],
          globalSetup: [CAPPED, "tests/support/medium-setup.ts"],
          setupFiles: [SEEDED],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 90_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: [CAPPED, "tests/support/global-setup.ts"],
          setupFiles: [SEEDED],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
      {
        // Real PTYs and holders, on a disposable host only (its setup checks), and no tmux reachable.
        test: {
          name: "holder",
          include: ["tests/holder/**/*.test.ts"],
          exclude: [CONTAINMENT, "**/node_modules/**"],
          globalSetup: [CAPPED, "tests/support/holder-setup.ts"],
          setupFiles: [SEEDED],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
      {
        // Holders in real systemd scopes: only where a user manager runs, as CI's containment job.
        test: {
          name: "containment",
          include: [CONTAINMENT],
          globalSetup: [CAPPED, "tests/support/holder-setup.ts"],
          setupFiles: [SEEDED],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "api",
          include: ["tests/api/**/*.test.ts"],
          globalSetup: [CAPPED, "tests/support/global-setup.ts"],
          setupFiles: [SEEDED],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          // Setup starts real agents and Codex's managed daemon, and teardown stops that daemon.
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
