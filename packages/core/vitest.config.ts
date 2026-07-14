import { defineConfig } from "vitest/config";

// All test files share one Postgres and TRUNCATE ... CASCADE in beforeEach, so they
// must run one file at a time — parallel files corrupt each other's rows mid-test.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
