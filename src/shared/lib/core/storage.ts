import type { StateStorage } from "zustand/middleware";

// Detect whether we're running inside the Tauri native shell.
// When running with `npm run dev` (browser-only), Tauri APIs are absent
// and we fall back to localStorage so dev-mode still works.
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Lazy singleton — one Store instance for the app lifetime.
let _store: import("@tauri-apps/plugin-store").Store | null = null;

async function getStore(): Promise<import("@tauri-apps/plugin-store").Store> {
  if (!_store) {
    const { load } = await import("@tauri-apps/plugin-store");
    _store = await load("app-state.json");
  }
  return _store;
}

// #3612: throttle the expensive full-file fsync. Zustand's `persist` calls setItem after EVERY store
// `set()`, and under the Design Studio's per-component scan that is hundreds of writes in a burst. The
// in-memory value is updated immediately on each write (cheap), but `store.save()` — which flushes the
// whole file to disk — is throttled to at most once per SAVE_THROTTLE_MS, always flushing the LATEST
// value. A trailing timer that is never reset while pending means continuous writes still flush every
// interval rather than starving. Worst case on a hard crash: the last <SAVE_THROTTLE_MS of state isn't
// flushed — which crash recovery already tolerates.
const SAVE_THROTTLE_MS = 250;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(store: import("@tauri-apps/plugin-store").Store): void {
  if (saveTimer) return; // a flush is already pending; it will capture the latest in-memory value
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void store.save();
  }, SAVE_THROTTLE_MS);
}

export const persistStorage: StateStorage = {
  getItem: async (name) => {
    if (!isTauri()) return localStorage.getItem(name);
    const store = await getStore();
    return (await store.get<string>(name)) ?? null;
  },

  setItem: async (name, value) => {
    if (!isTauri()) { localStorage.setItem(name, value); return; }
    const store = await getStore();
    await store.set(name, value); // update the in-memory value immediately (cheap)
    scheduleSave(store);          // throttle the expensive disk flush (#3612)
  },

  removeItem: async (name) => {
    if (!isTauri()) { localStorage.removeItem(name); return; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } // supersede any pending throttled save
    const store = await getStore();
    await store.delete(name);
    await store.save();
  },
};
