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

export const persistStorage: StateStorage = {
  getItem: async (name) => {
    if (!isTauri()) return localStorage.getItem(name);
    const store = await getStore();
    return (await store.get<string>(name)) ?? null;
  },

  setItem: async (name, value) => {
    if (!isTauri()) { localStorage.setItem(name, value); return; }
    const store = await getStore();
    await store.set(name, value);
    await store.save();
  },

  removeItem: async (name) => {
    if (!isTauri()) { localStorage.removeItem(name); return; }
    const store = await getStore();
    await store.delete(name);
    await store.save();
  },
};
