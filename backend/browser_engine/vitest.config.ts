import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["typescript/tests/unit/**/*.test.ts"],
    allowOnly: !process.env["CI"],
    passWithNoTests: false,
    retry: 0,
    maxWorkers: 2,
    // Suspected destination-boundary bugs stop instead of continuing, locally as in CI.
    env: { BROWSER_ENGINE_BOUNDARY_STRICT: "1" },
  },
});
