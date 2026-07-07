// #2514 — EXECUTED round-trip + heal coverage for the hash-based seed refresh (#2483).
//
// The refresh's whole verdict system rests on one invariant: a stamped seed record pushed through the
// real write path (`bsc ui … set`, JSON verbatim per id) and reloaded through the real read path
// (`… list --full` + the bridge projections) must still hash to its stamp. #2514 shipped precisely
// because that invariant was asserted in prose but never EXECUTED — so these tests run the whole
// packaged seed (components, kits, AND themes) through a byte-faithful emulation of the store CLI
// (verbatim JSON per id; serde_json re-serialization = compact output, keys sorted — see
// `bsc_json_store::cli::run`'s `set`) and the REAL `componentBridge`/`themeBridge` load projections.
//
// Plus the heal itself, against the REAL broken store: `seedHeal2514.fixtures.json` is the verbatim
// content of the maintainer's 2026-07-07 live store (the pre-#2456 roster, stamped), which the live
// app kept forever. A hydrate over it must converge: retired built-ins deleted, current ones
// refreshed, tech/style/pages materialized, zero orphan notices.
import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = vi.hoisted(() => {
  /** A byte-faithful in-memory `bsc ui` store: verbatim JSON per id, serde-like re-serialization
   *  (compact, keys sorted — serde_json's Value map is a BTreeMap) on `set`, arrays of parsed
   *  records on `list --full`. Mirrors `bsc_json_store` + the `bsc ui` verb routing. */
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
    }
    return v;
  };
  const collections: Record<string, Map<string, string>> = {};
  let writes = 0;
  let removes = 0;
  const collectionOf = (args: string[]): { name: string; rest: string[] } => {
    // `ui kit …` → kits, `ui theme …` → themes, `ui usage …` → usage, plain `ui …` → components.
    const sub = args[1];
    if (sub === "kit" || sub === "theme" || sub === "usage") return { name: sub, rest: args.slice(2) };
    return { name: "component", rest: args.slice(1) };
  };
  const store = (name: string) => (collections[name] ??= new Map());
  return {
    reset() {
      for (const k of Object.keys(collections)) delete collections[k];
      writes = 0;
      removes = 0;
    },
    counts: () => ({ writes, removes }),
    has: (name: string, id: string) => store(name).has(id),
    async exec(_key: string | null, args: string[]): Promise<string> {
      const { name, rest } = collectionOf(args);
      if (rest[0] === "list") return JSON.stringify([...store(name).values()].map((s) => JSON.parse(s)));
      throw new Error(`fake bsc: unhandled read ${args.join(" ")}`);
    },
    async run(_key: string | null, args: string[]): Promise<void> {
      const { name, rest } = collectionOf(args);
      if (rest[0] === "remove" && rest[1]) {
        store(name).delete(rest[1]);
        removes++;
        return;
      }
      throw new Error(`fake bsc: unhandled run ${args.join(" ")}`);
    },
    async write(_key: string | null, args: string[], body: unknown): Promise<void> {
      const { name, rest } = collectionOf(args);
      if (rest[0] !== "set") throw new Error(`fake bsc: unhandled write ${args.join(" ")}`);
      // The REAL path: bscWrite JSON.stringify's the body to stdin; the CLI serde-parses it and
      // stores serde_json::to_string(item) — compact, keys sorted. Emulate byte-faithfully.
      const item = JSON.parse(JSON.stringify(body)) as { id: string };
      store(name).set(item.id, JSON.stringify(sortDeep(item)));
      writes++;
    },
  };
});

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(fake.exec),
  bscRun: vi.fn(fake.run),
  bscWrite: vi.fn(fake.write),
  // Other slices touched by the app-store import (e.g. persist rehydrate) degrade to their fallback.
  bscJson: vi.fn(async (_key: string | null, _args: string[], fallback: unknown) => fallback),
}));

import { useAppStore } from "@/store";
import type { ComponentRecord, Kit } from "./model";
import { SEED_COMPONENTS, SEED_KITS, reconcileComponents } from "./seed";
import { SEED_THEMES } from "./themes";
import { SEED_HASH_EXCLUDED, stableStringify, seedHashOf, type SeedRecord } from "./seedRefresh";
import { loadComponents, loadKits, pushComponent, pushKit } from "./componentBridge";
import { loadThemes, pushTheme } from "./themeBridge";
import { setActiveKitThemes } from "@/shared/ui/kit";
import broken from "./seedHeal2514.fixtures.json";

/** The seed-relevant content of a record as its canonical text — what the hash runs over. */
function contentText(rec: SeedRecord): string {
  const rest: Record<string, unknown> = { ...rec };
  for (const k of SEED_HASH_EXCLUDED) delete rest[k];
  return stableStringify(rest);
}

beforeEach(() => {
  fake.reset();
  useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS, kitThemes: SEED_THEMES, seedNotices: [] });
  setActiveKitThemes([]);
});

describe("the round-trip invariant (#2514): every packaged stamp survives push → store → load", () => {
  it("every SEED component reloads through the real bridge with its content + stamp intact", async () => {
    for (const c of SEED_COMPONENTS) await pushComponent(c);
    const loaded = await loadComponents();
    expect(loaded).toHaveLength(SEED_COMPONENTS.length);
    for (const original of SEED_COMPONENTS) {
      const reloaded = loaded!.find((c) => c.id === original.id)!;
      // Content first (a failure here shows the exact byte-level divergence), then the verdict input.
      expect(contentText(reloaded)).toBe(contentText(original));
      expect(seedHashOf(reloaded)).toBe(original.seedHash);
      expect(reloaded.seedHash).toBe(original.seedHash); // the stamp itself rides the projection
    }
  });

  it("every SEED kit reloads with its content + stamp intact (tech/style ride verbatim)", async () => {
    for (const k of SEED_KITS) await pushKit(k);
    const loaded = await loadKits();
    expect(loaded).toHaveLength(SEED_KITS.length);
    for (const original of SEED_KITS) {
      const reloaded = loaded!.find((k) => k.id === original.id)!;
      expect(contentText(reloaded)).toBe(contentText(original));
      expect(seedHashOf(reloaded)).toBe(original.seedHash);
    }
  });

  it("every SEED theme reloads with its content + stamp intact", async () => {
    for (const t of SEED_THEMES) await pushTheme(t);
    const loaded = await loadThemes();
    expect(loaded).toHaveLength(SEED_THEMES.length);
    for (const original of SEED_THEMES) {
      const reloaded = loaded!.find((t) => t.id === original.id)!;
      expect(contentText(reloaded)).toBe(contentText(original));
      expect(seedHashOf(reloaded)).toBe(original.seedHash);
    }
  });
});

describe("hydrate is a fixpoint across restarts (#2514)", () => {
  it("boot 1 seeds the empty store; boot 2 re-loads it and changes NOTHING", async () => {
    await useAppStore.getState().hydrateComponents(); // boot 1: empty store → seed everything
    const afterBoot1 = fake.counts();
    expect(afterBoot1.writes).toBe(SEED_COMPONENTS.length + SEED_KITS.length);
    expect(afterBoot1.removes).toBe(0);

    await useAppStore.getState().hydrateComponents(); // boot 2: the round-tripped store re-loads
    expect(fake.counts()).toEqual(afterBoot1); // NO new pushes, NO drops — converged
    expect(useAppStore.getState().seedNotices).toEqual([]);
    expect(useAppStore.getState().components).toEqual(SEED_COMPONENTS);
    expect(useAppStore.getState().kits).toEqual(SEED_KITS);
  });

  it("theme hydrate is the same fixpoint", async () => {
    await useAppStore.getState().hydrateThemes();
    const afterBoot1 = fake.counts();
    expect(afterBoot1.writes).toBe(SEED_THEMES.length);

    await useAppStore.getState().hydrateThemes();
    expect(fake.counts()).toEqual(afterBoot1);
    expect(useAppStore.getState().seedNotices).toEqual([]);
    expect(useAppStore.getState().kitThemes).toEqual(SEED_THEMES);
  });
});

describe("the #2514 heal — the maintainer's REAL broken store converges on one hydrate", () => {
  const brokenComponents = broken.components as unknown as ComponentRecord[];
  const brokenKits = broken.kits as unknown as Kit[];
  /** The 2026-07-07 store's records that the CURRENT seed no longer carries (the retired set). */
  const retiredIds = brokenComponents.map((c) => c.id).filter((id) => !SEED_COMPONENTS.some((s) => s.id === id));

  it("the fixture IS the reported broken state: pre-#2456 roster, examples kit, stamps present", () => {
    expect(brokenComponents).toHaveLength(48);
    expect(brokenKits.map((k) => k.id).sort()).toEqual(["examples", "react-ui"]);
    expect(retiredIds).toContain("personaservice");
    expect(brokenComponents.every((c) => c.builtin && c.seedHash)).toBe(true);
    // The issue's forensic mismatch was an artifact (it hashed UTF-8 bytes; the app hashes UTF-16
    // code units): under the app's own hasher every stored record matches its stamp — pristine.
    for (const c of brokenComponents) expect(seedHashOf(c)).toBe(c.seedHash);
    for (const k of brokenKits) expect(seedHashOf(k)).toBe(k.seedHash);
  });

  it("hydrating over the broken store deletes the retirees, refreshes the rest, and materializes tech/style/pages", async () => {
    for (const c of brokenComponents) await fake.write(null, ["ui", "set"], c);
    for (const k of brokenKits) await fake.write(null, ["ui", "kit", "set"], k);

    await useAppStore.getState().hydrateComponents();
    const s = useAppStore.getState();
    // Retired built-ins deleted — the examples kit and its services are NOT immortal.
    expect(s.kits.map((k) => k.id)).toEqual(["react-ui"]);
    expect(s.components.some((c) => c.kitId === "examples")).toBe(false);
    for (const id of retiredIds) expect(fake.has("component", id)).toBe(false);
    expect(fake.has("kit", "examples")).toBe(false);
    // Current built-ins refreshed / appended: the collection converges to EXACTLY the packaged seed
    // (loaded-order-first, so compare as id-sorted sets).
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...s.components].sort(byId)).toEqual([...SEED_COMPONENTS].sort(byId));
    // The #2487 axes and the #2505 pages tier materialize.
    expect(s.kits[0].tech).toBeDefined();
    expect(s.kits[0].style).toBeDefined();
    expect(s.components.some((c) => c.role === "page")).toBe(true);
    // All 48 stale records were pristine → the heal is silent (no orphan/upstream notices).
    expect(s.seedNotices).toEqual([]);
  });

  it("a rotten STAMP on an in-seed record heals via the tolerant re-stamp (#2514 branch 1)", () => {
    // Dynamically pick a fixture record whose content still equals the CURRENT seed's (avatar at the
    // time of writing) so the test tracks seed evolution instead of hardcoding an id.
    const seedById = new Map(SEED_COMPONENTS.map((s) => [s.id, s]));
    const pristine = brokenComponents.find((c) => seedById.get(c.id) && seedHashOf(c) === seedById.get(c.id)!.seedHash);
    expect(pristine, "no fixture record matches the current seed content anymore — pick a new one").toBeDefined();
    // The rot the issue observed: a stamp the content no longer (appears to) match.
    const rotten = { ...pristine!, seedHash: "f675d19a" };
    const r = reconcileComponents([rotten]);
    const healed = r.records.find((c) => c.id === rotten.id)!;
    expect(healed).toEqual(seedById.get(rotten.id)); // same content, corrected stamp
    expect(r.pushes).toContainEqual(healed); // pushed so the store converges
    expect(r.notices).toEqual([]); // nothing diverged — silent heal
  });

  it("a rotten stamp on a RETIRED record is kept but NEVER silently (#2514 branch 2)", () => {
    const personaservice = brokenComponents.find((c) => c.id === "personaservice")!;
    const rotten = { ...personaservice, seedHash: "cd4bc4c3" }; // the issue's observed forensic value
    const r = reconcileComponents([rotten]);
    // No seed copy to verify against → conservative KEEP, surfaced as an orphan notice.
    expect(r.records).toContainEqual(rotten);
    expect(r.drops).not.toContain("personaservice");
    expect(r.notices).toContainEqual({ kind: "orphaned", type: "component", id: "personaservice", name: "PersonaService" });
  });
});
