import { describe, it, expect } from "vitest";
import { analyzeGraphHealth, nodeHealth } from "./graphHealth";
import type { ComponentRecord, Role } from "./model";

/** Minimal component fixture — only the fields the analyzer reads matter. Carries a real `source` so
 *  the no-implementation check (#2839) never fires on it and the topology tests stay about topology;
 *  the no-implementation-specific test overrides it with a deliberately source-less spec. */
function comp(name: string, role: Role, used: number, composes: string[] = [], extra: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: name, name, kitId: "k", role, version: "1", used, tags: [], variants: ["default"],
    composes, props: [], whenUse: [], whenNot: [], src: "", srcText: `src-${name}`,
    source: "export const C = () => null;", ...extra,
  };
}

describe("analyzeGraphHealth (#2680, mirrors bsc ui doctor)", () => {
  it("a clean graph has no findings", () => {
    const comps = [comp("Page", "page", 1, ["Card"]), comp("Card", "composite", 3, ["Button"]), comp("Button", "primitive", 9)];
    expect(analyzeGraphHealth(comps)).toEqual([]);
  });

  it("flags an isolated unused primitive as an orphan (and never a used one)", () => {
    const fs = analyzeGraphHealth([comp("Button", "primitive", 5), comp("Ghost", "primitive", 0)]);
    expect(fs.map((f) => f.category)).toEqual(["orphan"]);
    expect(fs[0].nodeNames).toEqual(["Ghost"]);
  });

  it("flags a self-referential stub (renders only itself) but not a real module or a snippet (#3026)", () => {
    const fs = analyzeGraphHealth([
      // a self-call: it has an export (so it's "buildable") and is valid, but the only element it
      // renders is itself. `source: ""` so ownModuleSource reads the srcText; `used: 1` avoids orphan.
      comp("D3Chart", "composite", 1, [], { source: "", srcText: "export function D3Chart(props){ return <D3Chart {...props} />; }" }),
      // a REAL module — renders its own <svg>, never itself: NOT a self-reference.
      comp("Spark", "composite", 2, [], { source: "", srcText: "import { useRef } from 'react';\nexport function Spark(){ const r = useRef(null); return <svg ref={r} />; }" }),
      // a bare usage snippet — no export → no-implementation, never double-flagged self-reference.
      comp("Usage", "composite", 1, [], { source: "", srcText: "<Usage data={[1,2,3]} />" }),
    ]);
    expect(fs.filter((f) => f.category === "self-reference").flatMap((f) => f.nodeNames)).toEqual(["D3Chart"]);
    expect(fs.some((f) => f.nodeNames.includes("Spark"))).toBe(false);
    expect(fs.find((f) => f.nodeNames.includes("Usage"))?.category).toBe("no-implementation");
  });

  it("flags an unused root with deps as a dangling branch (root + reachable)", () => {
    const fs = analyzeGraphHealth([comp("DeadShell", "layout", 0, ["Widget"]), comp("Widget", "composite", 0)]);
    expect(fs.map((f) => f.category)).toEqual(["dangling-branch"]);
    expect(fs[0].nodeNames).toEqual(expect.arrayContaining(["DeadShell", "Widget"]));
  });

  it("flags two components wrapping the same intrinsic as duplicates", () => {
    const fs = analyzeGraphHealth([
      comp("Button", "primitive", 9, [], { wraps: "button" }),
      comp("Btn2", "primitive", 1, [], { wraps: "button" }),
    ]);
    expect(fs.map((f) => f.category)).toEqual(["duplicate"]);
  });

  it("flags a composes cycle at the top severity", () => {
    const fs = analyzeGraphHealth([comp("A", "composite", 1, ["B"]), comp("B", "composite", 1, ["A"])]);
    expect(fs[0].category).toBe("cycle");
    expect(fs[0].severity).toBe(4);
  });

  it("nodeHealth badges each node with its most-severe category", () => {
    const map = nodeHealth([comp("Ghost", "primitive", 0), comp("A", "composite", 1, ["B"]), comp("B", "composite", 1, ["A"])]);
    expect(map.get("Ghost")).toBe("orphan");
    expect(map.get("A")).toBe("cycle");
    expect(map.get("B")).toBe("cycle");
  });

  it("flags a slot-driven composite (composes + a ReactNode slot) as slot-shell, informationally (#2921)", () => {
    // A used page that composes children delivered via a `view` ReactNode slot → previews a demo
    // placeholder standalone. Used>0 so it isn't ALSO a dead-root dangling-branch — isolate slot-shell.
    const page = comp("GraphExplorerPage", "page", 2, ["ForceGraph", "TreeDiagram"], {
      props: [
        { name: "title", type: "string", req: false, desc: "" },
        { name: "view", type: "ReactNode", req: false, desc: "" },
        { name: "inspector", type: "ReactNode", req: false, desc: "" },
      ],
    });
    const fs = analyzeGraphHealth([page]);
    expect(fs.map((f) => f.category)).toEqual(["slot-shell"]);
    expect(fs[0].severity).toBe(1);
    expect(fs[0].why).toContain("ForceGraph, TreeDiagram"); // names the composed children
    expect(fs[0].why).toContain("view, inspector");         // names the slots
  });

  it("does NOT flag slot-shell without a node slot, or with only `children` (#2921)", () => {
    // composes children but no ReactNode content slot → renders its function standalone, not flagged.
    const internal = comp("Toolbar", "composite", 3, ["Button"], { props: [{ name: "label", type: "string", req: false, desc: "" }] });
    // a `children`-only prop is universal, never a slot-shell signal.
    const wrapper = comp("Card", "composite", 3, ["Icon"], { props: [{ name: "children", type: "ReactNode", req: false, desc: "" }] });
    const cats = analyzeGraphHealth([internal, wrapper, comp("Button", "primitive", 9), comp("Icon", "primitive", 9)])
      .map((f) => f.category);
    expect(cats).not.toContain("slot-shell");
  });

  it("flags a component that declares props its source never uses as unwired-prop (#2924)", () => {
    // A used page that reads `title` but ignores its declared `data` + `onRefresh` — a dead interface.
    const stub = comp("Dash", "page", 2, [], {
      source: "export function Dash({ title }){ return <h1>{title}</h1>; }",
      props: [
        { name: "title", type: "string", req: false, desc: "" },
        { name: "data", type: "Row[]", req: false, desc: "" },
        { name: "onRefresh", type: "() => void", req: false, desc: "" },
      ],
    });
    const fs = analyzeGraphHealth([stub]);
    expect(fs.map((f) => f.category)).toEqual(["unwired-prop"]);
    expect(fs[0].severity).toBe(2);
    expect(fs[0].why).toContain("data, onRefresh"); // names the dead props, not `title`
    expect(fs[0].why).not.toContain("title");
  });

  it("does NOT flag unwired-prop when every prop is used, for a spreader, or a built-in/spec (#2924)", () => {
    // all props referenced → wired.
    const wired = comp("Card", "composite", 3, [], {
      source: "export function Card({ title, onClick }){ return <button onClick={onClick}>{title}</button>; }",
      props: [{ name: "title", type: "string", req: false, desc: "" }, { name: "onClick", type: "() => void", req: false, desc: "" }],
    });
    // references NO named prop (a `{...props}` spreader) → conservative skip.
    const spreader = comp("Passthrough", "composite", 3, [], {
      source: "export function Passthrough(props){ return <div {...props} />; }",
      props: [{ name: "title", type: "string", req: false, desc: "" }, { name: "onClick", type: "() => void", req: false, desc: "" }],
    });
    // a built-in/spec with no OWN module source (usage-snippet srcText, no `source`) → skipped.
    const spec = comp("Btn", "primitive", 5, [], {
      source: undefined, srcText: 'import { Btn } from "@/x";\n<Btn label={…} />',
      props: [{ name: "label", type: "string", req: false, desc: "" }],
    });
    const cats = analyzeGraphHealth([wired, spreader, spec]).map((f) => f.category);
    expect(cats).not.toContain("unwired-prop");
  });

  it("flags a user component importing a preview-unresolvable package as unresolvable-import (#2934)", () => {
    // Imports d3-scale (NOT in the preview import-map) alongside react + lucide-react (both pinned).
    const chart = comp("Chart", "composite", 2, [], {
      source: undefined,
      srcText:
        'import React from "react";\nimport { scaleLinear } from "d3-scale";\nimport { Icon } from "lucide-react";\n' +
        "export function Chart(){ return React.createElement(Icon, null, scaleLinear); }",
    });
    const fs = analyzeGraphHealth([chart]);
    const f = fs.find((x) => x.category === "unresolvable-import");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe(3);
    expect(f!.why).toContain("d3-scale"); // not in the map → flagged
    expect(f!.why).not.toContain("`react`"); // react is pinned → resolvable, not listed
    expect(f!.why).not.toContain("`lucide-react`"); // pinned (#2934) → resolvable, not listed
  });

  it("does NOT flag unresolvable-import when every import resolves, or for a non-module snippet (#2934)", () => {
    const ok = comp("Fine", "composite", 2, [], {
      source: undefined,
      srcText: 'import React from "react";\nimport * as d3 from "d3";\nexport function Fine(){ return null; }',
    });
    // a usage-snippet srcText (has `@/`, not a buildable module) is never scanned for imports.
    const snippet = comp("Snip", "primitive", 3, [], { source: undefined, srcText: 'import { Snip } from "@/x";\n<Snip/>' });
    const cats = analyzeGraphHealth([ok, snippet]).map((f) => f.category);
    expect(cats).not.toContain("unresolvable-import");
  });

  it("does NOT flag an absolute URL import (esm.sh) but still flags a bare miss (#2963)", () => {
    // A full esm.sh URL resolves directly in the preview (the import-map's own values are esm.sh URLs).
    const urlImport = comp("Chart", "composite", 2, [], {
      source: undefined,
      srcText: 'import * as d3 from "https://esm.sh/d3@7";\nexport function Chart(){ return d3; }',
    });
    // a genuine bare package missing from the map is STILL flagged.
    const bareMiss = comp("Bad", "composite", 2, [], {
      source: undefined,
      srcText: 'import { scaleLinear } from "d3-scale";\nexport function Bad(){ return scaleLinear; }',
    });
    const flagged = analyzeGraphHealth([urlImport, bareMiss]).filter((f) => f.category === "unresolvable-import");
    expect(flagged.map((f) => f.nodeNames[0])).toEqual(["Bad"]); // only the bare miss
    expect(flagged[0].why).toContain("d3-scale");
  });

  it("flags a component importing a nonexistent internal module as unresolvable-import (#2954)", () => {
    // The invisible `Code`→`../typography/type` / `Skeleton`→`./shimmer` class — an internal import
    // (`@/…` OR relative) resolving to no kit component or runtime module, now surfaced by the doctor.
    const widget = comp("Widget", "composite", 1, [], {
      src: "shared/ui/data/Widget.tsx",
      source:
        'import { helper } from "@/shared/ui/nope/missing";\nimport { x } from "../also/gone";\n' +
        "export function Widget(){ return helper(x); }",
    });
    const f = analyzeGraphHealth([widget]).find((x) => x.category === "unresolvable-import");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe(3);
    expect(f!.why).toContain("@/shared/ui/nope/missing"); // the alias import
    expect(f!.why).toContain("../also/gone"); // the relative import
    expect(f!.why).toContain("no such module in the kit or its runtime closure");
  });

  it("does NOT flag an internal import that resolves to a kit sibling (#2954)", () => {
    // A `@/…` OR relative import that resolves to another component in the same store is fine.
    const sibling = comp("Sibling", "primitive", 1, [], { src: "shared/ui/data/Sibling.tsx" });
    const widget = comp("Widget", "composite", 1, [], {
      src: "shared/ui/data/Widget.tsx",
      source:
        'import { S } from "@/shared/ui/data/Sibling";\nimport { R } from "./Sibling";\n' +
        "export function Widget(){ return S ?? R; }",
    });
    const cats = analyzeGraphHealth([sibling, widget]).map((f) => f.category);
    expect(cats).not.toContain("unresolvable-import");
  });

  it("flags a source-less user spec as no-implementation but never a built-in (#2839)", () => {
    // BUILT-IN: source-less in the store (its artifact `source` is stripped, #2794) but its `src` is a
    // real packaged react-ui component — buildable via the artifact roster, so NOT flagged.
    const builtin = comp("Card", "primitive", 2, [], {
      source: undefined, src: "shared/ui/data/Card.tsx",
      srcText: 'import { Card } from "@/shared/ui/data/Card";\n<Card />',
    });
    // USER SPEC: a `page` that's a design, not code — source-less, a usage-snippet srcText, and a `src`
    // NOT in the artifact. The preview can't build it (componentPreviewFiles → null) → flagged.
    const spec = comp("GraphExplorerPage", "page", 1, [], {
      source: undefined, src: "user/pages/GraphExplorerPage.tsx",
      srcText: 'import { GraphExplorerPage } from "@/x";\n<GraphExplorerPage nodes={…} />',
    });
    const flagged = analyzeGraphHealth([builtin, spec])
      .filter((f) => f.category === "no-implementation")
      .flatMap((f) => f.nodeNames);
    expect(flagged).toContain("GraphExplorerPage");
    expect(flagged).not.toContain("Card");
    // The badge map picks it up (its most-severe category).
    const map = nodeHealth([builtin, spec]);
    expect(map.get("GraphExplorerPage")).toBe("no-implementation");
    expect(map.get("Card")).toBeUndefined();
  });

  it("flags a component that declares `composes` its source never renders as phantom-compose (#3111)", () => {
    // A user chart that DECLARES it composes ChartFrame/Axis but redraws them inline (renders neither) —
    // the graph would draw phantom edges AND the false in-edges would hide ChartFrame/Axis from orphan
    // detection. It renders only lowercase SVG, no kit component.
    const chart = comp("BarChart", "composite", 2, ["ChartFrame", "Axis"], {
      source: "export function BarChart(){ return <svg><rect/></svg>; }",
    });
    const frame = comp("ChartFrame", "layout", 1);
    const axis = comp("Axis", "primitive", 1);
    const fs = analyzeGraphHealth([chart, frame, axis]);
    const f = fs.find((x) => x.category === "phantom-compose");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe(2);
    expect(f!.nodeNames).toEqual(["BarChart"]);
    expect(f!.why).toContain("ChartFrame, Axis"); // names the phantom edges, in composes order
  });

  it("does NOT flag phantom-compose for a real render, a slot-shell, or a built-in (#3111)", () => {
    // Renders <ChartFrame> → a real composition, not phantom.
    const real = comp("LineChart", "composite", 2, ["ChartFrame"], {
      source: "export function LineChart(){ return <ChartFrame><path/></ChartFrame>; }",
    });
    // A slot-shell (composes + a ReactNode slot): the child arrives via the slot, not a direct render.
    const slotted = comp("AnalyticsPage", "page", 2, ["BarChart"], {
      source: "export function AnalyticsPage({ range }){ return <div>{range}</div>; }",
      props: [{ name: "range", type: "ReactNode", req: false, desc: "" }],
    });
    // A BUILT-IN: its store `srcText` is an illustrative snippet (not the real module that renders the
    // child), so scanning it would false-positive — built-ins are exempt.
    const builtin = comp("Chip", "composite", 5, ["StatusDot"], {
      builtin: true, source: undefined, srcText: "export function Chip({ children }){ return <span>{children}</span>; }",
    });
    const cats = analyzeGraphHealth([
      real, slotted, builtin,
      comp("ChartFrame", "layout", 3), comp("BarChart", "composite", 3, ["ChartFrame"], { source: "export function BarChart(){ return <ChartFrame/>; }" }),
      comp("StatusDot", "primitive", 9),
    ]).map((f) => f.category);
    expect(cats).not.toContain("phantom-compose");
  });
});
