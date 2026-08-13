// #the-component-scan-remembers-what-it-already-built — the durable scan cache's frontend half.
//
// The property every test here defends is ASYMMETRIC, and it is the whole reason this cache is safe to
// have: it may only ever SAVE work, never withhold a scan that should run. A withheld scan leaves a stale
// badge (or none) on a component that is actually broken — strictly worse than the 111.8s of rebuilding
// this exists to remove. So every degraded input below is asserted to resolve toward SCANNING.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadScanCache, saveScanCache, type CachedScan } from "./componentBridge";
import { pendingScans, type ScannableComponent } from "./componentScan";
import * as bscMod from "@/shared/lib/core/bsc";

const scannable = (id: string, sig: string): ScannableComponent =>
  ({ id, sig } as unknown as ScannableComponent);

beforeEach(() => { vi.restoreAllMocks(); });

describe("loadScanCache", () => {
  const withStdout = (out: string) => vi.spyOn(bscMod, "bsc").mockResolvedValue(out);

  it("parses the stored map into entries the sweep can use", async () => {
    withStdout(JSON.stringify({
      card: { sig: "s1", status: { state: "ok" }, stateBlanks: [] },
      panel: { sig: "s2", status: { state: "error", kind: "build", message: "boom" }, stateBlanks: ["empty"] },
    }));
    const cache = await loadScanCache();
    expect(Object.keys(cache).sort()).toEqual(["card", "panel"]);
    expect(cache.panel.sig).toBe("s2");
    // The status rides verbatim — the cache is a courier for the frontend's own shape.
    expect(cache.panel.status).toEqual({ state: "error", kind: "build", message: "boom" });
    expect(cache.panel.stateBlanks).toEqual(["empty"]);
  });

  it("returns EMPTY on every failure shape — an unreadable cache means scan everything", async () => {
    // Each of these is a real state: no bridge, an old binary that lacks the verb, a half-written file.
    for (const out of ["", "not json", "[1,2,3]", "null", '"a string"']) {
      withStdout(out);
      expect(await loadScanCache()).toEqual({});
    }
    vi.spyOn(bscMod, "bsc").mockRejectedValue(new Error("no bridge"));
    expect(await loadScanCache()).toEqual({});
  });

  it("drops a row with no signature — half the key is missing, so it could never be a hit", async () => {
    // Dropping it here is honest: keeping it would look like a valid entry that mysteriously never
    // matches, which is harder to diagnose than its absence.
    withStdout(JSON.stringify({
      good: { sig: "s1", status: { state: "ok" }, stateBlanks: [] },
      noSig: { status: { state: "ok" }, stateBlanks: [] },
      emptySig: { sig: "", status: { state: "ok" }, stateBlanks: [] },
      noStatus: { sig: "s2" },
    }));
    expect(Object.keys(await loadScanCache())).toEqual(["good"]);
  });

  it("defaults a missing stateBlanks to [] rather than dropping the row", async () => {
    // `[]` is meaningful (it CLEARS a blank badge), and a row from an older writer that omitted it is
    // still a usable signature — the point is to skip a rebuild, and that half is intact.
    withStdout(JSON.stringify({ card: { sig: "s1", status: { state: "ok" } } }));
    expect((await loadScanCache()).card.stateBlanks).toEqual([]);
  });
});

describe("saveScanCache", () => {
  it("sends the entries as one JSON object on stdin", async () => {
    const spy = vi.spyOn(bscMod, "bsc").mockResolvedValue("1");
    const entries: Record<string, CachedScan> = {
      card: { sig: "s1", status: { state: "ok" }, stateBlanks: [] },
    };
    await saveScanCache(entries);
    expect(spy).toHaveBeenCalledWith(null, ["ui", "scan-cache", "put"], JSON.stringify(entries));
  });

  it("writes NOTHING for an empty batch — no spawn for no work", async () => {
    const spy = vi.spyOn(bscMod, "bsc").mockResolvedValue("0");
    await saveScanCache({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("never throws when the bridge is absent — a failed write costs a re-scan, not a crash", async () => {
    vi.spyOn(bscMod, "bsc").mockRejectedValue(new Error("no bridge"));
    await expect(saveScanCache({ a: { sig: "s", status: { state: "ok" }, stateBlanks: [] } })).resolves.toBeUndefined();
  });
});

describe("the cache and the sweep agree on what is pending", () => {
  // The join that makes the whole thing work: `pendingScans` already decides by signature, so a cache
  // seeded into the same map is understood without teaching it anything new.
  it("skips a component whose cached signature still matches", async () => {
    vi.spyOn(bscMod, "bsc").mockResolvedValue(JSON.stringify({
      card: { sig: "s1", status: { state: "ok" }, stateBlanks: [] },
    }));
    const cache = await loadScanCache();
    const seeded = new Map(Object.entries(cache).map(([id, e]) => [id, e.sig]));
    expect(pendingScans([scannable("card", "s1")], seeded)).toEqual([]);
  });

  it("RE-SCANS a component whose source changed, even though its id is cached", async () => {
    // The stale-entry case. The signature is part of the key precisely so an edit cannot be masked.
    vi.spyOn(bscMod, "bsc").mockResolvedValue(JSON.stringify({
      card: { sig: "OLD", status: { state: "ok" }, stateBlanks: [] },
    }));
    const cache = await loadScanCache();
    const seeded = new Map(Object.entries(cache).map(([id, e]) => [id, e.sig]));
    expect(pendingScans([scannable("card", "NEW")], seeded).map((s) => s.id)).toEqual(["card"]);
  });

  it("scans everything when the cache is unreachable — the safe direction, end to end", async () => {
    vi.spyOn(bscMod, "bsc").mockRejectedValue(new Error("no bridge"));
    const cache = await loadScanCache();
    const seeded = new Map(Object.entries(cache).map(([id, e]) => [id, e.sig]));
    const all = [scannable("a", "1"), scannable("b", "2")];
    expect(pendingScans(all, seeded)).toHaveLength(2);
  });
});
