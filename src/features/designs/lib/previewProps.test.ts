// Preview-props parity (#3165) — the TS half of the cross-language contract. `previewProps(comp)` (the
// preview harness's inspectable prop sampler, componentPreview.ts) MUST match every golden in
// `previewProps.fixtures.json`; the Rust `bsc ui preview-props` verb asserts the SAME fixture in
// `crates/bsc-component/src/preview_props.rs`, so the two stay byte-for-byte in lockstep.
import { describe, it, expect } from "vitest";
import {
  previewProps, previewPropList, previewChild, bootstrapSource, cannotTypeProp, unsampledRequiredProps,
} from "./componentPreview";
import type { ComponentRecord } from "@/features/designs/lib/model";
import fixtures from "./previewProps.fixtures.json";

/** Build a minimal ComponentRecord from a fixture case's `comp` — name + props drive the sampler, and
 *  `source` (when the case carries one) is where the props the component DEFAULTS are read from. */
function comp(
  name: string,
  props: readonly { name: string; type: string; req: boolean }[],
  source = "",
): ComponentRecord {
  return {
    id: name.toLowerCase(), name, kitId: "test-kit", role: "composite", version: "1.0.0", used: 0,
    tags: [], variants: ["default"], composes: [], whenUse: [], whenNot: [], src: "", srcText: "", source,
    props: props.map((p) => ({ ...p, desc: "" })),
  };
}

describe("previewProps parity fixture (#3165)", () => {
  for (const c of fixtures.cases) {
    it(`matches the golden — ${c.desc}`, () => {
      expect(previewProps(comp(c.comp.name, c.comp.props, "source" in c.comp ? c.comp.source : ""))).toEqual(c.expected);
    });
  }
});

// #84 — a required prop the sampler cannot TYPE was dropped silently, so the component mounted with
// `undefined` and whatever it did next threw. `PaneMenu` reported `Cannot read properties of null (reading
// 'find')`; its entire dependency chain was searched for a null `.find()` that was never there, because the
// value simply never arrived. The sampler still does not guess — it has only the type NAME, so a wrong
// literal could crash a component that switches on it — but the prop is now NAMED instead of invisible.
describe("unsampled required props are reported, not silently dropped (#84)", () => {
  const paneMenu = comp("PaneMenu", [
    { name: "model", type: "ModelId", req: true },      // named alias over a literal union
    { name: "active", type: "ViewKey", req: true },     // same
    { name: "vp", type: "GraphViewport", req: true },   // an object type — most of the real cases
    { name: "available", type: "ViewKey[]", req: true },// container: omitted BY DESIGN
    { name: "loading", type: "boolean", req: true },    // loading-family: state-driven BY DESIGN
    { name: "error", type: "string", req: true },       // error-family: state-driven BY DESIGN
    { name: "tone", type: '"neutral" | "danger"', req: true }, // an INLINE union IS sampleable
    { name: "onPick", type: "(v) => void", req: true },
  ]);

  it("names exactly the required props whose TYPE matches no branch", () => {
    expect(unsampledRequiredProps(paneMenu).map((p) => p.name)).toEqual(["model", "active", "vp"]);
    // The two the reporter chased are there, and nothing that is absent by design is.
    expect(cannotTypeProp({ name: "model", type: "ModelId", req: true, desc: "" })).toBe(true);
    expect(cannotTypeProp({ name: "tone", type: '"a" | "b"', req: true, desc: "" })).toBe(false);
  });

  it("carries the report on EVERY state, so `--state` cannot hide it", () => {
    const states = previewProps(paneMenu);
    for (const s of ["loaded", "empty", "loading"] as const) {
      expect(states[s].unsampled).toEqual(["model", "active", "vp"]);
    }
    // A component whose required props are all sampleable reports nothing — the overwhelming majority.
    expect(previewProps(comp("Plain", [{ name: "label", type: "string", req: true }])).loaded.unsampled).toEqual([]);
  });

  it("warns in the BOOTSTRAP, so the cause is one line above the effect in the console", () => {
    // This is the whole point: the throw reads as a component bug, and the console now says why first.
    const src = bootstrapSource(paneMenu, "@/x");
    expect(src).toContain("console.warn(");
    expect(src).toContain("model: ModelId");
    expect(src).toContain("active: ViewKey");
    // The warn is emitted BEFORE the mount — against the createRoot CALL, not the import of the same
    // name, which sits at the top of every bootstrap.
    expect(src.indexOf("console.warn(")).toBeLessThan(src.indexOf("createRoot(document"));
    // A clean component gets no warning at all — no noise for the majority.
    expect(bootstrapSource(comp("Plain", [{ name: "label", type: "string", req: true }]), "@/x")).not.toContain("console.warn(");
  });

  it("does NOT warn about a prop the caller bound via preview data", () => {
    // A bound prop does arrive (`statePropsLiteral` layers the overrides on top), so warning would cry wolf.
    const src = bootstrapSource(paneMenu, "@/x", "loaded", { model: '"claude-opus-5"', active: '"chat"' });
    expect(src).toContain("vp: GraphViewport");   // still missing → still named
    expect(src).not.toContain("model: ModelId");  // supplied → not named
  });
});

describe("previewPropList / previewChild (#3165)", () => {
  const chart = comp("Chart", [
    { name: "children", type: "ReactNode", req: false },
    { name: "data", type: "Row[]", req: false },
    { name: "loading", type: "boolean", req: false },
  ]);

  it("excludes `children` from the prop list and carries it as the child", () => {
    expect(previewChild(chart)).toBe('"Chart"');
    // `children` never appears in the list; a component with no `children` prop has a null child.
    expect(previewPropList(chart).some((e) => e.name === "children")).toBe(false);
    expect(previewChild(comp("Bare", [{ name: "x", type: "string", req: false }]))).toBeNull();
  });

  it("threads the data-state through to the sampled list", () => {
    // loaded: optional collection omitted, loading flag off → neither present.
    expect(previewPropList(chart, "loaded")).toEqual([]);
    // empty: the collection is passed as []; the loading flag is still off.
    expect(previewPropList(chart, "empty")).toEqual([{ name: "data", value: "[]" }]);
    // loading: the loading flag turns on; the optional collection stays omitted.
    expect(previewPropList(chart, "loading")).toEqual([{ name: "loading", value: "true" }]);
  });
});

// THE REGRESSION. `loaded` dropped a REQUIRED container, so a component with no loading-guard (loading is
// false in `loaded`) read it unconditionally and got `undefined` — LanguageMix threw on
// `Object.values(langTotals)`, OpenPRsAllRepos on `prs.length`, and both read as component bugs. The
// omission itself is right (#3693) but only for a component that supplies its OWN default for the prop,
// which is a fact about the source, not about `req`.
describe("a required container is omitted only when the component defaults it", () => {
  const required = [
    { name: "langTotals", type: "Record<string, number>", req: true },
    { name: "prs", type: "OpenPR[]", req: true },
  ];

  it("supplies it in every state when the signature has no default", () => {
    const c = comp("LanguageMix", required, "export function LanguageMix({ langTotals, prs }: Props) { return null; }");
    for (const state of ["loaded", "empty", "loading"] as const) {
      expect(previewPropList(c, state)).toEqual([
        { name: "langTotals", value: "{}" },
        { name: "prs", value: "[]" },
      ]);
    }
  });

  it("omits it in loaded/loading when the signature DOES default it (#3693 preserved)", () => {
    const c = comp("WorkerBoard", required, "export function WorkerBoard({ langTotals = DEMO, prs = DEMO_PRS }) {}");
    expect(previewPropList(c, "loaded")).toEqual([]);
    expect(previewPropList(c, "loading")).toEqual([]);
    expect(previewPropList(c, "empty")).toEqual([
      { name: "langTotals", value: "{}" },
      { name: "prs", value: "[]" },
    ]);
  });

  it("keeps an OPTIONAL container omitted either way — its contract allows undefined", () => {
    const optional = [{ name: "rows", type: "Row[]", req: false }];
    for (const src of ["export function Grid({ rows }: Props) {}", "export function Grid({ rows = DEMO }) {}"]) {
      expect(previewPropList(comp("Grid", optional, src), "loaded")).toEqual([]);
    }
  });

  it("falls back to supplying the prop when the source cannot be parsed", () => {
    // No source at all, and a source whose declaration does not match the component — both must land on the
    // SAFE side (supply), since a wrongly-detected default omits the prop and the component throws.
    for (const src of ["", "export function Other({ langTotals = DEMO, prs = DEMO }) {}"]) {
      expect(previewPropList(comp("LanguageMix", required, src), "loaded")).toEqual([
        { name: "langTotals", value: "{}" },
        { name: "prs", value: "[]" },
      ]);
    }
  });
});
