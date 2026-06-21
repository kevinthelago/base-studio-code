import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { startupLog, teeLogger } from "./vite-startup-log";

export default defineConfig(async ({ command }) => ({
  plugins: [react(), startupLog()],
  // Dev-only startup diagnostics (#1031): timestamp + tee Vite's own messages (optimizeDeps
  // re-bundle / full-reload — the cold-start stalls) to `.vite-dev.log`. Off for `vite build`.
  ...(command === "serve" ? { customLogger: teeLogger() } : {}),
  clearScreen: false,
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
      clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/store/index.ts", "./src/screens/Console.tsx"],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
