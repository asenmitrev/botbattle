import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 60000,
    pool: "forks",
    // isolated-vm requires this flag on Node >= 20.
    poolOptions: { forks: { execArgv: ["--no-node-snapshot"] } },
  },
});
