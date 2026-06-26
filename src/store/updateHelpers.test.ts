import { describe, it, expect } from "vitest";
import { setMapEntry, deleteMapEntry, deleteMapEntries, updateArrayItem } from "./updateHelpers";

describe("setMapEntry", () => {
  it("adds a new key without mutating the input", () => {
    const map: Record<string, number> = { a: 1 };
    const next = setMapEntry(map, "b", 2);
    expect(next).toEqual({ a: 1, b: 2 });
    expect(map).toEqual({ a: 1 }); // original untouched
    expect(next).not.toBe(map); // new reference
  });

  it("overwrites an existing key", () => {
    const map: Record<string, number> = { a: 1, b: 2 };
    expect(setMapEntry(map, "a", 9)).toEqual({ a: 9, b: 2 });
  });

  it("supports numeric keys", () => {
    expect(setMapEntry<number, string>({ 0: "x" }, 1, "y")).toEqual({ 0: "x", 1: "y" });
  });

  it("preserves object values by reference", () => {
    const val = { nested: true };
    const next = setMapEntry<string, { nested: boolean }>({}, "k", val);
    expect(next.k).toBe(val);
  });
});

describe("deleteMapEntry", () => {
  it("removes a key without mutating the input", () => {
    const map = { a: 1, b: 2 };
    const next = deleteMapEntry(map, "a");
    expect(next).toEqual({ b: 2 });
    expect(map).toEqual({ a: 1, b: 2 }); // original untouched
    expect(next).not.toBe(map);
  });

  it("is a no-op for a missing key (still returns a fresh copy)", () => {
    const map: Record<string, number> = { a: 1 };
    const next = deleteMapEntry(map, "z");
    expect(next).toEqual({ a: 1 });
    expect(next).not.toBe(map);
  });
});

describe("deleteMapEntries", () => {
  it("removes every listed key without mutating the input", () => {
    const map = { a: 1, b: 2, c: 3 };
    const next = deleteMapEntries(map, ["a", "c"]);
    expect(next).toEqual({ b: 2 });
    expect(map).toEqual({ a: 1, b: 2, c: 3 });
    expect(next).not.toBe(map);
  });

  it("accepts a Set of keys and ignores absent ones", () => {
    const map: Record<string, number> = { a: 1, b: 2 };
    expect(deleteMapEntries(map, new Set(["b", "missing"]))).toEqual({ a: 1 });
  });

  it("returns a fresh copy when no keys match", () => {
    const map = { a: 1 };
    const next = deleteMapEntries(map, []);
    expect(next).toEqual({ a: 1 });
    expect(next).not.toBe(map);
  });
});

describe("updateArrayItem", () => {
  it("patches the item at index without mutating the array or other items", () => {
    const arr = [{ id: "a", n: 1 }, { id: "b", n: 2 }];
    const next = updateArrayItem(arr, 1, { n: 9 });
    expect(next).toEqual([{ id: "a", n: 1 }, { id: "b", n: 9 }]);
    expect(arr[1]).toEqual({ id: "b", n: 2 }); // original untouched
    expect(next).not.toBe(arr);
    expect(next[0]).toBe(arr[0]); // unchanged items keep their reference
    expect(next[1]).not.toBe(arr[1]); // patched item is a new object
  });

  it("leaves the array contents unchanged for an out-of-range index", () => {
    const arr = [{ n: 1 }];
    const next = updateArrayItem(arr, 5, { n: 9 });
    expect(next).toEqual([{ n: 1 }]);
    expect(next).not.toBe(arr); // a fresh copy
    expect(next[0]).toBe(arr[0]);
  });

  it("merges the patch over existing fields", () => {
    const next = updateArrayItem([{ a: 1, b: 2 }], 0, { b: 20 });
    expect(next).toEqual([{ a: 1, b: 20 }]);
  });
});
