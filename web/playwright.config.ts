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
      // Fake LLM and embeddings; private hosts allowed so it can fetch the fixture site below.
      env: { LLM_PROVIDER: "fake", EMBEDDER: "fake", FETCH_ALLOW_PRIVATE_HOSTS: "true" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Fixture pages that e2e tests add as web sources.
      command:
        "uv run --directory ../worker python -m http.server 8765 --bind 127.0.0.1 --directory ../web/tests/e2e/fixtures/site",
      url: "http://127.0.0.1:8765/sql-article.html",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
