// THE FRONTEND'S DEPENDENCY CHAIN SPANS TWO RECORD STORES, and until `componentDeps` existed the graph
// held only half of it (`the-relationship-derivation-spans-both-record-stores`).
//
// Measured on develop before this landed: 1,572 `@/` imports across 753 TS records — 1,207 resolving to
// an algorithm record, 165 to a COMPONENT record in `graph/components.db`, 200 to nothing. The 165 were
// real relationships, present in the code, absent from the graph, and the derivation reported `0 missing`
// while they were invisible: it could only ever ask about one store. A changed-list built on that would
// silently miss "this component record changed, so these algorithm records' tests are affected", which is
// the common case for UI work and this repo's signature failure shape.
//
// These tests pin the four things that make the widened derivation trustworthy rather than merely bigger:
// the cross-store pair end to end, the PRECEDENCE rule, the module floor staying unresolved, and the
// exactness of the new relation.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { derive, componentDepsOf, componentGaps } from "./graph-relationships.mjs";
import { loadStore, resolveStorePath, resolveComponentStorePath } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");
const recs = loadStore(resolveStorePath(REPO)).implementations as any[];
const byId = new Map(recs.map((r) => [r.id, r]));

const componentStore = resolveComponentStorePath(REPO);
const comps = componentStore ? (loadStore(componentStore).implementations as any[]) : [];
const componentIds = new Set(comps.map((c) => c.id));
/** specifier → the ONE component record answering it. */
const cprov = new Map<string, string>();
for (const c of comps) if (c.provides) cprov.set(c.provides, c.id);

describe("the relationship derivation spans both record stores", () => {
  it("has both stores to read — the two populations still resolve", () => {
    // NON-VACUITY. Every assertion below is satisfied by an empty component store, which is exactly the
    // state this test exists to rule out: `new DatabaseSync` MINTS an empty database at a path that does
    // not exist, so a mis-resolved store reads as "no components" rather than as an error.
    expect(componentStore, "graph/store.toml must name a component store that exists").toBeTruthy();
    expect(comps.length, "component records").toBeGreaterThan(200);
    expect(recs.length, "algorithm records").toBeGreaterThan(1000);
  });

  // THE PROOF CASE, end to end: a component record and the algorithm record that imports it.
  it("derives the cross-store edge that `composes` cannot hold", () => {
    const r = byId.get("worker-detail-modal.ts");
    expect(r, "the proof case record must still be in the store").toBeTruthy();

    // Six `@/shared/ui/*` imports, every one a component record — and `composes` carried NONE of them.
    const deps = componentDepsOf(r);
    expect(deps).toEqual(["ui-box", "ui-icon-button", "ui-modal-scrim", "ui-row", "ui-spacer", "ui-text"]);

    // Each derived id is a REAL record in the OTHER store. Resolving to a plausible-looking string that
    // names nothing would satisfy a shape check and still be a broken edge.
    for (const id of deps) expect(componentIds.has(id), `${id} must be a component record`).toBe(true);

    // ...and they are still absent from `composes`, which is correct rather than a gap:
    // `repo_store::prune_dangling_composes` DELETES a component id written there.
    expect((r.composes ?? []).filter((c: string) => componentIds.has(c))).toEqual([]);
  });

  // PRECEDENCE, settled by `resolver-reads-the-algorithms-store`: a UI record overriding a shared/ui
  // primitive is the established meaning of `provides`, so an algorithm claiming the same specifier would
  // silently shadow a rendering component. Driven through a probe record rather than hunting for a real
  // importer, so the case is exercised deterministically instead of vacuously.
  it("COMPONENTS WIN a contested specifier", () => {
    const aprov = new Map<string, string>();
    for (const r of recs) if (r.provides) aprov.set(r.provides, r.id);
    const contested = [...cprov.keys()].filter((s) => aprov.has(s));
    expect(contested.length, "a contested specifier must exist or this asserts nothing").toBeGreaterThan(0);

    for (const spec of contested) {
      const probe = { id: "__probe__", tech: "typescript", code: `import { X } from "${spec}";` };
      expect(componentDepsOf(probe), `${spec} resolves to its COMPONENT record`).toEqual([cprov.get(spec)]);
      expect([...derive(probe)], `${spec} must NOT also become a composes edge`).toEqual([]);
    }
  });

  // THE MODULE FLOOR. 194 of the 200 unresolved specifiers point at a real FILE on disk; counting those
  // as missing edges would make the whole signal useless, so they must resolve to NEITHER relation.
  it("an import that points at a FILE on disk stays unresolved in both relations", () => {
    for (const [spec, file] of [
      ["@/store", "src/store/index.ts"],
      ["@/shared/lib/core/log", "src/shared/lib/core/log.ts"],
    ] as const) {
      expect(existsSync(join(REPO, file)), `${file} is the module floor this case rests on`).toBe(true);
      const probe = { id: "__probe__", tech: "typescript", code: `import { X } from "${spec}";` };
      expect(componentDepsOf(probe), `${spec} is a file, not a component record`).toEqual([]);
      expect([...derive(probe)], `${spec} is a file, not an algorithm record`).toEqual([]);
    }
  });

  // EXACT, like `crateDeps` and unlike `composes`: a component dep is read straight off the code, so a
  // disagreement is always drift. This is the gate leg's own question, asked here too.
  it("every cross-store edge the code holds is recorded, with no accepted gaps", () => {
    const carried = recs.filter((r) => (r.componentDeps ?? []).length);
    expect(carried.length, "records carrying componentDeps").toBeGreaterThan(30);
    expect(Object.keys(componentGaps()), "records whose componentDeps disagree with their code").toEqual([]);
  });
});
