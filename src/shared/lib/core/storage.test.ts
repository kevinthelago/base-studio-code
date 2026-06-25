import { describe, it, expect, beforeEach } from "vitest";
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
