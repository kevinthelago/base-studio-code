// The gist store-sync decision core (epic #4202, slice 1). Covers the full verdict table, both STOP
// verdicts, the canonical serialization that keeps two machines' hashes comparable, and the SHA-256
// contract shared with `bsc-cli-util::vendored`.
import { describe, it, expect } from "vitest";
import {
  decideSync, isAutomatic, explainSync, canonicalDocument, sha256Hex,
  type GistSyncState,
} from "./storeSync";

const A = "aaaa", B = "bbbb", C = "cccc";
const synced = (gistId = "g1", lastSyncedHash?: string): GistSyncState => ({ gistId, lastSyncedHash });

describe("decideSync verdict table (#4202)", () => {
  it("creates when there is no gist yet", () => {
    expect(decideSync({ local: A, remote: null, state: {} })).toEqual({ kind: "create" });
  });

  /** An unreadable remote must not read as "remote is empty, push over it" — but with no gist id there is
   *  nothing to push over, so `create` is the same safe answer. */
  it("creates when the gist id is absent even if a remote hash was somehow read", () => {
    expect(decideSync({ local: A, remote: B, state: {} })).toEqual({ kind: "create" });
  });

  it("is up-to-date when both sides hold the same content", () => {
    expect(decideSync({ local: A, remote: A, state: synced("g1", A) })).toEqual({ kind: "up-to-date" });
  });

  /** Equality wins over the ancestor: if both sides agree there is nothing to do, however stale the
   *  recorded base is (e.g. two machines pushed the same edit). */
  it("is up-to-date when both moved to the SAME content", () => {
    expect(decideSync({ local: B, remote: B, state: synced("g1", A) })).toEqual({ kind: "up-to-date" });
  });

  it("pushes when only local moved", () => {
    expect(decideSync({ local: B, remote: A, state: synced("g1", A) })).toEqual({ kind: "push" });
  });

  it("pulls when only the remote moved", () => {
    expect(decideSync({ local: A, remote: B, state: synced("g1", A) })).toEqual({ kind: "pull" });
  });

  /** THE verdict the whole function exists for. Resolving this by picking a side silently deletes work,
   *  and WHICH side depends on which machine synced last — the least predictable failure available. */
  it("stops when BOTH sides moved", () => {
    expect(decideSync({ local: B, remote: C, state: synced("g1", A) }))
      .toEqual({ kind: "diverged", local: B, remote: C, base: A });
  });

  /** Distinct from `diverged`: the cause is a MISSING ancestor, not two real edits. Local-wins would be a
   *  guess here — the local copy may be the empty seed of a machine that has never synced, in which case
   *  "local wins" publishes emptiness over the real library. */
  it("stops when the sides differ and there is no shared starting point", () => {
    expect(decideSync({ local: A, remote: B, state: synced("g1", undefined) }))
      .toEqual({ kind: "unrelated", local: A, remote: B });
  });

  it("treats a missing remote as create even once a gist id is known (unreadable/deleted)", () => {
    expect(decideSync({ local: A, remote: null, state: synced("g1", A) })).toEqual({ kind: "create" });
  });
});

describe("isAutomatic", () => {
  it("permits exactly the four resolvable actions", () => {
    for (const a of [{ kind: "up-to-date" }, { kind: "create" }, { kind: "push" }, { kind: "pull" }] as const) {
      expect(isAutomatic(a)).toBe(true);
    }
  });

  it("refuses both STOP verdicts — the caller must not have to remember which they are", () => {
    expect(isAutomatic({ kind: "diverged", local: A, remote: B, base: C })).toBe(false);
    expect(isAutomatic({ kind: "unrelated", local: A, remote: B })).toBe(false);
  });
});

describe("explainSync", () => {
  it("names which side moved — 'out of sync' without a direction is not actionable", () => {
    expect(explainSync({ kind: "push" }, "algorithms")).toContain("local has changes");
    expect(explainSync({ kind: "pull" }, "algorithms")).toContain("the gist has changes");
  });

  it("says plainly that nothing was overwritten on both STOP verdicts", () => {
    expect(explainSync({ kind: "diverged", local: A, remote: B, base: C }, "components"))
      .toContain("Nothing was overwritten");
    expect(explainSync({ kind: "unrelated", local: A, remote: B }, "components"))
      .toContain("Nothing was overwritten");
  });
});

describe("canonicalDocument", () => {
  /** Without this, two machines holding IDENTICAL data produce different bytes and every sync reads as
   *  diverged on key order alone — the store would appear permanently in conflict with itself. */
  it("is key-order independent", () => {
    expect(canonicalDocument({ b: 1, a: 2 })).toBe(canonicalDocument({ a: 2, b: 1 }));
  });

  it("is order-SENSITIVE for arrays, which carry meaning", () => {
    expect(canonicalDocument([1, 2])).not.toBe(canonicalDocument([2, 1]));
  });

  it("normalizes nested objects too", () => {
    expect(canonicalDocument({ x: { q: 1, p: 2 } })).toBe(canonicalDocument({ x: { p: 2, q: 1 } }));
  });

  /** An absent optional field and an explicitly-undefined one are the same document — otherwise a record
   *  round-tripped through a projection hashes differently from the one that never had the key. */
  it("drops undefined properties rather than emitting them", () => {
    expect(canonicalDocument({ a: 1, b: undefined })).toBe(canonicalDocument({ a: 1 }));
  });
});

describe("sha256Hex", () => {
  /** Pinned against the published SHA-256 of the empty string and of "abc" — the same values
   *  `bsc-cli-util::vendored::sha256_hex` produces, which is what lets the app and the CLI (slice 3)
   *  compare content at all. A drift here would make every cross-surface comparison read as diverged. */
  it("matches the published SHA-256 vectors", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is stable and content-sensitive", async () => {
    expect(await sha256Hex("x")).toBe(await sha256Hex("x"));
    expect(await sha256Hex("x")).not.toBe(await sha256Hex("y"));
  });
});
