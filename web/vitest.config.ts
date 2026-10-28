import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // server-only throws outside Next's server build; unit tests run in plain Node.
      "server-only": path.resolve(__dirname, "tests/unit/empty.ts"),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "tests/unit/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
