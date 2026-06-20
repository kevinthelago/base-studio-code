import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig(async () => ({
  plugins: [react()],
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
