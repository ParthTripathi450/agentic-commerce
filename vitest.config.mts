import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

loadEnv({ path: ".env.local", quiet: true });

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "node",
    /*
     * These are integration tests against a single Postgres database: they
     * create orders, hold stock and mutate inventory. Running files in parallel
     * makes them race over that shared state, so results shift between runs.
     * Serial execution is the correct trade — the suite is seconds either way.
     */
    fileParallelism: false,
    sequence: { concurrent: false },
    // Embedding model load and integration queries need room on a cold cache.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
