import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["sdk/**/*.test.js", "shell/**/*.test.js", "../plugins/**/*.test.js"] },
});
