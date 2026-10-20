import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "**/unit/**",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Not an HTTP server: ready once it logs "worker started".
      command: "uv run --directory ../worker python -m worker",
      wait: { stdout: /worker started/ },
      env: { LLM_PROVIDER: "fake" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
