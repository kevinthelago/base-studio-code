// The executable spec for the `stream-merge.ts` graph node (#3465) — imports and RUNS the module.
import { describe, it, expect } from "vitest";
import { mergeFeeds, feedStream } from "./streamMerge";

type Kind = "error" | "warning" | "note";
const KINDS: Kind[] = ["error", "warning", "note"];

// Two differently-shaped sources — the whole point is they don't share a type until projected.
interface Alert { at: number; live: boolean; msg: string }
interface Log { ts: number; level: "warn" | "info"; text: string }

const alerts = (xs: Alert[]) =>
  feedStream(xs, (a) => ({ kind: "error" as const, pinned: a.live, sortKey: a.at, label: a.msg }));
const logs = (xs: Log[]) =>
  feedStream(xs, (l) => ({
    kind: l.level === "warn" ? ("warning" as const) : ("note" as const),
    pinned: false, sortKey: l.ts, label: l.text,
  }));

describe("mergeFeeds", () => {
  it("merges heterogeneous streams into one feed, newest first", () => {
    const out = mergeFeeds<Kind, { label: string }>([
      alerts([{ at: 300, live: false, msg: "a" }]),
      logs([{ ts: 100, level: "info", text: "b" }, { ts: 200, level: "warn", text: "c" }]),
    ], KINDS);
    expect(out.items.map((i) => i.label)).toEqual(["a", "c", "b"]); // 300, 200, 100
  });

  it("pins a LIVE item above the time sort — even an older one", () => {
    // The property the pin exists for: a currently-live alert outranks a newer resolved one.
    const out = mergeFeeds<Kind, { label: string }>([
      alerts([{ at: 10, live: true, msg: "live-but-old" }, { at: 999, live: false, msg: "new-resolved" }]),
    ], KINDS);
    expect(out.items.map((i) => i.label)).toEqual(["live-but-old", "new-resolved"]);
  });

  it("orders MULTIPLE pinned items among themselves by recency — the sentinel-Infinity trap", () => {
    // The original modelled 'live' as `sortKey: Infinity`; two such items compared Infinity-Infinity =
    // NaN and their order was undefined. A real `pinned` flag keeps them sorted among each other.
    const out = mergeFeeds<Kind, { label: string }>([
      alerts([{ at: 100, live: true, msg: "older-live" }, { at: 200, live: true, msg: "newer-live" }]),
    ], KINDS);
    expect(out.items.map((i) => i.label)).toEqual(["newer-live", "older-live"]);
  });

  it("counts every declared kind, zeros included, from the merged feed", () => {
    const out = mergeFeeds<Kind, { label: string }>([
      alerts([{ at: 1, live: false, msg: "e" }]),
      logs([{ ts: 2, level: "warn", text: "w" }]),
    ], KINDS);
    expect(out.counts).toEqual({ error: 1, warning: 1, note: 0 });
    // The count agrees with the list because it IS the list — one pass.
    expect(out.total).toBe(out.items.length);
    expect(out.hasItems).toBe(true);
  });

  it("a projection returning null drops the item — filtering lives in the projection", () => {
    const filtered = feedStream([{ at: 1, done: true }, { at: 2, done: false }], (x) =>
      x.done ? null : { kind: "note" as const, pinned: false, sortKey: x.at, label: "kept" });
    const out = mergeFeeds<Kind, { label: string }>([filtered], KINDS);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].label).toBe("kept");
  });

  it("is stable within a rank — equal sortKeys keep input order (no reshuffle between renders)", () => {
    const out = mergeFeeds<Kind, { label: string }>([
      logs([{ ts: 5, level: "info", text: "first" }, { ts: 5, level: "info", text: "second" }]),
    ], KINDS);
    expect(out.items.map((i) => i.label)).toEqual(["first", "second"]);
  });

  it("empty in ⇒ empty feed with all-zero counts, never a missing key", () => {
    const out = mergeFeeds<Kind, { label: string }>([], KINDS);
    expect(out).toEqual({ items: [], counts: { error: 0, warning: 0, note: 0 }, total: 0, hasItems: false });
  });
});
