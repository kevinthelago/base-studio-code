// `libraryCarryClosure` — which store-only records ride along into the seed so a promotion's
// `composes` graph closes.
//
// The rule it encodes is a SAFETY rule, not a convenience: a record with no `provides` answers no
// specifier, so shipping it cannot change what the app renders — it only makes the graph's own
// references resolve. A record WITH `provides` is a global override and must earn its place through the
// promotion gate. Carrying one in on the strength of being composed would ship a record that claims a
// specifier with nothing having checked it against the file it shadows.
import { describe, it, expect } from "vitest";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { libraryCarryClosure } from "./lib/graphClosure.mjs";

const mk = (recs: { id: string; provides?: string; composes?: string[] }[]) => new Map(recs.map((r) => [r.id, r]));

describe("libraryCarryClosure", () => {
  it("carries a library record and everything it composes, dependencies FIRST", () => {
    // The real shape: `fnv1a32.ts` is a function harvested out of `hash.ts`, and it composes the
    // TypeScript language primitives — of which the seed had exactly one.
    const byId = mk([
      { id: "fnv1a32.ts", composes: ["typescript.string", "typescript.number"] },
      { id: "typescript.string", composes: [] },
    ]);
    const { carry, blocked } = libraryCarryClosure({
      roots: ["fnv1a32.ts"],
      byId,
      seeded: new Set(["typescript.number"]),
    });
    expect(blocked.size).toBe(0);
    expect(carry).toEqual(["typescript.string", "fnv1a32.ts"]);
  });

  it("REFUSES to carry a record that claims a specifier — an override must pass the gate", () => {
    const byId = mk([{ id: "role-model.ts", provides: "@/shared/lib/session/roleModel", composes: [] }]);
    const { carry, blocked } = libraryCarryClosure({ roots: ["role-model.ts"], byId, seeded: new Set() });
    expect(carry).toEqual([]);
    expect(blocked.get("role-model.ts")).toContain("must be promoted, not carried");
  });

  it("blocks a consumer whose own composes cannot close, rather than carrying it half-formed", () => {
    const byId = mk([
      { id: "leaf.ts", composes: ["missing.ts"] },
      { id: "mid.ts", composes: ["leaf.ts"] },
    ]);
    const { carry, blocked } = libraryCarryClosure({ roots: ["mid.ts"], byId, seeded: new Set() });
    expect(carry).toEqual([]);
    expect(blocked.get("missing.ts")).toBe("no record in the store");
    expect(blocked.get("mid.ts")).toBe("its own composes do not close");
  });

  it("treats an already-seeded id as satisfied and does not re-carry it", () => {
    const byId = mk([{ id: "a.ts", composes: ["b.ts"] }]);
    const { carry } = libraryCarryClosure({ roots: ["a.ts"], byId, seeded: new Set(["b.ts"]) });
    expect(carry).toEqual(["a.ts"]);
  });

  it("survives a CYCLE — `composes` is a knowledge graph and may loop", () => {
    const byId = mk([
      { id: "a.ts", composes: ["b.ts"] },
      { id: "b.ts", composes: ["a.ts"] },
    ]);
    const { carry, blocked } = libraryCarryClosure({ roots: ["a.ts"], byId, seeded: new Set() });
    expect(blocked.size).toBe(0);
    expect([...carry].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("shares one verdict across roots — a blocked record stays blocked for every consumer", () => {
    const byId = mk([
      { id: "override.ts", provides: "@/x", composes: [] },
      { id: "one.ts", composes: ["override.ts"] },
      { id: "two.ts", composes: ["override.ts"] },
    ]);
    const { carry, blocked } = libraryCarryClosure({ roots: ["one.ts", "two.ts"], byId, seeded: new Set() });
    expect(carry).toEqual([]);
    expect(blocked.get("one.ts")).toBe("its own composes do not close");
    expect(blocked.get("two.ts")).toBe("its own composes do not close");
  });
});
