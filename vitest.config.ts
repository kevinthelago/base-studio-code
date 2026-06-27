/// <reference types="node" />
// ^ scopes Node types to THIS config file only (for node:url), so adding @types/node doesn't flip
//   setInterval/setTimeout return types across src (the DOM lib keeps them `number`). (#1309)
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  // Disable Vite's fs sandbox for tests so a NESTED git worktree (e.g. .claude/worktrees/<branch>/)
  // running install-free can read files from the shared repo-root node_modules — specifically
  // esbuild-wasm's .wasm, which the preview tests load via `?url` and which lives in an ancestor dir.
  // Test-only; harmless for the main checkout (its files are already inside the root). See #1669.
  server: { fs: { strict: false } },
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "@data": fileURLToPath(new URL("./src-tauri/data", import.meta.url)),
  } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/data/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});
