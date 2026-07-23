import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { load } from "@tauri-apps/plugin-store";
import { persistStorage } from "./storage";

// persistStorage falls back to localStorage when not inside Tauri (jsdom env)

beforeEach(() => {
  localStorage.clear();
});

describe("persistStorage (localStorage fallback)", () => {
  it("setItem stores a value", async () => {
    await persistStorage.setItem("key", "value");
    expect(localStorage.getItem("key")).toBe("value");
  });

  it("getItem retrieves a stored value", async () => {
    localStorage.setItem("key", "hello");
    const result = await persistStorage.getItem("key");
    expect(result).toBe("hello");
  });

  it("getItem returns null for a missing key", async () => {
    const result = await persistStorage.getItem("nonexistent");
    expect(result).toBeNull();
  });

  it("removeItem deletes a stored value", async () => {
    localStorage.setItem("key", "to-remove");
    await persistStorage.removeItem("key");
    expect(localStorage.getItem("key")).toBeNull();
  });

  it("setItem overwrites an existing value", async () => {
    await persistStorage.setItem("key", "first");
    await persistStorage.setItem("key", "second");
    const result = await persistStorage.getItem("key");
    expect(result).toBe("second");
  });
});

// #3612 — inside Tauri, the expensive full-file fsync (store.save) is THROTTLED: a burst of store writes
// (e.g. the Design Studio's per-component scan, hundreds of setItem calls) flushes once per window, not
// once per write, while the in-memory value still updates on every write.
const win = window as unknown as { __TAURI_INTERNALS__?: unknown };

describe("persistStorage — throttled save (#3612)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    win.__TAURI_INTERNALS__ = {}; // force isTauri() true → the plugin-store path (not the localStorage fallback)
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete win.__TAURI_INTERNALS__;
  });

  it("coalesces a burst of writes into ONE disk save; each write still updates memory", async () => {
    const store = await load("app-state.json");
    vi.mocked(store.set).mockClear();
    vi.mocked(store.save).mockClear();

    await persistStorage.setItem("app-state", "v1");
    await persistStorage.setItem("app-state", "v2");
    await persistStorage.setItem("app-state", "v3");

    expect(store.set).toHaveBeenCalledTimes(3);   // in-memory value updated on EVERY write (cheap)
    expect(store.save).toHaveBeenCalledTimes(0);  // ...but the fsync is throttled — none fired yet

    await vi.advanceTimersByTimeAsync(300);        // past SAVE_THROTTLE_MS (250)
    expect(store.save).toHaveBeenCalledTimes(1);   // exactly ONE flush for the whole burst
  });

  it("is a throttle, not one-shot: a later write schedules a fresh flush", async () => {
    const store = await load("app-state.json");
    vi.mocked(store.save).mockClear();

    await persistStorage.setItem("app-state", "a");
    await vi.advanceTimersByTimeAsync(300);
    expect(store.save).toHaveBeenCalledTimes(1);

    await persistStorage.setItem("app-state", "b");
    await vi.advanceTimersByTimeAsync(300);
    expect(store.save).toHaveBeenCalledTimes(2);
  });
});
