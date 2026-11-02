import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          env: { BAZHEN_HOME: "/nonexistent/bazhen-unit-tests" },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
