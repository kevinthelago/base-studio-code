import { describe, it, expect } from "vitest";
import {
  transformationsConfirmed, tierGroups, nextPendingTier, tierLabel,
  coerceTransformationRows, specNodeCount, TRANSFORMATION_TAXONOMY, verbMeta,
  type TransformationRow,
} from "./transformations";

/** A minimal valid row; override per test. */
const row = (over: Partial<TransformationRow> = {}): TransformationRow => ({
  id: over.id ?? `t-${Math.random().toString(36).slice(2, 8)}`,
  verb: "extract",
  title: "Extract the shared button",
  target: { description: "4 bespoke buttons across the app" },
  delta: "bespoke buttons → one shared <Button>",
  invariants: ["existing tests pass"],
  owns: ["src/shared/ui/**"],
  tier: 0,
  ...over,
});

describe("transformationsConfirmed — the gate signal (#2509)", () => {
  it("is false for empty/null/undefined (an empty queue never clears the gate)", () => {
    expect(transformationsConfirmed([])).toBe(false);
    expect(transformationsConfirmed(null)).toBe(false);
    expect(transformationsConfirmed(undefined)).toBe(false);
  });

  it("is false while ANY row is pending, true only when every row is confirmed", () => {
    const rows = [row({ id: "a", confirmed: true }), row({ id: "b" })];
    expect(transformationsConfirmed(rows)).toBe(false);
    expect(transformationsConfirmed(rows.map((r) => ({ ...r, confirmed: true })))).toBe(true);
  });

  it("treats a missing/false confirmed as pending (never truthy-coerced)", () => {
    expect(transformationsConfirmed([row({ confirmed: false })])).toBe(false);
    expect(transformationsConfirmed([row({})])).toBe(false);
  });
});

describe("tierGroups", () => {
  it("groups by tier ascending, position-stable within a tier", () => {
    const rows = [
      row({ id: "p2", tier: 2 }),
      row({ id: "a0", tier: 0 }),
      row({ id: "b1", tier: 1 }),
      row({ id: "b0", tier: 0 }),
      row({ id: "a1", tier: 1 }),
    ];
    const groups = tierGroups(rows);
    expect(groups.map((g) => g.tier)).toEqual([0, 1, 2]);
    // Within a tier, original list order is preserved (the planner's order, never re-sorted).
    expect(groups[0].rows.map((r) => r.id)).toEqual(["a0", "b0"]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(["b1", "a1"]);
    expect(groups[2].rows.map((r) => r.id)).toEqual(["p2"]);
  });

  it("handles sparse tiers (no empty groups synthesized) and an empty list", () => {
    expect(tierGroups([]).length).toBe(0);
    const groups = tierGroups([row({ tier: 0 }), row({ tier: 3 })]);
    expect(groups.map((g) => g.tier)).toEqual([0, 3]);
  });
});

describe("nextPendingTier", () => {
  it("is the LOWEST tier containing an unconfirmed row", () => {
    const rows = [
      row({ tier: 0, confirmed: true }),
      row({ tier: 1 }),
      row({ tier: 2 }),
    ];
    expect(nextPendingTier(rows)).toBe(1);
  });

  it("stays on a tier until EVERY row in it is confirmed", () => {
    const rows = [row({ tier: 0, confirmed: true }), row({ tier: 0 }), row({ tier: 1 })];
    expect(nextPendingTier(rows)).toBe(0);
  });

  it("is null when empty or fully confirmed (the completion card shows)", () => {
    expect(nextPendingTier([])).toBe(null);
    expect(nextPendingTier([row({ tier: 0, confirmed: true }), row({ tier: 2, confirmed: true })])).toBe(null);
  });
});

describe("tierLabel — driven by the @data taxonomy tiers (#2509 slice b)", () => {
  it("names the floor primitives, the top pages, and the middle composites", () => {
    expect(tierLabel(0, 2)).toBe("Tier 0 · primitives");
    expect(tierLabel(1, 2)).toBe("Tier 1 · composites");
    expect(tierLabel(2, 2)).toBe("Tier 2 · pages");
  });

  it("a single-tier queue reads as primitives (tier 0 always wins the floor name)", () => {
    expect(tierLabel(0, 0)).toBe("Tier 0 · primitives");
  });

  it("a four-tier queue surfaces the taxonomy's full ladder (layouts between composites and pages)", () => {
    expect(tierLabel(1, 3)).toBe("Tier 1 · composites");
    expect(tierLabel(2, 3)).toBe("Tier 2 · layouts");
    expect(tierLabel(3, 3)).toBe("Tier 3 · pages");
  });

  it("clamps a deep middle tier to the last middle label (never pages before the top)", () => {
    expect(tierLabel(3, 5)).toBe("Tier 3 · layouts");
    expect(tierLabel(5, 5)).toBe("Tier 5 · pages");
  });
});

describe("TRANSFORMATION_TAXONOMY — the @data drift guard (#2509 slice b)", () => {
  it("carries exactly the 11 verbs of the plandb enum, in enum order", () => {
    // MUST match crates/plandb/src/validate.rs's embedded vocabulary (the same file) — the CLI
    // rejects any verb outside this set at set-time.
    expect(TRANSFORMATION_TAXONOMY.verbs.map((v) => v.id)).toEqual([
      "rename", "extract", "split", "merge", "move", "replace",
      "upgrade", "restyle", "remove", "optimize", "harden",
    ]);
  });

  it("every verb carries label + blurb (the chip tooltip) + verification hint", () => {
    for (const v of TRANSFORMATION_TAXONOMY.verbs) {
      expect(v.label.trim().length, `${v.id} label`).toBeGreaterThan(0);
      expect(v.blurb.trim().length, `${v.id} blurb`).toBeGreaterThan(0);
      expect(v.verification.trim().length, `${v.id} verification`).toBeGreaterThan(0);
    }
  });

  it("carries the two recipes, each with its canonical steps", () => {
    expect(TRANSFORMATION_TAXONOMY.recipes.map((r) => r.id)).toEqual([
      "migrate-to-kit", "extract-and-abstract",
    ]);
    for (const r of TRANSFORMATION_TAXONOMY.recipes) {
      expect(r.steps.length, `${r.id} steps`).toBeGreaterThan(0);
    }
  });

  it("carries the four composition tiers 0..3: primitives · composites · layouts · pages", () => {
    expect(TRANSFORMATION_TAXONOMY.tiers.map((t) => [t.tier, t.label])).toEqual([
      [0, "primitives"], [1, "composites"], [2, "layouts"], [3, "pages"],
    ]);
  });
});

describe("verbMeta", () => {
  it("resolves a taxonomy verb's display metadata from the data file", () => {
    const m = verbMeta("replace");
    expect(m.label).toBe("Replace");
    expect(m.blurb.length).toBeGreaterThan(0);
    expect(m.verification.length).toBeGreaterThan(0);
  });

  it("echoes an unknown id back bare (a stale taxonomy never crashes the pane)", () => {
    expect(verbMeta("polish")).toEqual({ id: "polish", label: "polish", blurb: "", verification: "" });
  });
});

describe("coerceTransformationRows", () => {
  it("rejects non-arrays and filters rows without a string id", () => {
    expect(coerceTransformationRows(null)).toEqual([]);
    expect(coerceTransformationRows({ id: "x" })).toEqual([]);
    expect(coerceTransformationRows([{ id: "ok", tier: 1 }, { tier: 0 }, "junk", 7]).map((r) => r.id)).toEqual(["ok"]);
  });

  it("defaults a missing/invalid tier to 0 so grouping never breaks", () => {
    const [a, b] = coerceTransformationRows([{ id: "a" }, { id: "b", tier: "high" }]);
    expect(a.tier).toBe(0);
    expect(b.tier).toBe(0);
  });
});

describe("specNodeCount", () => {
  it("counts nodes carrying a `kind`, recursing children + nested nodes", () => {
    expect(specNodeCount(undefined)).toBe(0);
    expect(specNodeCount({ kind: "tag", label: "x" })).toBe(1);
    expect(specNodeCount({
      kind: "card",
      header: { kind: "header", title: "h" },
      children: [{ kind: "text", text: "t" }, { kind: "row", children: [{ kind: "tag", label: "y" }] }],
    })).toBe(5);
  });

  it("ignores non-node objects (a target/provenance blob is not a node)", () => {
    expect(specNodeCount({ description: "not a node" })).toBe(0);
  });
});
