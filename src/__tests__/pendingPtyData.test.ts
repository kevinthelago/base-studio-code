import { describe, it, expect } from "vitest";
import { PendingPtyData } from "../lib/pendingPtyData";

/**
 * Pins the contract used by TerminalView's hide-and-buffer path (#52). The
 * helper trades a small JS-heap allocation for skipping xterm.write while a
 * pane is hidden; on flush it must hand back everything still within the cap,
 * in order.
 */
describe("PendingPtyData", () => {
  it("flush returns all pushed chunks concatenated, in order", () => {
    const p = new PendingPtyData(1024);
    p.push("hello ");
    p.push("world");
    expect(p.flush()).toBe("hello world");
  });

  it("flush on empty returns ''", () => {
    expect(new PendingPtyData(1024).flush()).toBe("");
  });

  it("flush clears the buffer and resets size to 0", () => {
    const p = new PendingPtyData(1024);
    p.push("abc");
    expect(p.size()).toBe(3);
    p.flush();
    expect(p.size()).toBe(0);
    expect(p.flush()).toBe("");
  });

  it("size tracks total bytes across pushes", () => {
    const p = new PendingPtyData(1024);
    p.push("ab");      // 2
    p.push("cdef");    // 4 → 6
    p.push("");        // ignored
    expect(p.size()).toBe(6);
  });

  it("drops the oldest chunks first once size exceeds the cap", () => {
    // Cap is small so we can drive the eviction predictably.
    const p = new PendingPtyData(10);
    p.push("AAAA");    // size 4
    p.push("BBBB");    // size 8
    p.push("CCCC");    // size 12 → evict "AAAA" → size 8
    expect(p.size()).toBeLessThanOrEqual(10);
    expect(p.flush()).toBe("BBBBCCCC");
  });

  it("keeps at least one chunk even when it alone exceeds the cap", () => {
    // A single oversized payload (e.g. a giant claude response) should survive
    // intact rather than being dropped — dropping would silently lose data the
    // user might still want to see on flush.
    const p = new PendingPtyData(8);
    p.push("X".repeat(64));
    // Cap exceeded, but the lone chunk stays.
    expect(p.size()).toBe(64);
    expect(p.flush()).toBe("X".repeat(64));
  });

  it("eviction respects insertion order when multiple chunks must go", () => {
    const p = new PendingPtyData(6);
    p.push("AA");      // 2
    p.push("BB");      // 4
    p.push("CC");      // 6
    p.push("DDDD");    // 10 → evict "AA" (8) → evict "BB" (6) — still within cap
    expect(p.flush()).toBe("CCDDDD");
  });
});
