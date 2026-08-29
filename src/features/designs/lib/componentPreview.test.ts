import { describe, it, expect } from "vitest";
import { makeGraphProvidesResolver, componentPreviewFiles, componentBuildable, bootstrapSource, samplePropValue, isErrorProp, supportedStates, previewCycleStates, looksBuildableModule, isPreviewBuildable, hasCodeElision, erasedSpecs, PREVIEW_ENTRY, type KitArtifact } from "./componentPreview";
import type { ComponentRecord, PropSpec } from "@/features/designs/lib/model";

const prop = (name: string, type: string, req = false): PropSpec => ({ name, type, req, desc: "" });

const base: ComponentRecord = {
  id: "card", name: "Card", kitId: "react-ui", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "shared/ui/data/Card.tsx", srcText: "",
};

const ARTIFACT: KitArtifact = {
  components: [
    { id: "card", src: "shared/ui/data/Card.tsx", source: 'import { fmt } from "@/shared/lib/core/format";\nexport function Card() { return null; }' },
    { id: "skeleton", src: "shared/ui/feedback/Skeleton.tsx", source: "export function Skeleton() { return null; }" },
  ],
  runtime: { "shared/lib/core/format.ts": "export const fmt = (x) => String(x);" },
};

describe("bootstrapSource preview-data override (#2940)", () => {
  // An OPTIONAL collection prop the sampler omits in `loaded` (so a demo-on-undefined component shows its
  // own demo). The studio-network override injects a bound algorithm's dataset in its place.
  const chart: ComponentRecord = { ...base, name: "Heatmap", props: [prop("label", "string"), prop("data", "HeatDatum[]")] };

  it("injects a bound prop the sampler OMITTED, as a JS-source literal", () => {
    const withoutOverride = bootstrapSource(chart, "@/x", "loaded");
    expect(withoutOverride).not.toContain('"data":'); // optional collection → omitted by default

    const src = bootstrapSource(chart, "@/x", "loaded", { data: JSON.stringify([{ x: "mon", y: "0", value: 3 }]) });
    expect(src).toContain('"data": [{"x":"mon","y":"0","value":3}]');
    // The sampled scalar prop is still present alongside the override.
    expect(src).toContain('"label":');
  });

  it("REPLACES a sampled prop's value when overridden", () => {
    const src = bootstrapSource(chart, "@/x", "loaded", { label: JSON.stringify("Generated") });
    expect(src).toContain('"label": "Generated"');
  });

  it("ignores a `children` override (children mount as the element child, not a prop)", () => {
    const src = bootstrapSource(chart, "@/x", "loaded", { children: '"nope"' });
    expect(src).not.toContain('"children":');
  });
});

describe("componentPreviewFiles (#2824)", () => {
  it("assembles a BUILT-IN from the artifact: its source + runtime closure + all components + a bootstrap", () => {
    const build = componentPreviewFiles(base, ARTIFACT)!;
    expect(build).not.toBeNull();
    expect(build.entry).toBe(PREVIEW_ENTRY);
    // The artifact's component sources + runtime are all present (esbuild tree-shakes to what's used).
    expect(build.files["shared/ui/data/Card.tsx"]).toContain("export function Card");
    expect(build.files["shared/ui/feedback/Skeleton.tsx"]).toBeDefined();
    expect(build.files["shared/lib/core/format.ts"]).toBeDefined();
    // The bootstrap imports the target via its @/ spec (the mem plugin resolves it to the file above).
    expect(build.files[PREVIEW_ENTRY]).toContain('import * as __mod from "@/shared/ui/data/Card"');
    expect(build.files[PREVIEW_ENTRY]).toContain('__mod["Card"]');
  });

  it("assembles a USER-AUTHORED component from its own self-contained source (any library)", () => {
    const d3comp: ComponentRecord = {
      ...base, id: "myforce", name: "MyForce", kitId: "user-kit", src: "",
      source: 'import * as d3 from "d3";\nexport function MyForce() { return null; }',
    };
    const build = componentPreviewFiles(d3comp, ARTIFACT)!;
    expect(build).not.toBeNull();
    // The user source is under a synthetic path, imported by the bootstrap; d3 stays a bare import
    // (→ esm.sh at bundle time). No artifact files are needed.
    expect(Object.values(build.files).some((s) => s.includes('from "d3"'))).toBe(true);
    expect(build.files[PREVIEW_ENTRY]).toContain('__mod["MyForce"]');
  });

  it("returns null when there is no buildable source (a bare catalog stub)", () => {
    const stub: ComponentRecord = { ...base, id: "ghost", name: "Ghost", src: "nowhere/Ghost.tsx", source: undefined };
    expect(componentPreviewFiles(stub, ARTIFACT)).toBeNull();
  });

  it("falls back to a USER-AUTHORED component's srcText WHEN it's a self-contained module (#2828)", () => {
    // No artifact `source` (a user component the store omits `source` for), but its srcText is a real
    // module importing only a bare library → buildable via esm.sh, imported under its `src` path.
    const authored: ComponentRecord = {
      ...base, id: "gx", name: "GraphExplorerPage", kitId: "user-kit", src: "user/pages/GraphExplorerPage.tsx",
      source: undefined,
      srcText: 'import * as d3 from "d3";\nexport function GraphExplorerPage() { return null; }',
    };
    const build = componentPreviewFiles(authored, ARTIFACT)!;
    expect(build).not.toBeNull();
    expect(build.files["user/pages/GraphExplorerPage.tsx"]).toContain("export function GraphExplorerPage");
    expect(Object.values(build.files).some((s) => s.includes('from "d3"'))).toBe(true);
    expect(build.files[PREVIEW_ENTRY]).toContain('import * as __mod from "@/user/pages/GraphExplorerPage"');
    expect(build.files[PREVIEW_ENTRY]).toContain('__mod["GraphExplorerPage"]');
  });

  it("returns null for a USER-AUTHORED component whose srcText is only a usage snippet (#2828)", () => {
    // The common case: the store record carries a usage snippet (`@/` import + `…` placeholder), which
    // is NOT a runnable module → honest empty state, not a doomed build.
    const snippet: ComponentRecord = {
      ...base, id: "gx", name: "GraphExplorerPage", kitId: "user-kit", src: "user/pages/GraphExplorerPage.tsx",
      source: undefined,
      srcText: 'import { GraphExplorerPage } from "@/shared/ui/pages/GraphExplorerPage";\n\n<GraphExplorerPage nodes={…} />',
    };
    expect(componentPreviewFiles(snippet, ARTIFACT)).toBeNull();
  });
});

describe("componentPreviewFiles — sibling vendoring (#3112)", () => {
  const chartFrame: ComponentRecord = {
    ...base, id: "chartframe", name: "ChartFrame", kitId: "react-d3", role: "layout", src: "react-d3/ChartFrame.tsx",
    source: undefined,
    srcText: 'import type { ReactNode } from "react";\nexport function ChartFrame({ children }: { children?: ReactNode }) { return children ?? null; }',
  };
  const axis: ComponentRecord = {
    ...base, id: "axis", name: "Axis", kitId: "react-d3", role: "primitive", src: "react-d3/Axis.tsx",
    source: undefined, srcText: "export function Axis() { return null; }",
  };
  const barChart: ComponentRecord = {
    ...base, id: "barchart", name: "BarChart", kitId: "react-d3", role: "composite", composes: ["ChartFrame"],
    src: "react-d3/BarChart.tsx", source: undefined,
    srcText: 'import * as d3 from "d3";\nimport { ChartFrame } from "@/react-d3/ChartFrame";\nexport function BarChart() { void d3; return <ChartFrame/>; }',
  };

  it("vendors an imported sibling into the build so a user-kit component composes for real", () => {
    const build = componentPreviewFiles(barChart, ARTIFACT, [chartFrame, axis])!;
    expect(build).not.toBeNull();
    expect(build.files["react-d3/BarChart.tsx"]).toContain("export function BarChart");
    expect(build.files["react-d3/ChartFrame.tsx"]).toContain("export function ChartFrame"); // the imported sibling
    expect(build.files["react-d3/Axis.tsx"]).toBeUndefined(); // NOT imported → not vendored (lean closure)
    expect(build.files[PREVIEW_ENTRY]).toContain('import * as __mod from "@/react-d3/BarChart"');
  });

  it("vendors the TRANSITIVE closure — a sibling the imported sibling imports", () => {
    const frameWithAxis: ComponentRecord = {
      ...chartFrame,
      srcText: 'import { Axis } from "@/react-d3/Axis";\nexport function ChartFrame() { return <Axis/>; }',
    };
    const build = componentPreviewFiles(barChart, ARTIFACT, [frameWithAxis, axis])!;
    expect(build.files["react-d3/ChartFrame.tsx"]).toBeDefined();
    expect(build.files["react-d3/Axis.tsx"]).toContain("export function Axis"); // pulled in transitively
  });

  it("returns null WITHOUT siblings (no closure to resolve the @/ import — the pre-#3112 behavior)", () => {
    expect(componentPreviewFiles(barChart, ARTIFACT)).toBeNull();
  });

  it("returns null when an internal import resolves to NO sibling (honest empty state)", () => {
    const dangling: ComponentRecord = {
      ...base, id: "x", name: "X", kitId: "react-d3", src: "react-d3/X.tsx", source: undefined,
      srcText: 'import { Nope } from "@/react-d3/Nope";\nexport function X() { return null; }',
    };
    expect(componentPreviewFiles(dangling, ARTIFACT, [chartFrame, axis])).toBeNull();
  });
});

// The DECLARED BOUNDARY, preview side. The doctor has always exempted a registered platform module; the
// preview never did, so it REFUSED to build components the doctor called healthy — and `navigate` then
// acked a mount that never happened, which is what made it read as a stale cache. `@/store` and
// `@/shared/ui/layout/Stack` are registered in `platform-modules.json`; `@/react-d3/Nope` is not.
describe("componentPreviewFiles — the declared boundary (#3897)", () => {
  const importer = (spec: string): ComponentRecord => ({
    ...base, id: "x", name: "X", kitId: "react-d3", src: "react-d3/X.tsx", source: undefined,
    srcText: `import { useAppStore } from "${spec}";\nexport function X() { void useAppStore; return null; }`,
  });

  it("BUILDS a component importing a registered platform module — the preview stubs it", () => {
    const build = componentPreviewFiles(importer("@/store"), ARTIFACT);
    expect(build).not.toBeNull();
    // Not vendored: the stub is supplied by the bundler's resolver, so nothing is added to `files`.
    expect(Object.keys(build!.files)).not.toContain("store.tsx");
  });

  it("still returns null for an UNregistered @/ sibling that nothing vendors", () => {
    expect(componentPreviewFiles(importer("@/react-d3/Nope"), ARTIFACT)).toBeNull();
  });

  it("keeps componentBuildable in lockstep with it (both arms)", () => {
    expect(componentBuildable(importer("@/store"), ARTIFACT)).toBe(true);
    expect(componentBuildable(importer("@/react-d3/Nope"), ARTIFACT)).toBe(false);
  });

  it("resolves a registered module the artifact DOES vendor from its real source, not a stub", () => {
    // `@/shared/lib/core/format` is registered AND in the artifact's runtime closure — real source wins.
    const build = componentPreviewFiles(base, ARTIFACT)!;
    expect(build.files["shared/lib/core/format.ts"]).toContain("export const fmt");
  });
});

describe("componentPreviewFiles — graph-source provides + artifact resolution (#43)", () => {
  it("a graph-source component importing an artifact util + a provides-sibling BUILDS (not no-implementation)", () => {
    // Box provides `@/shared/ui/layout/Box` and imports an artifact RUNTIME util (`@/shared/lib/core/format`)
    // AND a sibling it provides (`@/shared/ui/feedback/Skeleton`). Before #43 the user-authored path didn't
    // seed the artifact runtime and ignored `provides`, so this returned null (a false no-implementation).
    const box: ComponentRecord = { ...base, id: "box", name: "Box", provides: "@/shared/ui/layout/Box",
      src: "src/shared/ui/layout/Box.tsx",
      srcText: 'import { fmt } from "@/shared/lib/core/format";\nimport { Sk } from "@/shared/ui/feedback/Skeleton";\nexport function Box(){ return fmt || Sk ? null : null; }' };
    const sk: ComponentRecord = { ...base, id: "sk", name: "Sk", provides: "@/shared/ui/feedback/Skeleton",
      src: "src/shared/ui/feedback/Skeleton.tsx", srcText: "export function Sk(){ return null; }" };
    const build = componentPreviewFiles(box, ARTIFACT, [box, sk]);
    expect(build).not.toBeNull();
    expect(build!.files["shared/lib/core/format.ts"]).toBeTruthy();          // artifact runtime vendored → @/ util resolves
    expect(build!.files["shared/ui/feedback/Skeleton.tsx"]).toContain("Sk"); // provides-sibling vendored (graph-first) → @/ resolves
  });

  it("still returns null when an internal import resolves to NOTHING (honest no-implementation)", () => {
    const bad: ComponentRecord = { ...base, id: "bad", name: "Bad", src: "user/Bad.tsx",
      srcText: 'import { Nope } from "@/shared/ui/does/not/Exist";\nexport function Bad(){ return null; }' };
    expect(componentPreviewFiles(bad, ARTIFACT, [bad])).toBeNull();
  });
});

describe("componentPreviewFiles — library (algorithm) vendoring (#3116)", () => {
  // A FAKE resolver (kept pure — no algorithms store): resolve exactly the fibonacci reference.
  const FIB = "export function fibonacci(n: number): number { return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2); }";
  const libResolver = (spec: string) =>
    spec === "@bsc/algorithms/fibonacci" ? { path: "@bsc/algorithms/fibonacci.ts", source: FIB } : null;

  const fibComp: ComponentRecord = {
    ...base, id: "fib", name: "FibCard", kitId: "user-kit", src: "user/FibCard.tsx", source: undefined,
    srcText: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function FibCard() { return <div>{fibonacci(10)}</div>; }',
  };

  it("vendors the algorithm's code as a module the @bsc import resolves to", () => {
    const build = componentPreviewFiles(fibComp, ARTIFACT, [], libResolver)!;
    expect(build).not.toBeNull();
    // The component's own module is present, AND the library impl is vendored under the resolved path.
    expect(build.files["user/FibCard.tsx"]).toContain("export function FibCard");
    expect(build.files["@bsc/algorithms/fibonacci.ts"]).toBe(FIB); // the ONE source of truth — no inline copy
    expect(build.files[PREVIEW_ENTRY]).toContain('import * as __mod from "@/user/FibCard"');
  });

  it("does NOT vendor when the reference doesn't resolve (the honest build failure)", () => {
    const bad: ComponentRecord = {
      ...fibComp, id: "bad", name: "Bad",
      srcText: 'import { nope } from "@bsc/algorithms/nope";\nexport function Bad() { return nope(); }',
    };
    const build = componentPreviewFiles(bad, ARTIFACT, [], libResolver)!;
    // Still buildable (a `@bsc/…` import is blind to buildability, like a bare npm import), but the missing
    // module is NOT vendored → the bundler will throw "module not found" (graphHealth flags it separately).
    expect(build).not.toBeNull();
    expect(Object.keys(build.files).some((k) => k.startsWith("@bsc/"))).toBe(false);
  });

  it("is byte-identical to the pre-#3116 build for a component with NO library import", () => {
    const plain: ComponentRecord = {
      ...base, id: "d3", name: "D3", kitId: "user-kit", src: "user/D3.tsx", source: undefined,
      srcText: 'import * as d3 from "d3";\nexport function D3() { void d3; return null; }',
    };
    const withResolver = componentPreviewFiles(plain, ARTIFACT, [], libResolver)!;
    const without = componentPreviewFiles(plain, ARTIFACT, [])!;
    expect(withResolver.files).toEqual(without.files);
  });
});

describe("isPreviewBuildable (#3112)", () => {
  const resolves = (spec: string) => spec === "@/react-d3/ChartFrame";
  it("allows an internal import that resolves to a sibling", () => {
    expect(isPreviewBuildable('import { ChartFrame } from "@/react-d3/ChartFrame";\nexport function F() {}', "f.tsx", resolves)).toBe(true);
  });
  it("rejects an internal import that resolves to nothing, and the usual non-modules", () => {
    expect(isPreviewBuildable('import { Nope } from "@/react-d3/Nope";\nexport function F() {}', "f.tsx", resolves)).toBe(false);
    expect(isPreviewBuildable("const x = 1;", "f.tsx", resolves)).toBe(false); // no export
    expect(isPreviewBuildable("export function F() { return <X>…</X>; }", "f.tsx", resolves)).toBe(false); // `…` placeholder
  });
  it("allows a bare-library-only module (no internal imports)", () => {
    expect(isPreviewBuildable('import * as d3 from "d3";\nexport function F() {}', "f.tsx", () => false)).toBe(true);
  });
});

describe("erasedSpecs — type-only imports are dropped before resolution (#4076)", () => {
  it("names both erasable spellings and nothing that survives the loader", () => {
    const e = erasedSpecs(
      [
        'import type { P } from "./a";',
        'import { type Q, type R } from "./b";',
        'import type * as N from "./c";',
        'export type { T } from "./k";',
        'import { run } from "./d";',
        'import { go, type S } from "./e";',
        'import Def from "./f";',
        'import * as All from "./g";',
        'import "./h";',
        'import { typeGuard } from "./i";',
        'import {} from "./j";',
      ].join("\n"),
    );
    for (const erased of ["./a", "./b", "./c", "./k"]) expect(e.has(erased)).toBe(true);
    // A mixed clause, a default/namespace binding, a side-effect import, a `typeGuard` VALUE binding and
    // an empty clause all survive the loader, so each stays a real dependency.
    for (const kept of ["./d", "./e", "./f", "./g", "./h", "./i", "./j"]) expect(e.has(kept)).toBe(false);
  });

  it("does not erase a specifier that is ALSO imported as a value", () => {
    expect(erasedSpecs('import type { P } from "./x";\nimport { run } from "./x";').has("./x")).toBe(false);
  });

  it("makes a component whose only unresolved import is type-only preview-buildable", () => {
    // The pair that must not drift: harvest stopped counting erased imports, so the preview predicate
    // agrees — otherwise doctor reports a no-implementation the preview renders happily (#3486).
    const never = () => false;
    expect(isPreviewBuildable('import type { P } from "@/gone/types";\nexport const A = () => null;', "src/A.tsx", never)).toBe(true);
    expect(isPreviewBuildable('import { P } from "@/gone/types";\nexport const A = () => null;', "src/A.tsx", never)).toBe(false);
  });
});

describe("looksBuildableModule (#2828)", () => {
  it("accepts a self-contained module (has an export, no `@/` import, no `…` placeholder)", () => {
    expect(looksBuildableModule('import * as d3 from "d3";\nexport function Foo() { return null; }')).toBe(true);
    expect(looksBuildableModule("export default function Foo() { return null; }")).toBe(true);
  });

  it("rejects a usage snippet, an empty string, and a module with no export", () => {
    expect(looksBuildableModule("")).toBe(false);
    expect(looksBuildableModule(undefined)).toBe(false);
    // `@/` first-party import — no closure to resolve it against.
    expect(looksBuildableModule('import { Card } from "@/shared/ui/data/Card";\nexport function X() {}')).toBe(false);
    // `…` placeholder — won't compile.
    expect(looksBuildableModule("export function X() { return <Card>…</Card>; }")).toBe(false);
    // No export — nothing for the bootstrap to import + mount.
    expect(looksBuildableModule("const x = 1;")).toBe(false);
  });
});

describe("bootstrapSource (#2824)", () => {
  it("renders required props from the schema + children, resolving the named-or-default export", () => {
    const comp: ComponentRecord = {
      ...base, name: "StatTile",
      props: [prop("k", "ReactNode", true), prop("v", "ReactNode", true), prop("onClick", "() => void"), prop("children", "ReactNode")],
    };
    const src = bootstrapSource(comp, "@/x/StatTile");
    expect(src).toContain('__mod["StatTile"] ?? __mod.default');
    expect(src).toContain('"k":');       // node prop → a placeholder string
    expect(src).toContain("() => {}");   // function prop → a noop
    expect(src).toContain("createElement(__C,");
  });

  it("mounts into a definite-height, border-box wrapper so oversized media can be capped (#2915)", () => {
    const src = bootstrapSource(base, "@/x/Card");
    expect(src).toContain('height: "100%"');        // definite height (not minHeight) → max-height:100% resolves
    expect(src).toContain('boxSizing: "border-box"'); // padding stays inside the frame
    expect(src).not.toContain('minHeight: "100%"');   // the old min-height didn't give a resolvable cap
  });
});

describe("samplePropValue (#2824)", () => {
  it("maps schema types to plausible literals", () => {
    expect(samplePropValue(prop("label", "string"))).toBe('"Label"');
    expect(samplePropValue(prop("count", "number"))).toBe("3");
    expect(samplePropValue(prop("value", "number"))).toBe("0.6"); // ratio-ish → a fraction
    expect(samplePropValue(prop("open", "boolean"))).toBe("true");
    expect(samplePropValue(prop("onClick", "() => void"))).toBe("() => {}");
    expect(samplePropValue(prop("rows", "Row[]"))).toBeNull(); // optional collection → omitted in loaded (#3135)
    // #3693: a required collection omits in loaded too — but ONLY when the component defaults it, which is
    // what the third argument carries. Without a default it is supplied, or the component mounts undefined.
    expect(samplePropValue(prop("rows", "Row[]", true), "loaded", true)).toBeNull();
    expect(samplePropValue(prop("rows", "Row[]", true), "loaded", false)).toBe("[]");
    expect(samplePropValue(prop("tone", '"neutral" | "danger"'))).toBe('"neutral"');
    expect(samplePropValue(prop("color", "string"))).toBe('"var(--accent)"');
  });

  it("treats Record / Set / Map as data containers, not strings (#3693)", () => {
    // A Record<string, number> / Set<string> type STRING contains "string"/"number"; without a container
    // check it fell through to the string branch → a title-cased string (NaN nonsense, or `.has()` crash).
    expect(samplePropValue(prop("langTotals", "Record<string, number>", true), "loaded", true)).toBeNull(); // defaulted → omitted in loaded
    expect(samplePropValue(prop("langTotals", "Record<string, number>", true), "empty")).toBe("{}");
    expect(samplePropValue(prop("highlight", "Set<string>"))).toBeNull();
    expect(samplePropValue(prop("highlight", "Set<string>"), "empty")).toBe("new Set()");
    expect(samplePropValue(prop("byId", "Map<string, Row>"), "empty")).toBe("new Map()");
    // word-boundary: `offset` is a number, not a Set; `dataset` prop name is not a Set type either.
    expect(samplePropValue(prop("offset", "number"))).toBe("3");
  });

  it("gives a layout-column width a fixed px, not the viewport (#3693)", () => {
    // A flex:none sidebar sized to window.innerWidth eats the whole preview frame — a rail/aside width is 240.
    expect(samplePropValue(prop("railWidth", "number"))).toBe("240");
    expect(samplePropValue(prop("asideWidth", "number"))).toBe("240");
    expect(samplePropValue(prop("sidebarHeight", "number"))).toBe("240");
    // a canvas width still fills the frame; a style-dim width stays small.
    expect(samplePropValue(prop("chartWidth", "number"))).toBe("window.innerWidth");
    expect(samplePropValue(prop("strokeWidth", "number"))).toBe("3");
  });

  it("samples canvas-dimension props with the frame size so a sized component fills the frame (#2918)", () => {
    // width/height/size drive a component's rendered size → the actual iframe viewport, not a 3px stub.
    expect(samplePropValue(prop("width", "number"))).toBe("window.innerWidth");
    expect(samplePropValue(prop("chartWidth", "number"))).toBe("window.innerWidth");
    expect(samplePropValue(prop("w", "number"))).toBe("window.innerWidth");
    expect(samplePropValue(prop("height", "number"))).toBe("window.innerHeight");
    expect(samplePropValue(prop("svgHeight", "number"))).toBe("window.innerHeight");
    expect(samplePropValue(prop("h", "number"))).toBe("window.innerHeight");
    expect(samplePropValue(prop("size", "number"))).toBe("Math.min(window.innerWidth, window.innerHeight)");
  });

  it("keeps STYLE dimensions and non-dimension numbers small (not the viewport) (#2918)", () => {
    // strokeWidth/borderWidth/fontSize are style sizes, not canvas sizes — they must stay small.
    expect(samplePropValue(prop("strokeWidth", "number"))).toBe("3");
    expect(samplePropValue(prop("borderWidth", "number"))).toBe("3");
    expect(samplePropValue(prop("fontSize", "number"))).toBe("3");
    expect(samplePropValue(prop("lineWidth", "number"))).toBe("3");
    // a plain count is unchanged
    expect(samplePropValue(prop("columns", "number"))).toBe("3");
  });

  it("samples per DATA-STATE — loaded / empty / loading (#3135)", () => {
    const data = prop("data", "Datum[]"); // optional collection
    const loading = prop("loading", "boolean");
    // loaded: optional collection OMITTED (→ demo via undefined), loading OFF (fixes the always-skeleton quirk).
    expect(samplePropValue(data, "loaded")).toBeNull();
    expect(samplePropValue(loading, "loaded")).toBeNull();
    // empty: explicit [] for the collection, loading still off.
    expect(samplePropValue(data, "empty")).toBe("[]");
    expect(samplePropValue(loading, "empty")).toBeNull();
    // loading: the loading-family boolean turns ON; the collection stays omitted (demo layout under the skeleton).
    expect(samplePropValue(loading, "loading")).toBe("true");
    expect(samplePropValue(data, "loading")).toBeNull();
    // a non-loading boolean is unaffected by state (always true).
    expect(samplePropValue(prop("stacked", "boolean"), "loading")).toBe("true");
    // #3693: a REQUIRED collection the component DEFAULTS omits in loaded/loading (that default demo shows),
    // `[]` only in empty — so 'loaded' no longer renders identical to 'empty' for a required-data component.
    const rows = prop("rows", "Row[]", true);
    expect(samplePropValue(rows, "loaded", true)).toBeNull();
    expect(samplePropValue(rows, "loading", true)).toBeNull();
    expect(samplePropValue(rows, "empty", true)).toBe("[]");
    // With NO default it is supplied in every state instead: omitting it mounts the component with
    // `undefined` where its contract promised a value, and it throws on its first unguarded read.
    expect(samplePropValue(rows, "loaded")).toBe("[]");
    expect(samplePropValue(rows, "loading")).toBe("[]");
    expect(samplePropValue(rows, "empty")).toBe("[]");
  });

  it("drives an ERROR-family prop only in the error state (#3555)", () => {
    const errStr = prop("error", "string"), errBool = prop("hasError", "boolean");
    // error state: a string error → a message; a boolean error → true.
    expect(samplePropValue(errStr, "error")).toBe('"Something went wrong"');
    expect(samplePropValue(errBool, "error")).toBe("true");
    // every other state omits it, so the component renders normally.
    for (const s of ["loaded", "empty", "loading"] as const) {
      expect(samplePropValue(errStr, s)).toBeNull();
      expect(samplePropValue(errBool, s)).toBeNull();
    }
    // `onError` is a callback, NOT an error state prop.
    expect(isErrorProp(prop("onError", "() => void"))).toBe(false);
    expect(samplePropValue(prop("onError", "() => void"), "error")).toBe("() => {}");
  });
});

describe("supportedStates / previewCycleStates (#3555)", () => {
  const mk = (props: PropSpec[]): ComponentRecord => ({ ...base, props });

  it("a plain component supports only `loaded` — no state tabs, nothing to cycle", () => {
    const btn = mk([prop("label", "string"), prop("onClick", "() => void")]);
    expect(supportedStates(btn)).toEqual(["loaded"]);
    expect(previewCycleStates(btn)).toEqual(["loaded"]);
  });

  it("detects each state from its prop, in natural order (loading → loaded → empty → error)", () => {
    const full = mk([prop("loading", "boolean"), prop("rows", "Row[]"), prop("error", "string")]);
    expect(supportedStates(full)).toEqual(["loading", "loaded", "empty", "error"]);
    // a data component with no loading/error prop → just loaded + empty.
    expect(supportedStates(mk([prop("rows", "Row[]")]))).toEqual(["loaded", "empty"]);
    // loading-only → loading + loaded.
    expect(supportedStates(mk([prop("busy", "boolean")]))).toEqual(["loading", "loaded"]);
  });

  it("the auto-cycle drops empty but keeps loading/loaded/error", () => {
    const full = mk([prop("loading", "boolean"), prop("rows", "Row[]"), prop("error", "string")]);
    expect(previewCycleStates(full)).toEqual(["loading", "loaded", "error"]);
    // a data-only component's cycle is just loaded (empty dropped → nothing else to show).
    expect(previewCycleStates(mk([prop("rows", "Row[]")]))).toEqual(["loaded"]);
  });
});

describe("bootstrapSource — data-state threads to the sampled props (#3135)", () => {
  const chart: ComponentRecord = {
    ...base, name: "Chart", props: [prop("data", "Datum[]"), prop("loading", "boolean")],
  };
  it("loaded omits data + loading; empty passes data={[]}; loading passes loading={true}", () => {
    expect(bootstrapSource(chart, "@/x/Chart", "loaded")).not.toContain('"data"');
    expect(bootstrapSource(chart, "@/x/Chart", "loaded")).not.toContain('"loading"');
    expect(bootstrapSource(chart, "@/x/Chart", "empty")).toContain('"data": []');
    expect(bootstrapSource(chart, "@/x/Chart", "loading")).toContain('"loading": true');
  });

  it("with liveStates, embeds EVERY state's props once + a `__state` re-render handler (#3567)", () => {
    const src = bootstrapSource(chart, "@/x/Chart", "loaded", {}, ["loading", "loaded", "empty"]);
    // every state's props are in the __STATES map …
    expect(src).toContain("const __STATES = {");
    expect(src).toContain('"loading": {'); // loading state's props
    expect(src).toContain('"loaded": {');
    expect(src).toContain('"empty": {');
    expect(src).toContain('"data": []'); // the empty state's collection, embedded alongside the others
    // … one root, switched by a message, not rebuilt.
    expect(src).toContain('let __state = "loaded"'); // opens on the requested initial state
    expect(src).toContain("createRoot(document.getElementById(\"root\"))");
    expect(src).toContain("e.data && e.data.__state"); // the live-switch handler
    expect(src).toContain("__STATES[__state]");
    // a single root (not one per state) — the whole point is no rebuild/remount.
    expect(src.match(/createRoot\(/g)?.length).toBe(1);
  });

  it("without liveStates, the single-state entry is byte-unchanged (the scan's path) (#3567)", () => {
    const single = bootstrapSource(chart, "@/x/Chart", "loading");
    expect(single).not.toContain("__STATES");
    expect(single).not.toContain("__state");
    expect(single).toContain('"loading": true'); // just the one state, inline
  });
});

describe("bootstrapSource — role-aware mount wrapper (#3139)", () => {
  it("a page/layout mounts full-bleed top-left (no centering); a component stays centered", () => {
    const pageSrc = bootstrapSource({ ...base, name: "DashboardPage", role: "page" }, "@/x/DashboardPage");
    expect(pageSrc).toContain('overflow: "hidden"'); // full-bleed page wrapper
    expect(pageSrc).not.toContain("justifyContent"); // not centered — its header sits at the top
    const layoutSrc = bootstrapSource({ ...base, name: "MasterDetail", role: "layout" }, "@/x/MasterDetail");
    expect(layoutSrc).not.toContain("justifyContent");
    const compSrc = bootstrapSource({ ...base, name: "Chip", role: "primitive" }, "@/x/Chip");
    expect(compSrc).toContain('justifyContent: "center"'); // a component reads best centered
  });
});

describe("hasCodeElision — an ellipsis in COPY is not an elision marker (#3486)", () => {
  // The scanner is the TS twin of Rust `has_code_elision`. Before #3486 both `looksBuildableModule`
  // and `isPreviewBuildable` used a plain substring test, so a component whose only ellipsis was UI
  // copy was ACCEPTED by the Rust write gate and then REFUSED by the preview — and reported as
  // `no-implementation` by doctor. Measured at 13 of 93 over this repo's own `src/shared/ui`.
  const E = String.fromCodePoint(0x2026);

  it("elisionMarkerIsU2026 — the marker survived this file's encoding", () => {
    // Guards the one thing a cp1252 round-trip would silently break: if the literal in
    // componentPreview.ts is ever re-encoded, the scanner stops matching and reports EVERY source as
    // clean — a no-op that no other test would notice, because "clean" is the passing direction.
    expect(hasCodeElision(`const x = ${E}`)).toBe(true);
  });

  it("finds a marker standing in for omitted code", () => {
    expect(hasCodeElision(`export function F() { ${E} }`)).toBe(true);
  });

  it("ignores one in JSX TEXT — the #3897 false positive (unquoted, so the string-skip misses it)", () => {
    // ProjectsPage was condemned as "a sketch, not compilable code" over three UI labels like this,
    // while the runtime mounted it fine. JSX text is not a string literal, so the quote-skip never saw it.
    expect(hasCodeElision(`export function F(){ return <p>Loading projects${E}</p>; }`)).toBe(false);
    expect(hasCodeElision(`export const s = <b>syncing${E}</b>;`)).toBe(false);
    // …and a marker in CODE position is still caught, including after a newline.
    expect(hasCodeElision(`export function F(){\n  ${E}\n}`)).toBe(true);
  });

  it("ignores one inside a string literal — the measured false positive", () => {
    expect(hasCodeElision(`<input placeholder="Select${E}" />`)).toBe(false);
    expect(hasCodeElision(`const s = 'Loading${E}'`)).toBe(false);
  });

  it("ignores one inside a template literal", () => {
    expect(hasCodeElision("const s = `Saving" + E + "`")).toBe(false);
  });

  it("ignores one in a line or block comment", () => {
    expect(hasCodeElision(`// prose with an ellipsis ${E}\nconst a = 1;`)).toBe(false);
    expect(hasCodeElision(`/* doc prose ${E} */ const a = 1;`)).toBe(false);
  });

  it("does not let an ESCAPED quote end a literal and expose the copy inside", () => {
    // If the backslash branch were missing, the `\"` would close the string early and the ellipsis
    // after it would read as code — a false positive that only shows up on escaped copy.
    expect(hasCodeElision(`const s = "a \\" quote then ${E}";`)).toBe(false);
  });

  it("still finds a marker AFTER a string that contains one", () => {
    // The scanner must resume scanning as code once the literal closes, or a component could hide a
    // real elision behind any earlier piece of copy.
    expect(hasCodeElision(`const s = "Select${E}"; export function F() { ${E} }`)).toBe(true);
  });

  it("ignores one after a closing JSX tag or HTML entity — designer request #125", () => {
    // Both fixtures are the ACTUAL srcText of live, working components — `bsc navigate` confirmed both
    // render fine, yet `bsc ui doctor` flagged them `no-implementation` over this "code-elision marker".

    // ConnectGithubCard: a third sibling text node continuing a message after an interpolated <Text>
    // element. The char immediately before the marker (skipping whitespace) is `>` from `</Text>`, a
    // CLOSING tag — a message continuing after a sibling closed, not an element's sole content.
    expect(
      hasCodeElision(
        `export function ConnectGithubCard(){ return <Box>Waiting for authorization at <Text>{url}</Text>\n${E}\n</Box>; }`
      )
    ).toBe(false);

    // WorkspaceCard: a truncated path example inside <code>, HTML-entity-heavy. The char immediately
    // before the marker is `/`, ordinary running-text punctuation, not a fresh element's sole content.
    expect(
      hasCodeElision(`export function WorkspaceCard(){ return <code>&lt;base&gt;/projects/&lt;project&gt;/${E}</code>; }`)
    ).toBe(false);

    // A self-closing sibling before the marker reads the same way as an explicit closing tag.
    expect(hasCodeElision(`export function A(){ return <Box><Icon />${E}</Box>; }`)).toBe(false);

    // …and the #3897 case is UNCHANGED: a marker as an element's ONLY content, right after its OPENING
    // tag, is still a sketch — this must not regress into blanket JSX leniency.
    expect(hasCodeElision(`export function X() { return <Card>${E}</Card>; }`)).toBe(true);
  });
});

describe("the buildability predicates use the context-aware scanner (#3486)", () => {
  const E = String.fromCodePoint(0x2026);
  const withCopy = `export function F() { return <input placeholder="Select${E}" />; }`;
  const withElision = `export function F() { ${E} }`;

  it("looksBuildableModule accepts a module whose only ellipsis is placeholder copy", () => {
    expect(looksBuildableModule(withCopy)).toBe(true);
  });

  it("looksBuildableModule still rejects a real code elision", () => {
    expect(looksBuildableModule(withElision)).toBe(false);
  });

  it("isPreviewBuildable accepts the same copy-only module", () => {
    expect(isPreviewBuildable(withCopy, "shared/ui/data/Card.tsx", () => true)).toBe(true);
  });

  it("isPreviewBuildable still rejects a real code elision", () => {
    expect(isPreviewBuildable(withElision, "shared/ui/data/Card.tsx", () => true)).toBe(false);
  });
});

describe("componentPreviewFiles — a specifier an ALGORITHMS record provides (#83)", () => {
  // THE REPORTED SHAPE. DetachedWindow imports named exports from a module whose FILE was retired when
  // an algorithms record superseded it (#82), so the preview had no source for it and every named
  // import failed with `No matching export in mem:src/app/lazyWorkspaces`. The preview built its
  // `provides` map from COMPONENT records only; the runtime resolver has read the algorithms store
  // since `resolver-reads-the-algorithms-store`.
  const artifact: KitArtifact = { components: [], runtime: {} };

  // Built from the file's own `base` record so every required field is real. An `as ComponentRecord`
  // cast hid a missing `props` here, and the failure surfaced as `Cannot read properties of undefined
  // (reading 'some')` deep inside `previewChild` — a cast is not a fixture.
  const consumer: ComponentRecord = {
    ...base,
    id: "detached-window",
    name: "DetachedWindow",
    src: "app/DetachedWindow.tsx",
    props: [],
    srcText:
      'import { GitHubWorkspace, SkillsWorkspace } from "@/app/lazyWorkspaces";\n' +
      "export function DetachedWindow() {\n" +
      "  return <div><GitHubWorkspace /><SkillsWorkspace /></div>;\n" +
      "}\n",
  };

  /** The algorithms record that provides the retired module — `code`, keyed by its `provides`. */
  const graphResolver = (spec: string) =>
    spec === "@/app/lazyWorkspaces"
      ? {
          path: "app/lazyWorkspaces.ts",
          source:
            "export const GitHubWorkspace = () => null;\n" +
            "export const SkillsWorkspace = () => null;\n",
        }
      : null;

  it("vendors the module so its named exports resolve", () => {
    const build = componentPreviewFiles(
      consumer, artifact, [], undefined, "loaded", {}, undefined, graphResolver,
    );
    expect(build, "the component builds at all").not.toBeNull();
    // The module is present at the mem path the `@/…` branch resolves to…
    expect(build!.files["app/lazyWorkspaces.ts"]).toContain("GitHubWorkspace");
    // …and both named exports it imports are in that source, which is what "No matching export" meant.
    expect(build!.files["app/lazyWorkspaces.ts"]).toContain("SkillsWorkspace");
  });

  it("without the resolver the module is absent — the bug, pinned", () => {
    const build = componentPreviewFiles(consumer, artifact, [], undefined, "loaded", {}, undefined, undefined);
    // It still "builds" a file set — which is exactly why this failed at esbuild rather than earlier.
    expect(build?.files["app/lazyWorkspaces.ts"]).toBeUndefined();
  });

  it("vendors TRANSITIVELY — a graph module's own first-party imports resolve too", () => {
    const chained = (spec: string) =>
      spec === "@/app/lazyWorkspaces"
        ? { path: "app/lazyWorkspaces.ts", source: 'export { helper as GitHubWorkspace } from "@/app/deep/helper";\nexport const SkillsWorkspace = () => null;\n' }
        : spec === "@/app/deep/helper"
          ? { path: "app/deep/helper.ts", source: "export const helper = () => null;\n" }
          : null;
    const build = componentPreviewFiles(consumer, artifact, [], undefined, "loaded", {}, undefined, chained);
    expect(build!.files["app/deep/helper.ts"], "stopping at depth one trades one build error for another")
      .toContain("helper");
  });

  it("a COMPONENT record's provides still wins for the same specifier", () => {
    const sibling: ComponentRecord = {
      ...base,
      id: "lazy-workspaces-component",
      name: "LazyWorkspaces",
      src: "app/lazyWorkspaces.tsx",
      props: [],
      provides: "@/app/lazyWorkspaces",
      srcText: "export const GitHubWorkspace = () => null; // FROM THE COMPONENT STORE\nexport const SkillsWorkspace = () => null;\n",
      source: "export const GitHubWorkspace = () => null; // FROM THE COMPONENT STORE\nexport const SkillsWorkspace = () => null;\n",
    } as ComponentRecord;
    const build = componentPreviewFiles(
      consumer, artifact, [sibling], undefined, "loaded", {}, undefined, graphResolver,
    );
    const vendored = Object.entries(build!.files).find(([k]) => k.startsWith("app/lazyWorkspaces"));
    expect(vendored?.[1], "the component store keeps precedence").toContain("FROM THE COMPONENT STORE");
  });

  it("componentBuildable agrees with what the files step can vendor", () => {
    // Without the resolver the only unresolved import makes it unbuildable; with it, buildable. A
    // disagreement here means a component is never previewed at all rather than previewed broken.
    expect(componentBuildable(consumer, artifact, [], undefined)).toBe(false);
    expect(componentBuildable(consumer, artifact, [], graphResolver)).toBe(true);
  });
});

describe("makeGraphProvidesResolver — the producer #83 specified and never had", () => {
  const IMPLS = [
    { provides: "@/app/lazyWorkspaces", code: "export const WorkspaceFallback = () => null;" },
    { provides: "  @/app/spaced  ", code: "export const S = 1;" },
    { provides: "@/app/empty", code: "   " },
    { provides: "", code: "export const X = 1;" },
    { provides: "@/app/lazyWorkspaces", code: "export const LATER = 2;" },
  ];

  it("resolves a specifier an algorithms record provides, keyed the way providesMod is", () => {
    const r = makeGraphProvidesResolver(IMPLS);
    expect(r("@/app/lazyWorkspaces")).toEqual({
      path: "app/lazyWorkspaces.tsx",
      source: "export const WorkspaceFallback = () => null;",
    });
    expect(r("@/app/spaced")?.path).toBe("app/spaced.tsx");
  });

  it("answers null for anything it cannot honestly serve", () => {
    const r = makeGraphProvidesResolver(IMPLS);
    expect(r("@/app/empty")).toBeNull();       // a record with no code is not an implementation
    expect(r("@/app/unknown")).toBeNull();
    expect(r("react")).toBeNull();             // not first-party; the bundler externalises it
    expect(makeGraphProvidesResolver([])("@/app/lazyWorkspaces")).toBeNull();
  });

  it("keeps the FIRST record for a duplicated specifier, deterministically", () => {
    // Two impls claiming one specifier is a defect elsewhere; picking at random would make the preview
    // differ run to run, which is the worst way to find out.
    expect(makeGraphProvidesResolver(IMPLS)("@/app/lazyWorkspaces")?.source).toContain("WorkspaceFallback");
  });

  it("makes the gate and the bundler AGREE about a graph-provided import", () => {
    // The bug: `detachedwindow` imports `@/app/lazyWorkspaces`, the impl record provides it, and the
    // gate judged it unbuildable — so it was refused a preview and doctor reported no-implementation
    // for a specifier that resolves. Both sides must now say the same thing.
    const comp = {
      id: "consumer", name: "Consumer", kitId: "k", role: "composite",
      props: [], variants: [], composes: [],
      srcText: 'import { WorkspaceFallback } from "@/app/lazyWorkspaces";\nexport const C = () => <WorkspaceFallback />;',
    } as never;
    const artifact = { components: [], runtime: {} } as unknown as KitArtifact;
    const resolver = makeGraphProvidesResolver(IMPLS);

    expect(componentBuildable(comp, artifact, [], resolver)).toBe(true);
    const built = componentPreviewFiles(comp, artifact, [], undefined, "loaded", {}, undefined, resolver);
    expect(built).not.toBeNull();
    expect(Object.keys(built!.files)).toContain("app/lazyWorkspaces.tsx");
  });
});
