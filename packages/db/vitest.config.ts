import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The db tests share one throwaway database and recreate the `discord` schema, so test files
    // run one at a time.
    fileParallelism: false,
  },
});
