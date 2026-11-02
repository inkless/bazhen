import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.medium.test.ts", "**/node_modules/**"],
          env: { BAZHEN_HOME: "/nonexistent/bazhen-unit-tests" },
        },
      },
      {
        test: {
          name: "medium",
          include: ["packages/*/src/**/*.medium.test.ts", "apps/*/src/**/*.medium.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
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
    ],
  },
});
