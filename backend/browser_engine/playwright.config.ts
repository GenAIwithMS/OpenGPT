import { defineConfig } from "@playwright/test";

// Suspected destination-boundary bugs stop instead of continuing, locally as in CI. Workers
// inherit this process's environment.
process.env["BROWSER_ENGINE_BOUNDARY_STRICT"] ??= "1";

export default defineConfig({
  testDir: "./typescript/tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/browser-results.json" }],
  ],
  metadata: {
    revision: process.env["GITHUB_SHA"] ?? "local-working-tree",
    command: "pnpm test:browser",
    fixtures: "typescript/tests/browser (controlled local fixtures)",
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
