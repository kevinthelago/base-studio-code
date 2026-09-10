// THE TWO RECORD STORES MUST AGREE, because only one of them compiles.
//
// `retire-the-packaged-seed-directories` flipped the emitter: the frontend tree is now materialized
// from the COMMITTED store (`graph/records/<id>.json`) and no longer from the packaged seed
// (`src-tauri/data/knowledge/algorithms.json`). Both still exist, and for the 700-odd records that
// live in both, an edit to the seed alone is now INERT — the app keeps serving the committed body.
//
// THAT IS NOT HYPOTHETICAL AND IT IS WHY THIS FILE EXISTS. Merging current develop into that branch
// produced exactly it: eleven records had been edited on develop while they were still seed-only, the
// branch had landed a snapshot of them taken at its own branch point, and the merge left ten committed
// bodies holding the OLD code while the seed held the new. The emitted tree lost six exports and
// `typecheck`, `vitest` and `nextest` all went red together.
//
// The full gate caught it, and that is worth stating rather than glossing: this class is exactly the
// one a SCOPED gate cannot see, because the changed files and the broken modules are in different
// places. This test makes the cause legible instead of leaving three red legs to be diagnosed.
//
// The direction is not symmetric. The committed store is the build authority — on a disagreement its
// body is what ships — so the fix for a failure here is almost always to carry the SEED's newer body
// into the committed record, then mirror it back so the two match. The exception is a record the
// retirement itself edited, where the committed copy is deliberately ahead and the seed should be
// mirrored from it.
//
// This guard is TRANSITIONAL by construction: it has nothing to compare once the packaged seed is
// deleted, and it should be removed with it rather than kept as a monument.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStore, resolveStorePath } from "../../../scripts/lib/recordStore.mjs";

const REPO = resolve(__dirname, "../../..");

interface Rec { id: string; code?: string; tests?: unknown }

function committed(): Map<string, Rec> {
  const store = loadStore(resolveStorePath(REPO)) as { implementations: Rec[] };
  return new Map(store.implementations.map((r) => [r.id, r]));
}

function packagedSeed(): Rec[] {
  const raw = readFileSync(resolve(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8");
  return (JSON.parse(raw) as { implementations: Rec[] }).implementations;
}

/** The EDGE tier, which carries its own tests — the cross-module ones that belong to no single node.
 *
 *  A first version of this file compared implementations only, and passed while three edge tests were
 *  stale in exactly the way it was written to catch. `glanceSessionNode.test.ts` stayed red and the
 *  guard stayed green, which is the worst possible combination. Both tiers are compared now, and the
 *  edge count is asserted for the same reason the record count is. */
function edges(which: "seed" | "committed"): Map<string, Rec> {
  // The seed is one JSON file; the COMMITTED store is whatever `graph/store.toml` names — a database
  // now — so it goes through the same loader the build uses rather than a hard-coded path. Reading
  // the old name here failed with ENOENT while the record half had already been migrated, which is
  // the shape of a guard that half-follows a migration.
  const doc = which === "seed"
    ? (JSON.parse(
        readFileSync(resolve(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8"),
      ) as { edges?: Rec[] })
    : (loadStore(resolveStorePath(REPO)) as { edges?: Rec[] });
  return new Map((doc.edges ?? []).map((e) => [e.id, e]));
}

describe("the packaged seed and the committed store agree", () => {
  it("finds both stores, non-empty", () => {
    // Guard the guard: either path failing to resolve would make the comparison below vacuous, and an
    // empty set matching an empty set is the failure mode a drift test can least afford.
    expect(committed().size, "no committed records — graph/ stopped resolving").toBeGreaterThan(1000);
    expect(packagedSeed().length, "no seed records — the seed path stopped resolving").toBeGreaterThan(100);
  });

  it("overlaps enough for the comparison to mean something", () => {
    // If the overlap ever collapses the test silently stops guarding anything, so the POPULATION is
    // asserted and not just the agreement. When the seed is deleted this is the assertion that fails
    // first, which is the signal to remove this file rather than widen it.
    const c = committed();
    const both = packagedSeed().filter((s) => c.has(s.id));
    expect(both.length, "the two stores no longer overlap — is the seed gone? retire this test").toBeGreaterThan(100);
  });

  it("gives every record in BOTH stores the same code and the same carried tests", () => {
    const c = committed();
    const drift: string[] = [];
    for (const s of packagedSeed()) {
      const r = c.get(s.id);
      if (!r) continue; // seed-only: nothing to disagree with, and the emitter falls back for it
      if ((s.code ?? "") !== (r.code ?? "")) {
        drift.push(`${s.id}.code — seed ${(s.code ?? "").length} chars, committed ${(r.code ?? "").length}`);
      }
      if (JSON.stringify(s.tests ?? []) !== JSON.stringify(r.tests ?? [])) {
        drift.push(`${s.id}.tests`);
      }
    }
    expect(
      drift,
      "a record that lives in both stores disagrees with itself. The COMMITTED body is what the app " +
        "compiles, so a seed-only edit here is INERT — carry it into graph/records/<id>.json and mirror " +
        "the seed back:\n  " + drift.join("\n  "),
    ).toEqual([]);
  });

  it("gives every EDGE in both stores the same carried tests", () => {
    // The tier the first version of this guard forgot. An edge test is emitted the same way a record's
    // is, so a stale committed copy runs the OLD assertions against the NEW code — which is how three
    // of them survived a sync that looked complete.
    const se = edges("seed");
    const ce = edges("committed");
    const both = [...se.keys()].filter((k) => ce.has(k));
    expect(both.length, "the two stores share no edges — is the seed gone? retire this test").toBeGreaterThan(50);
    const drift = both.filter(
      (k) => JSON.stringify(se.get(k)!.tests ?? []) !== JSON.stringify(ce.get(k)!.tests ?? []),
    );
    expect(drift, `edge tests disagree between the stores:\n  ${drift.join("\n  ")}`).toEqual([]);
  });
});
