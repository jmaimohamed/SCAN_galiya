import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // CI / no .env: rely on the environment.
}

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // `server-only` throws outside the react-server condition; tests run server code directly.
      "server-only": path.join(root, "tests/support/empty.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Files must run one at a time (each empties the shared test database):
          // the npm scripts pass --no-file-parallelism.
          setupFiles: ["tests/support/integration-setup.ts"],
          env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
