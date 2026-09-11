import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { startupLog, teeLogger } from "./vite-startup-log";
import { bscRecords } from "./vite/bscRecords";
import { devWatchIgnored } from "./src/shared/lib/core/devWatchIgnore";

/** Absolute, forward-slashed, no trailing slash — the shape chokidar matches against. */
const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");

export default defineConfig(async ({ command }) => ({
  // `bscRecords` is a FALLBACK resolver: it answers an `@/…` import from a packaged seed's srcText only
  // when no file exists at that path. While the file is there it wins, so this plugin changes nothing by
  // itself — it is what makes DELETING a file survivable, which is the one thing that blocked retiring the
  // ~950 modules whose records already exist. `enforce: "pre"` puts it ahead of the alias so it matches the
  // specifier exactly rather than guessing which extension the alias resolved to.
  plugins: [bscRecords({ repoRoot: fileURLToPath(new URL(".", import.meta.url)) }), react(), startupLog()],
  // A WORKER IS A SEPARATE BUILD WITH A SEPARATE PLUGIN LIST. `resolve.alias` is config-level so the
  // worker inherits it, but `plugins` is not — `worker.plugins` defaults to empty, so inside a worker's
  // graph `@/features/algorithms/lib/tracer` aliased straight to a path on disk and nothing was left to
  // answer for the record once the file went. Only `vite build` sees this: tsc reads `tsconfig.paths`,
  // and vitest never bundles a worker, so all three of them stay green while the shipped bundle cannot
  // be produced. Same class as #the-deletion-gate-is-the-bundle, one resolver further in.
  worker: { plugins: () => [bscRecords({ repoRoot: fileURLToPath(new URL(".", import.meta.url)) })] },
  // `@/…` → `src/…` (#1309) so the feature-first reorg doesn't churn deep-relative imports.
  // `@data/…` → `src-tauri/data/…` (#1462): the unified packaged-data root. The stage/blueprint
  // JSON lives there now (outside src/) and is build-time-bundled via import.meta.glob.
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "@data": fileURLToPath(new URL("./src-tauri/data", import.meta.url)),
  } },
  // Dev-only startup diagnostics (#1031): timestamp + tee Vite's own messages (optimizeDeps
  // re-bundle / full-reload — the cold-start stalls) to `.vite-dev.log`. Off for `vite build`.
  ...(command === "serve" ? { customLogger: teeLogger() } : {}),
  clearScreen: false,
  build: {
    // Build output goes under `target/`, with the Rust build output, and NOT to a `dist/` at the repo
    // root (`epic-built-items-live-only-in-target`). `tauri.conf.json`'s `frontendDist` names the same
    // path; the two must move together or `tauri build` bundles a stale or missing frontend.
    //
    // Vite only empties the directory it is given, so this cannot reach the rest of `target/`. It is
    // also inside the config root, so there is no out-of-root warning to suppress.
    outDir: "target/dist",
    emptyOutDir: true,
  },
  // Pre-bundle the heavy dependencies once at dev-server start, rather than letting Vite
  // discover them during the cold module crawl and re-optimize mid-load (each re-optimization
  // reloads the page — a big part of the ~40s dev cold start, #perf). `lucide-react` is the worst:
  // without pre-bundling, dev serves each of its ~1500 icons as a separate module request.
  optimizeDeps: {
    include: [
      "lucide-react",
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@xterm/addon-webgl",
      "react-markdown",
      "qrcode.react",
    ],
  },
  server: {
    // Bind IPv4 explicitly (#perf). Vite's default "localhost" binds IPv6 (::1) here, but WebView2
    // navigates to the devUrl trying IPv4 (127.0.0.1) first — each connection then stalls ~2s on
    // the failed IPv4 attempt before falling back to IPv6. With the boot graph's ~dozen connections
    // that was ~25s of the cold start. Binding 127.0.0.1 + a matching 127.0.0.1 devUrl keeps it
    // IPv4 end-to-end, no dual-stack stall.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Pre-transform the boot graph in parallel at server start (#perf) instead of letting the
    // WebView pull it module-by-module in a serial waterfall on first load. This overlaps with
    // the native/WebView2 launch, so by the time the page loads the boot modules are cached.
    warmup: {
      // Every entry must EXIST. A path that does not is not a silent no-op — Vite logs a "Failed to load
      // url" pre-transform error on every boot, which is worded identically to a genuine unresolvable
      // module. `./src/app/console/index.tsx` was one: the console barrel went in the feature-first reorg
      // and the warmup list kept naming it, so the dev server has been printing a resolution failure at
      // every start. Harmless in itself, and expensive for exactly the reason `dev-boot-check` exists —
      // it makes a real retirement failure indistinguishable from standing noise.
      clientFiles: ["./src/app/main.tsx", "./src/app/App.tsx", "./src/store/index.ts", "./src/app/console/ConsoleGraphHost.tsx"],
    },
    watch: {
      // The three large NON-source trees inside the watched root — build output, and the nested
      // worktrees the parallel-agent workflow creates. Why each one is here, and the two glob traps
      // behind the worktree patterns, are documented at the source: `devWatchIgnore.ts`. (#perf)
      ignored: devWatchIgnored(REPO_ROOT),
    },
  },
}));
