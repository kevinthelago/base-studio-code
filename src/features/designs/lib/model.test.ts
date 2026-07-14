import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  resolveComposes,
  resolveUsedBy,
  resolveComponentAnimations,
  resolveComponentAnimationDefs,
  DATA_SHAPES,
  ROLE_COLOR,
  ROLES,
  type ComponentRecord,
  type Kit,
  type DataShape,
} from "./model";
import type { KitAnimation } from "@/shared/ui/kit/animations";
import { SEED_COMPONENTS, SEED_KITS } from "./seed";

const byName = (n: string) => SEED_COMPONENTS.find((c) => c.name === n)!;

describe("component model helpers (#2269)", () => {
  it("matchesQuery is case-insensitive across name/role/tags, and empty → all", () => {
    const chip = byName("Chip");
    expect(matchesQuery(chip, "")).toBe(true);
    expect(matchesQuery(chip, "CHI")).toBe(true); // name
    expect(matchesQuery(chip, "primitive")).toBe(true); // role
    expect(matchesQuery(chip, "status")).toBe(true); // tag
    expect(matchesQuery(chip, "zzz")).toBe(false);
  });

  it("resolveComposes pairs each dependency with its record (undefined when absent)", () => {
    const seg = byName("SegmentedControl"); // composes ["Button"]
    const resolved = resolveComposes(seg, SEED_COMPONENTS);
    expect(resolved.map((r) => r.name)).toEqual(["Button"]);
    expect(resolved[0].comp?.name).toBe("Button");
    // A dependency name not in the kit resolves to undefined (renders non-clickable).
    const orphan = { ...seg, composes: ["Nonexistent"] };
    expect(resolveComposes(orphan, SEED_COMPONENTS)[0].comp).toBeUndefined();
  });

  it("resolveUsedBy finds the components that compose the target", () => {
    const button = byName("Button"); // composed by SegmentedControl + ConfirmButton + EmptyState
    const users = resolveUsedBy(button, SEED_COMPONENTS).map((c) => c.name);
    expect(users).toContain("SegmentedControl");
    expect(users).toContain("EmptyState");
    // A page root that nothing composes.
    expect(resolveUsedBy(byName("DashboardPage"), SEED_COMPONENTS)).toEqual([]);
  });

  it("every role has a color token", () => {
    for (const r of ROLES) expect(ROLE_COLOR[r]).toMatch(/^var\(--/);
  });

  it("seed ids are unique + lowercased from the name", () => {
    const ids = SEED_COMPONENTS.map((c: ComponentRecord) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byName("Button").id).toBe("button");
  });

  it("the data-shape vocabulary is exactly the six canonical shapes (#2475)", () => {
    expect(DATA_SHAPES).toEqual(["list", "linked-list", "tree", "graph", "table", "key-value"]);
    // `shapes` is an optional, typed axis on ComponentRecord — every stamped value is in-vocabulary.
    for (const c of SEED_COMPONENTS) {
      for (const s of c.shapes ?? []) {
        expect(DATA_SHAPES, `${c.name} stamps an in-vocabulary shape`).toContain(s as DataShape);
      }
    }
  });

  it("every packaged kit carries the rail-hierarchy axes: tech (a lowercase slug) + style (#2487)", () => {
    const byId = new Map(SEED_KITS.map((k) => [k.id, k]));
    expect(byId.get("react-ui")).toMatchObject({ tech: "react", style: "studio" });
    for (const k of SEED_KITS) {
      expect(k.tech, `${k.id} tech is a lowercase slug`).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(k.style, `${k.id} carries a visual-language label`).toBeTruthy();
    }
  });
});

// ── resolveComponentAnimations — kit-name refs + inline defs (#2942/#3065) ─────────────────────────
const fade: KitAnimation = { name: "fade-in", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } };
const draw: KitAnimation = { name: "draw", keyframes: { from: { "stroke-dashoffset": "100" }, to: { "stroke-dashoffset": "0" } } };

const mkComp = (over: Partial<ComponentRecord>): ComponentRecord => ({
  id: "spark", name: "Sparkline", kitId: "react-ui", role: "composite", version: "1.0.0",
  used: 0, tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "", srcText: "", ...over,
});
const mkKit = (over: Partial<Kit>): Kit => ({ id: "react-ui", name: "React UI", stack: "React", dot: "var(--accent)", ...over });

describe("resolveComponentAnimations (#2942/#3065)", () => {
  it("resolves an INLINE-def-only component even when the kit has NO animations library (the #3065 regression)", () => {
    // The pre-#3065 resolver bailed on the empty-kit check and silently rendered nothing; an inline-only
    // component must now resolve its own def objects directly.
    const comp = mkComp({ animations: [draw] });
    const kit = mkKit({ animations: [] }); // empty library — the exact silent-fail case
    const defs = resolveComponentAnimations(comp, [kit]);
    expect(defs.map((d) => d.name)).toEqual(["draw"]);
    expect(defs[0]).toMatchObject({ name: "draw", kit: "react-ui" });
  });

  it("resolves a NAME ref from the kit's animations library (the pre-#3065 path, unchanged)", () => {
    const comp = mkComp({ animations: ["fade-in"] });
    const kit = mkKit({ animations: [fade, draw] });
    const defs = resolveComponentAnimations(comp, [kit]);
    expect(defs.map((d) => d.name)).toEqual(["fade-in"]);
    expect(defs[0].keyframes).toEqual(fade.keyframes);
    expect(defs[0].kit).toBe("react-ui");
  });

  it("resolves a MIXED array — a kit NAME ref AND an inline def object — resolving both, in order", () => {
    const comp = mkComp({ animations: ["fade-in", draw] });
    const kit = mkKit({ animations: [fade] }); // only fade-in is in the library; draw is inline
    const defs = resolveComponentAnimations(comp, [kit]);
    expect(defs.map((d) => d.name)).toEqual(["fade-in", "draw"]);
    for (const d of defs) expect(d.kit).toBe("react-ui");
  });

  it("drops a malformed inline object (missing keyframes) and an unresolved name", () => {
    const comp = mkComp({
      // a valid inline def, a malformed inline object (no keyframes), and a name not in the library
      animations: [draw, { name: "broken" } as unknown as KitAnimation, "nonexistent"],
    });
    const kit = mkKit({ animations: [] });
    const defs = resolveComponentAnimations(comp, [kit]);
    expect(defs.map((d) => d.name)).toEqual(["draw"]);
  });

  it("empty when the component binds nothing, and every resolved def carries kit: comp.kitId", () => {
    expect(resolveComponentAnimations(mkComp({}), [mkKit({ animations: [fade] })])).toEqual([]);
    // kitId stamping holds even for an inline def whose owning kit isn't in the list at all.
    const defs = resolveComponentAnimations(mkComp({ kitId: "vue-kit", animations: [draw] }), [mkKit({})]);
    expect(defs).toHaveLength(1);
    expect(defs[0].kit).toBe("vue-kit");
  });
});

// ── Animation VARIATIONS — per-slot alternatives (#3069) ────────────────────────────────────────────
// Grouped inline defs: two "bars" variations (one the marked default) + a separate one-off group.
const barsGrow: KitAnimation = {
  name: "bars-grow", group: "bars", default: true,
  keyframes: { from: { transform: "scaleY(0)" }, to: { transform: "scaleY(1)" } },
};
const barsFade: KitAnimation = {
  name: "bars-fade", group: "bars",
  keyframes: { from: { opacity: "0" }, to: { opacity: "1" } },
};

describe("resolveComponentAnimations — variation slots (#3069)", () => {
  it("(a) ungrouped animations ALL resolve and play — zero regression vs today's data", () => {
    const comp = mkComp({ animations: [draw, fade] }); // both inline, neither grouped
    expect(resolveComponentAnimations(comp, [mkKit({})]).map((d) => d.name)).toEqual(["draw", "fade-in"]);
  });

  it("(b) a group with a marked `default` resolves ONLY the default (even when listed later)", () => {
    // bars-fade first, bars-grow (the default) second → only bars-grow plays, at the slot's first slot.
    const comp = mkComp({ animations: [barsFade, barsGrow] });
    const defs = resolveComponentAnimations(comp, [mkKit({})]);
    expect(defs.map((d) => d.name)).toEqual(["bars-grow"]);
  });

  it("(c) a group with NO default resolves the FIRST in appearance order", () => {
    const first: KitAnimation = { name: "first", group: "g", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } };
    const second: KitAnimation = { name: "second", group: "g", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } };
    const comp = mkComp({ animations: [first, second] });
    expect(resolveComponentAnimations(comp, [mkKit({})]).map((d) => d.name)).toEqual(["first"]);
  });

  it("(d) mixed grouped + ungrouped resolves the group's default + EVERY ungrouped, order preserved", () => {
    // order: bars-fade (grouped) · draw (ungrouped) · bars-grow (grouped default). The slot is emitted
    // at its FIRST-appearance position holding the default; the ungrouped def keeps its place.
    const comp = mkComp({ animations: [barsFade, draw, barsGrow] });
    expect(resolveComponentAnimations(comp, [mkKit({})]).map((d) => d.name)).toEqual(["bars-grow", "draw"]);
  });

  it("resolveComponentAnimationDefs keeps ALL variations (the menu's full set), group/default riding through", () => {
    const comp = mkComp({ animations: [barsFade, draw, barsGrow] });
    const all = resolveComponentAnimationDefs(comp, [mkKit({})]);
    expect(all.map((d) => d.name)).toEqual(["bars-fade", "draw", "bars-grow"]);
    expect(all[0].group).toBe("bars");
    expect(all[2].default).toBe(true);
    expect(all.every((d) => d.kit === "react-ui")).toBe(true);
  });
});
