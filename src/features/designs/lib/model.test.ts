import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  resolveComposes,
  resolveUsedBy,
  resolveComponentAnimations,
  resolveComponentAnimationDefs,
  resolveComposedAnimations,
  resolveNamedAnimation,
  selectAnimationPreset,
  MOTION_PRESET_GROUP,
  previewAnimDefs,
  DATA_SHAPES,
  ROLE_COLOR,
  ROLES,
  type ComponentRecord,
  type Kit,
  type DataShape,
} from "./model";
import type { KitAnimation } from "@/shared/ui/kit/animations";
import { BASE_KIT_ID } from "@/shared/ui/kit/baseAnimations";
import { REACT_UI_COMPONENTS, REACT_UI_KIT } from "./reactUiKit";

// #3543: the packaged seed is now a single EMPTY kit, so these generic model-helper tests exercise the
// react-ui LIBRARY (the manifest-generated assembler — the exact set the seed used to carry) as their fixture.
const LIB = REACT_UI_COMPONENTS;
const LIB_KITS = [REACT_UI_KIT];
const byName = (n: string) => LIB.find((c) => c.name === n)!;

describe("component model helpers (#2269)", () => {
  it("matchesQuery is case-insensitive across name/role/tags, and empty → all", () => {
    const chip = byName("Chip");
    expect(matchesQuery(chip, "")).toBe(true);
    expect(matchesQuery(chip, "CHI")).toBe(true); // name
    expect(matchesQuery(chip, "primitive")).toBe(true); // role
    expect(matchesQuery(chip, "status")).toBe(true); // tag
    expect(matchesQuery(chip, "zzz")).toBe(false);
  });

  it("matchesQuery also matches the folder-path group (#3589)", () => {
    const withFolder = { ...byName("Chip"), folder: "shared/ui/controls" };
    expect(matchesQuery(withFolder, "controls")).toBe(true); // folder leaf
    expect(matchesQuery(withFolder, "shared/ui")).toBe(true); // a folder prefix path
    expect(matchesQuery(withFolder, "SHARED/UI")).toBe(true); // case-insensitive
    // A component with no folder doesn't spuriously match a folder query.
    expect(matchesQuery({ ...byName("Chip"), folder: undefined }, "controls")).toBe(false);
  });

  it("resolveComposes pairs each dependency with its record (undefined when absent)", () => {
    const seg = byName("SegmentedControl"); // composes ["Button"]
    const resolved = resolveComposes(seg, LIB);
    expect(resolved.map((r) => r.name)).toEqual(["Button"]);
    expect(resolved[0].comp?.name).toBe("Button");
    // A dependency name not in the kit resolves to undefined (renders non-clickable).
    const orphan = { ...seg, composes: ["Nonexistent"] };
    expect(resolveComposes(orphan, LIB)[0].comp).toBeUndefined();
  });

  it("resolveUsedBy finds the components that compose the target", () => {
    const button = byName("Button"); // composed by SegmentedControl + ConfirmButton + EmptyState
    const users = resolveUsedBy(button, LIB).map((c) => c.name);
    expect(users).toContain("SegmentedControl");
    expect(users).toContain("EmptyState");
    // A page root that nothing composes.
    expect(resolveUsedBy(byName("DashboardPage"), LIB)).toEqual([]);
  });

  it("every role has a color token", () => {
    for (const r of ROLES) expect(ROLE_COLOR[r]).toMatch(/^var\(--/);
  });

  it("seed ids are unique + lowercased from the name", () => {
    const ids = LIB.map((c: ComponentRecord) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byName("Button").id).toBe("button");
  });

  it("the data-shape vocabulary is exactly the seven canonical shapes (#2475/#3517)", () => {
    expect(DATA_SHAPES).toEqual(["list", "linked-list", "tree", "graph", "table", "key-value", "series"]);
    // `shapes` is an optional, typed axis on ComponentRecord — every stamped value is in-vocabulary.
    for (const c of LIB) {
      for (const s of c.shapes ?? []) {
        expect(DATA_SHAPES, `${c.name} stamps an in-vocabulary shape`).toContain(s as DataShape);
      }
    }
  });

  it("the `series` shape names windowedTally's structural signature — an axis + aligned numeric series (#3517)", () => {
    // No runtime value→shape classifier exists (component `shapes` are stamped, not derived from a
    // value; schema→shape inference lives in Rust `bsc data shapes`). This documents the STRUCTURE
    // `series` names: `windowedTally` emits `{ labels: string[], series: Record<name, number[]> }` —
    // an ordered label axis plus one or more numeric value series, each ALIGNED to the axis (one entry
    // per label). That is exactly `series`, and none of the other six describe it.
    expect(DATA_SHAPES).toContain("series" as DataShape);
    // A representative windowedTally-shaped value (2 aligned streams over a 3-day axis).
    const value = { labels: ["7/1", "7/2", "7/3"], series: { opened: [2, 0, 5], merged: [1, 3, 4] } };
    const isSeriesShaped = (v: { labels: unknown; series: Record<string, unknown> }) =>
      Array.isArray(v.labels) &&
      v.labels.every((l) => typeof l === "string") &&
      Object.values(v.series).length >= 1 &&
      Object.values(v.series).every(
        (arr) => Array.isArray(arr) && arr.length === (v.labels as unknown[]).length && arr.every((n) => typeof n === "number"),
      );
    expect(isSeriesShaped(value), "labels axis + ≥1 aligned numeric series IS the `series` shape").toBe(true);
    // The axis-less / misaligned negatives the signature must reject.
    expect(isSeriesShaped({ labels: ["7/1", "7/2"], series: { a: [1] } })).toBe(false); // misaligned length
    expect(isSeriesShaped({ labels: [], series: {} })).toBe(false); // no series at all
  });

  it("every packaged kit carries the rail-hierarchy axes: tech (a lowercase slug) + style (#2487)", () => {
    const byId = new Map(LIB_KITS.map((k) => [k.id, k]));
    expect(byId.get("react-ui")).toMatchObject({ tech: "react", style: "studio" });
    for (const k of LIB_KITS) {
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

describe("previewAnimDefs — the try-on ISOLATES the clicked animation (#3075)", () => {
  const a = { ...draw, kit: "react-ui" };
  const b = { ...fade, kit: "react-ui" };
  it("plays ONLY the try-on animation when one is set (not the whole bound set)", () => {
    expect(previewAnimDefs([a, b], b)).toEqual([b]);
  });
  it("plays the component's full bound motion when there is NO try-on", () => {
    const bound = [a, b];
    expect(previewAnimDefs(bound, null)).toBe(bound);
  });
  it("isolates even an animation already in the bound set — so every click changes the preview", () => {
    // The #3075 regression: appending the clicked one to [a, b] yielded [a, b] every time.
    expect(previewAnimDefs([a, b], a)).toEqual([a]);
    expect(previewAnimDefs([a, b], b)).toEqual([b]);
  });
});

describe("resolveComposedAnimations — pair each composed import with its motion (#3130)", () => {
  const frame = mkComp({ id: "frame", name: "Frame", animations: [draw] });
  const axis = mkComp({ id: "axis", name: "Axis", animations: [fade] });
  it("unions the active animations of the siblings a component composes, namespaced by owner (#3163)", () => {
    const chart = mkComp({ id: "chart", name: "Chart", composes: ["Frame", "Axis"] });
    const defs = resolveComposedAnimations(chart, [chart, frame, axis], [mkKit({})]);
    expect(defs.map((d) => d.name)).toEqual(["draw", "fade-in"]);
    expect(defs.every((d) => d.kit === "react-ui")).toBe(true);
    // #3163: each composed def is stamped with its OWNING sibling so the compiler namespaces its keyframes.
    expect(defs.map((d) => d.component)).toEqual(["Frame", "Axis"]);
  });
  it("dedupes a BYTE-IDENTICAL shared animation across composed siblings (once), by content", () => {
    const a = mkComp({ id: "a", name: "A", animations: [fade] });
    const b = mkComp({ id: "b", name: "B", animations: [fade] });
    const chart = mkComp({ id: "chart", name: "Chart", composes: ["A", "B"] });
    // A & B carry the IDENTICAL `fade` → it contributes exactly once (a genuinely shared animation).
    expect(resolveComposedAnimations(chart, [chart, a, b], [mkKit({})]).map((d) => d.name)).toEqual(["fade-in"]);
  });
  it("keeps two DIFFERENT same-named animations, namespaced by their owning component (#3163)", () => {
    // The invisible collision: A and B both name an animation `spin` but with DIFFERENT keyframes. Before
    // #3163 the kit:name dedup dropped one; now BOTH survive, each namespaced by its owner so the compiled
    // keyframes don't clobber.
    const spinA: KitAnimation = { name: "spin", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } };
    const spinB: KitAnimation = { name: "spin", keyframes: { from: { transform: "rotate(0)" }, to: { transform: "rotate(360deg)" } } };
    const a = mkComp({ id: "a", name: "A", animations: [spinA] });
    const b = mkComp({ id: "b", name: "B", animations: [spinB] });
    const chart = mkComp({ id: "chart", name: "Chart", composes: ["A", "B"] });
    const defs = resolveComposedAnimations(chart, [chart, a, b], [mkKit({})]);
    expect(defs.map((d) => d.name)).toEqual(["spin", "spin"]);
    expect(defs.map((d) => d.component)).toEqual(["A", "B"]);
  });
  it("yields nothing when it composes nothing, and ignores a cross-kit or missing composed name", () => {
    expect(resolveComposedAnimations(mkComp({ composes: [] }), [], [mkKit({})])).toEqual([]);
    const vueFrame = mkComp({ id: "vf", name: "Frame", kitId: "vue-kit", animations: [draw] });
    const chart = mkComp({ id: "chart", name: "Chart", composes: ["Frame", "Ghost"] });
    // Frame here is a DIFFERENT kit → excluded; Ghost isn't in the kit → skipped.
    expect(resolveComposedAnimations(chart, [chart, vueFrame], [mkKit({})])).toEqual([]);
  });
});

describe("resolveNamedAnimation — the try-on replay resolution (#3071)", () => {
  it("finds a component's INLINE animation, not just the kit shelf (the replay regression)", () => {
    const comp = mkComp({ animations: [draw] }); // inline on the component
    const kit = mkKit({ animations: [] });        // shelf EMPTY — the post component-owned migration state
    expect(resolveNamedAnimation(comp, kit, [kit], "draw")?.name).toBe("draw");
    expect(resolveNamedAnimation(comp, kit, [kit], "draw")?.kit).toBe("react-ui");
  });
  it("falls back to the kit's generic shelf when the name isn't on the component", () => {
    const kit = mkKit({ animations: [fade] });    // a generic on the shelf
    expect(resolveNamedAnimation(mkComp({ animations: [] }), kit, [kit], "fade-in")?.name).toBe("fade-in");
  });
  it("returns null for an unknown name, an empty name, or a null component with no shelf match", () => {
    const kit = mkKit({ animations: [] });
    expect(resolveNamedAnimation(mkComp({ animations: [draw] }), kit, [kit], "nope")).toBeNull();
    expect(resolveNamedAnimation(mkComp({ animations: [draw] }), kit, [kit], "")).toBeNull();
    expect(resolveNamedAnimation(null, kit, [kit], "draw")).toBeNull();
  });
});

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

// ── selectAnimationPreset — pick one preset = the component's motion (#3083) ─────────────────────────
describe("selectAnimationPreset (#3083)", () => {
  it("folds EVERY inline binding into the one motion group with the pick as the sole default", () => {
    const out = selectAnimationPreset([draw, fade], "fade-in");
    expect(out).toEqual([
      { ...draw, group: MOTION_PRESET_GROUP, default: false },
      { ...fade, group: MOTION_PRESET_GROUP, default: true },
    ]);
  });

  it("re-picks — exactly one binding is the default after a switch", () => {
    const seeded = selectAnimationPreset([draw, fade], "draw") as KitAnimation[];
    const out = selectAnimationPreset(seeded, "fade-in") as KitAnimation[];
    const defaults = out.filter((e): e is KitAnimation => typeof e !== "string" && !!e.default);
    expect(defaults.map((d) => d.name)).toEqual(["fade-in"]);
  });

  it("leaves NAME-ref (string) entries untouched", () => {
    const out = selectAnimationPreset(["shelf-fade", draw], "draw");
    expect(out[0]).toBe("shelf-fade");
    expect(out[1]).toMatchObject({ name: "draw", group: MOTION_PRESET_GROUP, default: true });
  });

  it("after selecting a preset, ONLY the pick plays (resolveComponentAnimations picks it)", () => {
    // Two ungrouped animations both play today; selecting one makes it the sole motion.
    const comp = mkComp({ animations: selectAnimationPreset([draw, fade], "fade-in") });
    expect(resolveComponentAnimations(comp, [mkKit({})]).map((d) => d.name)).toEqual(["fade-in"]);
  });
});

describe("cross-kit base-motion resolution (#3451)", () => {
  // The app's foundational motion is owned ONCE by the `base` kit; react-ui (and any other kit)
  // REFERENCES it by name. Resolution therefore has to leave its own kit — the behaviour this covers.
  const lift: KitAnimation = { name: "lift", trigger: "hover", keyframes: { from: { transform: "translateY(0)" }, to: { transform: "translateY(-1px)" } } };
  const baseKit = mkKit({ id: BASE_KIT_ID, name: "Base", animations: [lift] });
  const reactUi = mkKit({ id: "react-ui", animations: [] });

  it("resolves a name the component's OWN kit does not define from the base kit", () => {
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: ["lift"] });
    const defs = resolveComponentAnimationDefs(btn, [reactUi, baseKit]);
    expect(defs.map((d) => d.name)).toEqual(["lift"]);
    expect(defs[0].keyframes).toEqual(lift.keyframes);
  });

  it("keeps the OWNING kit on a base-resolved def, so every consumer shares one keyframes block", () => {
    // THE load-bearing assertion. `kit` names both `@keyframes bsc-<kit>-<name>` and the
    // `.<kit>-anim-<name>` class the preview stamps. Restamping to the CONSUMER would duplicate the
    // keyframes per kit and defeat propagation — and, if only one side were restamped, the class would
    // not match the compiled rule and the animation would silently play nothing.
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: ["lift"] });
    expect(resolveComponentAnimationDefs(btn, [reactUi, baseKit])[0].kit).toBe(BASE_KIT_ID);
  });

  it("prefers a kit's OWN definition over the base one of the same name (override wins)", () => {
    const ownLift: KitAnimation = { name: "lift", keyframes: { from: { opacity: "0" }, to: { opacity: "1" } } };
    const overriding = mkKit({ id: "react-ui", animations: [ownLift] });
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: ["lift"] });
    const [def] = resolveComponentAnimationDefs(btn, [overriding, baseKit]);
    expect(def.keyframes).toEqual(ownLift.keyframes);
    expect(def.kit, "an own def stays namespaced to its own kit").toBe("react-ui");
  });

  it("drops a name defined by NEITHER the own kit nor base (no dangling ref)", () => {
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: ["nope"] });
    expect(resolveComponentAnimationDefs(btn, [reactUi, baseKit])).toEqual([]);
  });

  it("still stamps an INLINE def with the component's own kit (unchanged by the fallback)", () => {
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: [fade] });
    expect(resolveComponentAnimationDefs(btn, [reactUi, baseKit])[0].kit).toBe("react-ui");
  });

  it("resolves a base component's own animations without changing their kit", () => {
    const dot = mkComp({ id: "dot", name: "Dot", kitId: BASE_KIT_ID, animations: ["lift"] });
    expect(resolveComponentAnimationDefs(dot, [reactUi, baseKit])[0].kit).toBe(BASE_KIT_ID);
  });

  it("exposes the base shelf to a try-on from another kit (react-ui's own library is empty now)", () => {
    // Without the base shelf, `resolveNamedAnimation` could not find a base motion the component does
    // not already bind — so clicking it in the AnimationsMenu would preview nothing.
    const btn = mkComp({ id: "btn", name: "Button", kitId: "react-ui", animations: [] });
    const found = resolveNamedAnimation(btn, reactUi, [reactUi, baseKit], "lift");
    expect(found?.name).toBe("lift");
    expect(found?.kit).toBe(BASE_KIT_ID);
  });
});
