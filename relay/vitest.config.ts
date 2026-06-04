import { defineConfig } from "vitest/config";

// Standalone config so `npm test` here runs the relay's own suite in isolation. Without
// it, vitest climbs to the repo-root `vitest.config.ts` (jsdom + the React plugin, which
// pulls in `src/test/setup.ts`) and the relay workspace fails to load — see the worker's
// pure protocol tests in `test/`. The relay has no DOM; a plain node environment is right.
export default defineConfig({
  root: __dirname,
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
