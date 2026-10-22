import fs from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/** The dev server reads web/.env.local; the e2e lesson server must use the same token. */
function envLocal(name: string): string | undefined {
  try {
    const line = fs
      .readFileSync(".env.local", "utf-8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}
const LESSON_TOKEN = process.env.LESSON_SERVER_TOKEN ?? envLocal("LESSON_SERVER_TOKEN") ?? "e2e-lesson-token";

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
      env: { LESSON_SERVER_URL: "http://127.0.0.1:8787", LESSON_SERVER_TOKEN: LESSON_TOKEN },
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
      // Streams lessons; not an HTTP health URL, ready once it logs "lesson server started".
      command: "uv run --directory ../worker python -m worker.lesson_server",
      wait: { stdout: /lesson server started/ },
      env: { LLM_PROVIDER: "fake", EMBEDDER: "fake", LESSON_SERVER_TOKEN: LESSON_TOKEN },
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
