/// <reference types="node" />
// The e2e harness's Vite config (#3264). Deliberately standalone rather than a merge over the app's
// `vite.config.ts`, for two reasons: it must not be able to perturb the app's dev server, and the app
// config is an async factory whose Tauri-oriented `server` block (fixed port 1420, warmup of the boot
// graph) is exactly what this must NOT inherit.
//
// It carries only what the harness page actually needs:
//   • the SAME two resolve aliases the app uses (`@` → src, `@data` → src-tauri/data), so the harness
//     imports the REAL `@/shared/lib/preview/*` modules rather than a copy;
//   • `@vitejs/plugin-react` — not for the harness itself (it is plain TS), but so the `@/` graph it
//     pulls in transforms identically to the app's;
//   • port 1421, so a Playwright run never fights a `npm run tauri -- dev` already holding 1420;
//   • `server.fs.strict: false` — same reason `vitest.config.ts` sets it (#1669): a NESTED, install-free
//     git worktree resolves `react`/`esbuild-wasm` from the shared repo-root `node_modules`, which is an
//     ANCESTOR of the Vite root and therefore outside the default fs sandbox. Without this the harness
//     runs only from the main checkout. No-op for the main checkout (its files are already inside root);
//   • `bscRecords` — the RETIRED-MODULE fallback, and the reason this comment now lists four resolvers
//     instead of three. `emit-records.mjs` names tsc, vite and vitest as the three that must each be
//     taught about records; this config is a FOURTH, standalone by design (see above), so it inherited
//     none of it. Retiring `Spacer` therefore broke the whole harness silently: the page could not
//     resolve one import, the module never evaluated, `window.__graphPagesHarness` never appeared, and
//     every spec timed out waiting for it. Nothing caught that, because `e2e/` is deliberately outside
//     the default gate. A standalone config buys isolation and pays for it in exactly this way — so
//     anything that changes how a module RESOLVES has to be added here too, not just to the app's config.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { bscRecords } from "../vite/bscRecords";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [bscRecords({ repoRoot: fileURLToPath(new URL("..", import.meta.url)) }), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "@data": fileURLToPath(new URL("../src-tauri/data", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: { strict: false },
    watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/coverage/**", "**/dist/**"] },
  },
});
