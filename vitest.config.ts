import { defineConfig } from "vitest/config";

// First in every project: the tests start only inside a capped run.
const CAPPED = "tests/support/capped-setup.ts";
// In every project whose tests can be property tests.
const SEEDED = "tests/support/fast-check-setup.ts";

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
        // A wall-clock gate, so it runs alone: in parallel with PTY tests it measures them.
        test: {
          name: "bench",
          include: ["scripts/hook-bench.medium.test.ts"],
          globalSetup: [CAPPED, "tests/support/medium-setup.ts"],
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
          globalSetup: [CAPPED, "tests/support/holder-setup.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "api",
          include: ["tests/api/**/*.test.ts"],
          globalSetup: [CAPPED, "tests/support/global-setup.ts"],
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
