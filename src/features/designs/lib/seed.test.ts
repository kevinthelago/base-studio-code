// The packaged seed + its hash-based reconcile (#2483), against the REAL packaged kits — the
// acceptance-criteria regressions for the built-in-rot incidents (stale react-ui copies, the
// retired spring-kotlin/tauri-rust kits, the masked #2475 shapes stamps).
import { describe, it, expect } from "vitest";
import type { Kit } from "./model";
import { SEED_COMPONENTS, SEED_KITS, reconcileComponents, reconcileKits, DEFAULT_KIT_SEEDED } from "./seed";
import { seedHashOf, stampSeedHash } from "./seedRefresh";

describe("packaged seed stamping (#2483)", () => {
  it("every packaged built-in (kit + component) carries a self-consistent seedHash", () => {
    for (const k of SEED_KITS) {
      expect(k.builtin).toBe(true);
      expect(k.seedHash).toBe(seedHashOf(k));
    }
    for (const c of SEED_COMPONENTS) {
      expect(c.builtin).toBe(true);
      expect(c.seedHash).toBe(seedHashOf(c));
    }
  });
});

// TEMPORARY (#3029): the default kit is disabled, so the reconcile converges against an EMPTY seed —
// these real-seed acceptance tests are dormant until DEFAULT_KIT_SEEDED flips back on (they auto-restore).
describe.skipIf(!DEFAULT_KIT_SEEDED)("reconcile against the real seed (#2483 acceptance criteria)", () => {
  it("a seed change to an untouched built-in reaches an existing store (the #2475 shapes-mask regression)", () => {
    // Yesterday's release: the same component WITHOUT the later-added `shapes` stamp — pristine
    // (self-consistently hashed), but stale.
    const current = SEED_COMPONENTS.find((c) => c.shapes?.length)!;
    const rest = { ...current };
    delete rest.shapes;
    delete rest.seedHash;
    const stale = stampSeedHash(rest);
    const r = reconcileComponents([stale]);
    const reconciled = r.records.find((c) => c.id === current.id)!;
    expect(reconciled.shapes).toEqual(current.shapes); // the new seed copy won
    expect(r.pushes).toContainEqual(current); // and converges the store
    expect(r.notices).toEqual([]);
  });

  it("a user-edited built-in is never clobbered; the update surfaces as a notice", () => {
    const current = SEED_COMPONENTS[0];
    // The user edited an OLDER copy (its recorded baseline is not the current seed's hash).
    const edited = { ...current, srcText: "// my custom source", seedHash: "00000000" };
    const r = reconcileComponents([edited]);
    expect(r.records.find((c) => c.id === current.id)).toEqual(edited);
    expect(r.pushes.some((c) => c.id === current.id)).toBe(false);
    expect(r.notices).toContainEqual({ kind: "updated-upstream", type: "component", id: current.id, name: current.name });
  });

  it("a built-in kit removed from the seed disappears from an untouched store (spring-kotlin/tauri-rust)", () => {
    const springKotlin = stampSeedHash({ id: "spring-kotlin", name: "Spring Kotlin", stack: "Spring · Kotlin", dot: "green", builtin: true } as Kit);
    const r = reconcileKits([...SEED_KITS, springKotlin]);
    expect(r.records.map((k) => k.id)).toEqual(SEED_KITS.map((k) => k.id));
    expect(r.drops).toEqual(["spring-kotlin"]);
  });

  it("a pre-#2487 stored kit (no tech/style) auto-refreshes when the seed gains the hierarchy axes", () => {
    // Yesterday's release: the same packaged kit WITHOUT the later-added tech/style fields —
    // pristine (self-consistently hashed, absent fields drop out of the hash), but stale.
    for (const current of SEED_KITS) {
      expect(current.tech).toBeTruthy(); // sanity: the packaged seed now carries the axes
      expect(current.style).toBeTruthy();
      const rest = { ...current };
      delete rest.tech;
      delete rest.style;
      delete rest.seedHash;
      const stale = stampSeedHash(rest);
      const r = reconcileKits([stale]);
      const reconciled = r.records.find((k) => k.id === current.id)!;
      expect(reconciled.tech).toBe(current.tech); // the new seed copy won
      expect(reconciled.style).toBe(current.style);
      expect(r.pushes).toContainEqual(current); // and converges the store
      expect(r.notices).toEqual([]); // a refresh, not a kept-divergence
    }
  });

  it("legacy no-hash records refresh once without user action (every pre-#2483 install)", () => {
    // A pre-#2483 store: pristine copies pushed WITHOUT seedHash.
    const legacyKits: Kit[] = SEED_KITS.map((k) => ({ ...k, seedHash: undefined }));
    const r = reconcileKits(legacyKits);
    expect(r.records).toEqual(SEED_KITS); // refreshed to the stamped copies
    expect(r.pushes).toEqual(SEED_KITS); // and re-pushed so the store is stamped from now on
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
    // ...and the refresh is one-time: a second hydrate of the now-stamped store is a no-op.
    const again = reconcileKits(SEED_KITS);
    expect(again.pushes).toEqual([]);
    expect(again.records).toEqual(SEED_KITS);
  });
});
