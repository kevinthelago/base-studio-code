// Preview-props parity (#3165) — the TS half of the cross-language contract. `previewProps(comp)` (the
// preview harness's inspectable prop sampler, componentPreview.ts) MUST match every golden in
// `previewProps.fixtures.json`; the Rust `bsc ui preview-props` verb asserts the SAME fixture in
// `crates/bsc-component/src/preview_props.rs`, so the two stay byte-for-byte in lockstep.
import { describe, it, expect } from "vitest";
import { previewProps, previewPropList, previewChild } from "./componentPreview";
import type { ComponentRecord } from "./model";
import fixtures from "./previewProps.fixtures.json";

/** Build a minimal ComponentRecord from a fixture case's `comp` (only name + props drive the sampler). */
function comp(name: string, props: readonly { name: string; type: string; req: boolean }[]): ComponentRecord {
  return {
    id: name.toLowerCase(), name, kitId: "test-kit", role: "composite", version: "1.0.0", used: 0,
    tags: [], variants: ["default"], composes: [], whenUse: [], whenNot: [], src: "", srcText: "",
    props: props.map((p) => ({ ...p, desc: "" })),
  };
}

describe("previewProps parity fixture (#3165)", () => {
  for (const c of fixtures.cases) {
    it(`matches the golden — ${c.desc}`, () => {
      expect(previewProps(comp(c.comp.name, c.comp.props))).toEqual(c.expected);
    });
  }
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
