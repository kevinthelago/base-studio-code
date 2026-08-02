// Hash-based built-in seed refresh (#2483) — the pure decision spine. Covers the full verdict table
// (refresh / keep+notice / delete / orphan / legacy grandfather / user-authored pass-through), hash
// stability + exclusions, and the kit-shaped variants of the same verdicts.
import { describe, it, expect } from "vitest";
import type { ComponentRecord, Kit } from "./model";
import { fnv1a, stableStringify, seedHashOf, stampSeedHash, reconcileSeed } from "./seedRefresh";

/** A minimal component-shaped record. */
const comp = (over: Partial<ComponentRecord> = {}): ComponentRecord => ({
  id: "button", name: "Button", kitId: "react-ui", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "", srcText: "", builtin: true,
  ...over,
});

const kit = (over: Partial<Kit> = {}): Kit => ({
  id: "react-ui", name: "React UI", stack: "React · TypeScript", dot: "var(--accent)", builtin: true,
  ...over,
});

describe("seed hash (#2483)", () => {
  it("is stable: the same record always hashes the same", () => {
    expect(seedHashOf(comp())).toBe(seedHashOf(comp()));
  });

  it("changes when any seed-relevant field changes", () => {
    expect(seedHashOf(comp({ version: "2.0.0" }))).not.toBe(seedHashOf(comp()));
    expect(seedHashOf(comp({ srcText: "x" }))).not.toBe(seedHashOf(comp()));
    expect(seedHashOf(comp({ variants: ["default", "ghost"] }))).not.toBe(seedHashOf(comp()));
  });

  it("excludes seedHash itself, builtin, and the volatile `used` counter", () => {
    const base = seedHashOf(comp());
    expect(seedHashOf(comp({ seedHash: "deadbeef" }))).toBe(base);
    expect(seedHashOf(comp({ builtin: undefined }))).toBe(base);
    expect(seedHashOf(comp({ used: 42 }))).toBe(base);
  });

  it("is key-order independent and treats explicit undefined as absent", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
    expect(stableStringify({ a: 1, wraps: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("fnv1a is deterministic 8-hex-digit output", () => {
    expect(fnv1a("")).toBe("811c9dc5"); // the FNV-1a 32-bit offset basis
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
  });

  it("stampSeedHash stamps a hash the stamped record's own content still matches", () => {
    const stamped = stampSeedHash(comp());
    expect(stamped.seedHash).toBeDefined();
    expect(seedHashOf(stamped)).toBe(stamped.seedHash); // seedHash is excluded from its own hash
  });
});

describe("reconcileSeed verdicts (#2483)", () => {
  // The current packaged seed: one built-in, stamped.
  const seedNew = stampSeedHash(comp({ version: "2.0.0" }));
  // Yesterday's packaged copy of the same built-in — pristine (self-consistent hash), but stale.
  const storePristineOld = stampSeedHash(comp({ version: "1.0.0" }));

  it("refreshes an unmodified stale built-in to the new seed copy (and pushes it)", () => {
    const r = reconcileSeed([storePristineOld], [seedNew], "component");
    expect(r.records).toEqual([seedNew]);
    expect(r.pushes).toEqual([seedNew]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("keeps an unmodified current built-in with no ops (idempotent hydrate)", () => {
    const current = { ...seedNew, used: 7 }; // volatile drift only — still pristine
    const r = reconcileSeed([current], [seedNew], "component");
    expect(r.records).toEqual([current]); // store copy kept (its `used` survives)
    expect(r.pushes).toEqual([]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("keeps a user-modified built-in and notices the upstream update (never clobbers)", () => {
    // The user edited yesterday's copy: content moved off its recorded baseline.
    const edited = { ...storePristineOld, srcText: "my tweak" };
    const r = reconcileSeed([edited], [seedNew], "component");
    expect(r.records).toEqual([edited]);
    expect(r.pushes).toEqual([]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([{ kind: "updated-upstream", type: "component", id: "button", name: "Button" }]);
  });

  it("keeps a user-modified built-in silently when the seed did NOT move", () => {
    const edited = { ...seedNew, srcText: "my tweak" }; // baseline = the CURRENT seed
    const r = reconcileSeed([edited], [seedNew], "component");
    expect(r.records).toEqual([edited]);
    expect(r.notices).toEqual([]);
  });

  it("deletes an unmodified built-in that left the seed", () => {
    const retired = stampSeedHash(comp({ id: "spring-row", name: "SpringRow", kitId: "spring-kotlin" }));
    const r = reconcileSeed([retired], [seedNew], "component");
    expect(r.records).toEqual([seedNew]); // retired gone, missing seed appended
    expect(r.drops).toEqual(["spring-row"]);
    expect(r.pushes).toEqual([seedNew]);
    expect(r.notices).toEqual([]);
  });

  it("keeps a modified built-in that left the seed, marked orphaned", () => {
    const retired = stampSeedHash(comp({ id: "spring-row", name: "SpringRow" }));
    const editedRetired = { ...retired, srcText: "mine now" };
    const r = reconcileSeed([editedRetired, seedNew], [seedNew], "component");
    expect(r.records).toEqual([editedRetired, seedNew]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([{ kind: "orphaned", type: "component", id: "spring-row", name: "SpringRow" }]);
  });

  it("grandfathers a legacy no-seedHash built-in as unmodified: refreshed when in the seed", () => {
    const legacy = comp({ version: "1.0.0" }); // pre-#2483: builtin, no seedHash
    expect(legacy.seedHash).toBeUndefined();
    const r = reconcileSeed([legacy], [seedNew], "component");
    expect(r.records).toEqual([seedNew]);
    expect(r.pushes).toEqual([seedNew]); // the one-time heal stamps the store copy
  });

  it("grandfathers a legacy no-seedHash built-in absent from the seed: deleted", () => {
    const legacy = comp({ id: "tauri-rust-row", name: "TauriRow" }); // the spring-kotlin/tauri-rust incident
    const r = reconcileSeed([legacy, seedNew], [seedNew], "component");
    expect(r.records).toEqual([seedNew]);
    expect(r.drops).toEqual(["tauri-rust-row"]);
  });

  it("re-stamps a wrong-stamped copy whose content EQUALS the current seed (#2514 tolerant heal)", () => {
    // The #2514 failure class: content is byte-identical to the seed but the recorded stamp is rot
    // (an older hasher / a byte-mangling round-trip stamped it). Without the tolerant path this is
    // judged user-modified and kept — with the WRONG stamp — forever.
    const wrongStamp = { ...seedNew, seedHash: "deadbeef" };
    const r = reconcileSeed([wrongStamp], [seedNew], "component");
    expect(r.records).toEqual([seedNew]); // same content, corrected stamp
    expect(r.pushes).toEqual([seedNew]); // pushed so the store converges on the good stamp
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]); // nothing diverged — no notice
  });

  it("keeps a wrong-stamped copy whose content matches NEITHER its stamp NOR the seed — with a notice, never silently (#2514)", () => {
    // Indistinguishable from a genuine user edit (could equally be an old seed's content under a
    // broken stamp) — conservative KEEP, surfaced via the updated-upstream notice.
    const divergent = { ...seedNew, srcText: "my tweak", seedHash: "deadbeef" };
    const r = reconcileSeed([divergent], [seedNew], "component");
    expect(r.records).toEqual([divergent]);
    expect(r.pushes).toEqual([]);
    expect(r.notices).toEqual([{ kind: "updated-upstream", type: "component", id: "button", name: "Button" }]);
  });

  it("keeps a wrong-stamped RETIRED copy on the orphan branch (no seed to verify against, #2514)", () => {
    const retired = { ...stampSeedHash(comp({ id: "spring-row", name: "SpringRow" })), seedHash: "deadbeef" };
    const r = reconcileSeed([retired, seedNew], [seedNew], "component");
    expect(r.records).toEqual([retired, seedNew]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([{ kind: "orphaned", type: "component", id: "spring-row", name: "SpringRow" }]);
  });

  it("never touches user-authored records, even when stale-looking or absent from the seed", () => {
    const mine = comp({ id: "my-widget", name: "MyWidget", builtin: undefined });
    const mineWithStrayHash = comp({ id: "my-other", name: "MyOther", builtin: false, seedHash: "deadbeef" });
    const r = reconcileSeed([mine, mineWithStrayHash, seedNew], [seedNew], "component");
    expect(r.records).toEqual([mine, mineWithStrayHash, seedNew]);
    expect(r.pushes).toEqual([]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("appends + pushes built-ins the store lacks (the original seed-and-keep add)", () => {
    const r = reconcileSeed([], [seedNew], "component");
    expect(r.records).toEqual([seedNew]);
    expect(r.pushes).toEqual([seedNew]);
  });
});

describe("reconcileSeed — seedAuthoritative records (#3723): the seed always wins", () => {
  // A page-spec record. The seed is AUTHORITATIVE for it (an import-based page the app renders through
  // the registry at runtime, NOT designer-editable), which `reconcileComponents` keys on `role: "page"`.
  const seedPage = stampSeedHash(comp({ id: "settingspage", name: "SettingsPage", role: "page" }));
  const authoritative = (r: ComponentRecord) => r.role === "page";

  it("FORCES a diverged page copy back to the seed, with a reset-to-seed notice (the #3658/#3723 bug)", () => {
    // A designer self-contained the page (content no longer matches the seed) — a bug, not a user edit.
    const selfContained = { ...seedPage, srcText: "// vendored self-contained for preview" };
    const r = reconcileSeed([selfContained], [seedPage], "component", { seedAuthoritative: authoritative });
    expect(r.records).toEqual([seedPage]); // the clean seed copy wins
    expect(r.pushes).toEqual([seedPage]);  // and is written back to the store
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([{ kind: "reset-to-seed", type: "component", id: "settingspage", name: "SettingsPage" }]);
  });

  it("leaves a page copy that already matches the seed untouched (no push, no notice)", () => {
    const current = { ...seedPage, used: 3 }; // volatile drift only — content still matches the seed
    const r = reconcileSeed([current], [seedPage], "component", { seedAuthoritative: authoritative });
    expect(r.records).toEqual([current]);
    expect(r.pushes).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("does NOT force records the predicate excludes — a normal edited component is still KEPT (store wins)", () => {
    const seedNew = stampSeedHash(comp({ version: "2.0.0" }));
    const edited = { ...stampSeedHash(comp({ version: "1.0.0" })), srcText: "my tweak" }; // role: primitive
    const r = reconcileSeed([edited], [seedNew], "component", { seedAuthoritative: authoritative });
    expect(r.records).toEqual([edited]); // predicate returns false for a non-page → normal verdict table
    expect(r.pushes).toEqual([]);
    expect(r.notices).toEqual([{ kind: "updated-upstream", type: "component", id: "button", name: "Button" }]);
  });
});

describe("reconcileSeed on kit records (#2483) — the kit store rots the same way", () => {
  const seedKit = stampSeedHash(kit({ stack: "React 19 · TypeScript" }));
  const oldKit = stampSeedHash(kit({ stack: "React · TypeScript" }));

  it("refreshes an unmodified stale kit", () => {
    const r = reconcileSeed([oldKit], [seedKit], "kit");
    expect(r.records).toEqual([seedKit]);
    expect(r.pushes).toEqual([seedKit]);
  });

  it("keeps a user-renamed kit with an updated-upstream notice", () => {
    const renamed = { ...oldKit, name: "My UI" };
    const r = reconcileSeed([renamed], [seedKit], "kit");
    expect(r.records).toEqual([renamed]);
    expect(r.notices).toEqual([{ kind: "updated-upstream", type: "kit", id: "react-ui", name: "My UI" }]);
  });

  it("deletes a pristine kit that left the seed (spring-kotlin regression)", () => {
    const springKotlin = stampSeedHash(kit({ id: "spring-kotlin", name: "Spring Kotlin" }));
    const r = reconcileSeed([springKotlin, seedKit], [seedKit], "kit");
    expect(r.records).toEqual([seedKit]);
    expect(r.drops).toEqual(["spring-kotlin"]);
  });

  it("keeps a customized kit that left the seed, marked orphaned", () => {
    const springKotlin = { ...stampSeedHash(kit({ id: "spring-kotlin", name: "Spring Kotlin" })), dot: "red" };
    const r = reconcileSeed([springKotlin], [seedKit], "kit");
    expect(r.records).toEqual([springKotlin, seedKit]);
    expect(r.notices).toEqual([{ kind: "orphaned", type: "kit", id: "spring-kotlin", name: "Spring Kotlin" }]);
  });
});

describe("reconcileSeed — suppression tombstones (#3725)", () => {
  it("a tombstone blocks the builtin re-seed and is excluded from the library, but stays in the store", () => {
    const seedComp = stampSeedHash(comp({ id: "cost", name: "CostEnergyView" }));
    // The builtin was suppressed: the store holds ONLY the `{ id, suppressed }` tombstone.
    const r = reconcileSeed([{ ...comp({ id: "cost" }), suppressed: true }], [seedComp], "component");
    expect(r.records.some((x) => x.id === "cost")).toBe(false); // not rendered — it's a tombstone
    expect(r.pushes.some((x) => x.id === "cost")).toBe(false); // NOT re-seeded (the whole point of #13)
    expect(r.drops).not.toContain("cost"); // the tombstone stays, to keep blocking the re-seed
  });

  it("removing the tombstone (unsuppress) lets the seed re-add the builtin", () => {
    const seedComp = stampSeedHash(comp({ id: "cost", name: "CostEnergyView" }));
    // With the tombstone gone, the store lacks the builtin → the seed re-adds it (append + push).
    const r = reconcileSeed([], [seedComp], "component");
    expect(r.records).toEqual([seedComp]);
    expect(r.pushes).toEqual([seedComp]);
  });

  it("suppresses a kit the same way", () => {
    const seedK = stampSeedHash(kit({ id: "fleet", name: "Fleet" }));
    const r = reconcileSeed([{ ...kit({ id: "fleet" }), suppressed: true }], [seedK], "kit");
    expect(r.records.some((x) => x.id === "fleet")).toBe(false);
    expect(r.pushes.some((x) => x.id === "fleet")).toBe(false);
  });
});

// #4216 — the verdict for a record the reconcile has been skipping in silence.
describe("reconcileSeed — unstamped built-ins (#4216)", () => {
  const seedNew = stampSeedHash(comp({ version: "2.0.0" }));

  // #4216 — the state nothing was watching for. A store copy with NO `builtin` flag but a packaged seed
  // of that id is a built-in whose stamp was lost (a pre-#4197 partial `bsc ui set` dropped it). The
  // reconcile skipped it silently ever since, so it never refreshed — while the app rendered it, because
  // the unstamped branch pushes the store copy straight into `records`.
  it("reports an UNSTAMPED record that still has a packaged seed, without changing what renders", () => {
    // Same id as the seed, but no `builtin` — and deliberately different content, the real-world shape.
    const unstamped = { ...comp({ version: "1.0.0" }), builtin: undefined };
    const r = reconcileSeed([unstamped], [seedNew], "component");

    // The verdict is surfaced…
    expect(r.notices).toEqual([
      { kind: "unstamped", type: "component", id: unstamped.id, name: expect.any(String) },
    ]);
    // …and NOTHING is changed by it. The store copy still wins, nothing is pushed, nothing is dropped.
    // Deciding which side is right is a per-record judgement; a reconcile that silently replaced 44
    // pages at once would be the worse bug.
    expect(r.records).toEqual([unstamped]);
    expect(r.pushes).toEqual([]);
    expect(r.drops).toEqual([]);
  });

  it("stays silent for a genuinely user-authored record — one with no packaged seed", () => {
    // The discrimination that keeps the notice useful: ~168 store records legitimately have no seed
    // (designer-authored library components). Reporting those would bury the 44 that matter in noise.
    const mine = { ...comp({ id: "my-own-thing", version: "1.0.0" }), builtin: undefined };
    const r = reconcileSeed([mine], [seedNew], "component");
    expect(r.notices).toEqual([]);
    // It survives untouched. (`records` also gains `seedNew` — a packaged built-in the store lacks is
    // re-seeded, which is the pre-existing behaviour and not what this case is about.)
    expect(r.records).toContainEqual(mine);
  });
});
