import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globals: false,
    env: {
      HONCHO_WORKSPACE_ID: "openclaw-test",
    },
  },
});
