import { defineConfig } from "vitest/config";

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
          env: { BAZHEN_HOME: "/nonexistent/bazhen-unit-tests" },
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
          globalSetup: ["tests/support/medium-setup.ts"],
        },
      },
      {
        // A wall-clock gate, so it runs alone: in parallel with PTY tests it measures them.
        test: {
          name: "bench",
          include: ["scripts/hook-bench.medium.test.ts"],
          globalSetup: ["tests/support/medium-setup.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "api",
          include: ["tests/api/**/*.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
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
