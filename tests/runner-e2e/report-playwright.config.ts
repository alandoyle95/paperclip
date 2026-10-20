import { defineConfig } from "@playwright/test";

// Static report verification requires neither a database nor paid credentials.
export default defineConfig({
  testDir: "../e2e", testMatch: "runner-e2e-dashboard.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, outputDir: "../../test-results/eval-report-navigation",
  use: { browserName: "chromium", headless: true }, reporter: "list",
});
