import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    // Sequential by default: several tests intentionally share mutable
    // global state (the single Escrow wallet, rate-limit buckets), so
    // running them in parallel would make results nondeterministic.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
