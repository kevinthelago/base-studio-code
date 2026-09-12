import "@testing-library/jest-dom";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

// ONE `listen` spy, shared by the event module and by the WINDOW-SCOPED door.
//
// The app's bridges subscribe on their own window now (`the-agent-view-is-a-window-a-session-navigates-without-moving-yours`):
// `listen()` from the api root registers the target `Any` and so hears an emit aimed at another window,
// which is how a tear-off could answer a request meant for the user's window. `getCurrentWebviewWindow()`
// reaches the real API, which throws in jsdom ("Cannot read properties of undefined (reading 'metadata')"),
// so it needs a mock — and it must be the SAME spy, or a test that asserts what the app subscribed to sees
// an empty call list and fails while the app is fine.
const tauriEvents = vi.hoisted(() => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriEvents.listen,
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main", listen: tauriEvents.listen }),
  // Kept because mocking the module replaces ALL of it: `detachWindow.ts` constructs one of these for a
  // tab tear-off, and losing the export would break tests that have nothing to do with listening.
  WebviewWindow: class {
    label: string;
    constructor(label: string) { this.label = label; }
    once = vi.fn();
    close = vi.fn();
    listen = tauriEvents.listen;
  },
}));

vi.mock("@tauri-apps/plugin-log", () => ({
  trace: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn().mockResolvedValue(undefined),
  info:  vi.fn().mockResolvedValue(undefined),
  warn:  vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }),
}));

// xterm can't initialize in jsdom (open() needs real DOM measurements) — stub it globally so any
// component that hosts a terminal (the planner + the Design Studio's always-on designer pane, #2597)
// renders in tests. A test that asserts terminal wiring can still override this per-file.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
    // The clipboard wiring (#3157) calls these on every open terminal; stub them so terminal-mounting
    // tests (DesignsWorkbench, console panes, algorithms/teams terminals, …) don't crash on mount.
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => {
  class FitAddon {
    fit = vi.fn();
  }
  return { FitAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// jsdom lacks ResizeObserver; components that observe element size (xterm hosts, graph canvases)
// construct one at mount. A no-op stub keeps those renders from throwing.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// The `node` project (see vitest.config.ts) has no `localStorage`, and ANY test that transitively
// imports `@/store` gets zustand's `persist` middleware, which writes to it during hydration —
// off the test's own await chain. Without this the tests still PASS while throwing unhandled
// rejections in the background, which is the worst of both: green output, broken storage layer.
// Measured before the shim: 80 unhandled `ReferenceError: localStorage is not defined` across 31
// files. In-memory is the right shape — `persist` only needs get/set/remove to round-trip, and a
// per-file fresh module registry means tests do not leak state through it.
if (!(globalThis as { localStorage?: unknown }).localStorage) {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
}
