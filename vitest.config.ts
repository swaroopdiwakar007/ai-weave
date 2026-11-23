import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, so no build is required first.
    alias: [
      { find: "@ai-weave/core/testing", replacement: pkg("core/src/testing/index.ts") },
      {
        find: /^@ai-weave\/(core|anthropic|openai|gemini|web)$/,
        replacement: pkg("$1/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/{search,server,react}/**", "packages/{core,web}/src/index.ts"],
      thresholds: {
        "packages/core/src/**": { lines: 85, functions: 85, statements: 85, branches: 75 },
        "packages/web/src/**": { lines: 85, functions: 85, statements: 85, branches: 75 },
      },
    },
  },
});
