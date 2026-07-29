import { describe, it, expect } from "vitest";
import { analyzeGraphHealth, analyzeMotion, nodeHealth, HEALTH_SEVERITY, HEALTH_BADGE } from "./graphHealth";
import type { ComponentRecord, Role } from "./model";
import type { KitAnimation } from "@/shared/ui/kit/animations";

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

  it("flags an interactive component with no analytics events, and clears on a manifest (#3810)", () => {
    const action: Partial<ComponentRecord> = { props: [{ name: "onClick", type: "() => void", req: true, desc: "" }] };
    // interactive (an action prop) + no analytics → flagged.
    expect(analyzeGraphHealth([comp("IconButton", "primitive", 3, [], action)]).some((f) => f.category === "no-analytics")).toBe(true);
    // declaring events clears it.
    expect(analyzeGraphHealth([comp("IconButton", "primitive", 3, [], { ...action, analytics: [{ event: "click" }] })]).some((f) => f.category === "no-analytics")).toBe(false);
    // a display-only component (no action prop) is never flagged.
    expect(analyzeGraphHealth([comp("Label", "primitive", 5, [], { props: [{ name: "text", type: "string", req: true, desc: "" }] })]).some((f) => f.category === "no-analytics")).toBe(false);
    // a built-in (no own module source) is skipped — packaged instrumentation is separate.
    expect(analyzeGraphHealth([comp("Btn", "primitive", 9, [], { ...action, source: undefined, srcText: "<button/>", builtin: true })]).some((f) => f.category === "no-analytics")).toBe(false);
  });

  it("names WHY a component is no-implementation, not merely that it is (bsc request #4)", () => {
    // The finding used to state only THAT the preview couldn't build it, so the reader had to re-derive
    // the cause by hand. Rust twin: `a_no_implementation_finding_names_why_it_is_unbuildable`.
    const whyOf = (over: Partial<ComponentRecord>) =>
      analyzeGraphHealth([comp("Sketch", "composite", 2, [], over)])
        .find((f) => f.category === "no-implementation")?.why ?? "";

    expect(whyOf({ source: "", srcText: "" })).toContain("no module source of its own");
    expect(whyOf({ source: "", srcText: "function Sketch(){ return <i/>; }" })).toContain("declares no `export`");
    expect(whyOf({ source: "", srcText: "export function Sketch(){ … }" })).toContain("code-elision marker");
    expect(
      whyOf({ source: "", srcText: 'import { z } from "@/features/nope/lib/gone";\nexport function Sketch(){ return <i>{z}</i>; }' }),
    ).toContain("`@/features/nope/lib/gone`");
  });

  it("flags an INTERACTIVE implemented component carrying no tests, and clears on a manifest (#3878)", () => {
    // Tests are a per-node data contract, the same shape as the analytics manifest one field over: once a
    // component's source is a store record compiled at runtime, a test file under src/** is no longer
    // beside what it tests.
    const action: Partial<ComponentRecord> = { props: [{ name: "onPick", type: "() => void", req: true, desc: "" }] };
    expect(analyzeGraphHealth([comp("Card", "composite", 3, [], action)]).some((f) => f.category === "no-tests")).toBe(true);
    // carrying tests clears it.
    expect(analyzeGraphHealth([comp("Card", "composite", 3, [], {
      ...action, tests: [{ name: "renders its title", src: "it('renders', () => {})" }],
    })]).some((f) => f.category === "no-tests")).toBe(false);
    // NOT interactive → never flagged. This is the line that keeps the check a suggestion rather than a
    // finding on every node: flagging every implemented component lit up essentially the whole graph.
    expect(analyzeGraphHealth([comp("Label", "primitive", 5, [], {
      props: [{ name: "text", type: "string", req: true, desc: "" }],
    })]).some((f) => f.category === "no-tests")).toBe(false);
    // a BUILT-IN is skipped — packaged separately, not the designer's to test in-session.
    expect(analyzeGraphHealth([comp("Btn", "primitive", 9, [], {
      ...action, source: undefined, srcText: "<button/>", builtin: true,
    })]).some((f) => f.category === "no-tests")).toBe(false);
    // a SPEC-ONLY node is skipped — it already earns `no-implementation`, and one cause must not raise two
    // findings.
    const specOnly = analyzeGraphHealth([comp("Sketch", "composite", 2, [], { ...action, source: "", srcText: "" })]);
    expect(specOnly.some((f) => f.category === "no-tests")).toBe(false);
    expect(specOnly.some((f) => f.category === "no-implementation")).toBe(true);
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
        // `data: Row` (a record, not an array) so this stays a pure unwired-prop case — an ARRAY prop would
        // also (correctly) trigger the #3135 no-empty-state/no-loading-state checks.
        { name: "data", type: "Row", req: false, desc: "" },
        { name: "onRefresh", type: "() => void", req: false, desc: "" },
      ],
      // Declares its event so the #3810 no-analytics check is satisfied — keeps this a PURE unwired-prop
      // case (the `onRefresh` prop is still unused by the source).
      analytics: [{ event: "refresh" }],
      // …and its tests, for the same reason, against #3878's no-tests check: `onRefresh` makes this node
      // interactive, so an untested fixture would earn a second (legitimate) finding and stop this
      // exact-list assertion from being about unwired-prop.
      tests: [{ name: "renders the title", src: "it('renders', () => {})" }],
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

  it("notes a bare npm miss as stubbed-import, not an error (#3696)", () => {
    // Imports d3-scale (NOT a curated external) alongside react + lucide-react (both pinned). A bare npm miss
    // no longer FAILS — the preview bundles a local stub for it → a severity-1 `stubbed-import` note.
    const chart = comp("Chart", "composite", 2, [], {
      source: undefined,
      srcText:
        'import React from "react";\nimport { scaleLinear } from "d3-scale";\nimport { Icon } from "lucide-react";\n' +
        "export function Chart(){ return React.createElement(Icon, null, scaleLinear); }",
    });
    const fs = analyzeGraphHealth([chart]);
    const f = fs.find((x) => x.category === "stubbed-import");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe(1);
    expect(f!.why).toContain("d3-scale"); // not curated → stubbed
    expect(f!.why).not.toContain("`react`"); // react is pinned → real, not listed
    expect(f!.why).not.toContain("`lucide-react`"); // pinned → real, not listed
    expect(fs.some((x) => x.category === "unresolvable-import")).toBe(false); // a bare npm miss is no longer an ERROR
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

  it("keeps an absolute URL import clean and a bare miss only a stub note (#2963/#3696)", () => {
    // A full esm.sh URL resolves directly in the preview (the import-map's own values are esm.sh URLs).
    const urlImport = comp("Chart", "composite", 2, [], {
      source: undefined,
      srcText: 'import * as d3 from "https://esm.sh/d3@7";\nexport function Chart(){ return d3; }',
    });
    // a genuine bare package missing from the curated externals is now a stub NOTE, not an error.
    const bareMiss = comp("Bad", "composite", 2, [], {
      source: undefined,
      srcText: 'import { scaleLinear } from "d3-scale";\nexport function Bad(){ return scaleLinear; }',
    });
    const fs = analyzeGraphHealth([urlImport, bareMiss]);
    expect(fs.some((f) => f.category === "unresolvable-import")).toBe(false); // neither a URL nor a bare miss is an ERROR
    const stubbed = fs.filter((f) => f.category === "stubbed-import");
    expect(stubbed.map((f) => f.nodeNames[0])).toEqual(["Bad"]); // only the bare miss
    expect(stubbed[0].why).toContain("d3-scale");
  });

  it("resolves @bsc/algorithms/fibonacci (not flagged) but flags @bsc/algorithms/<missing> (#3116)", () => {
    // The THIRD import class: a `@bsc/algorithms/…` cross-graph reference that matches a real library
    // algorithm is a NEW resolvable class (the preview vendors its code) — never flagged; a missing one is.
    const good = comp("FibCard", "composite", 2, [], {
      source: undefined,
      srcText: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function FibCard(){ return fibonacci(10); }',
    });
    const bad = comp("BadCard", "composite", 2, [], {
      source: undefined,
      srcText: 'import { nope } from "@bsc/algorithms/nope";\nexport function BadCard(){ return nope(); }',
    });
    const flagged = analyzeGraphHealth([good, bad]).filter((f) => f.category === "unresolvable-import");
    expect(flagged.map((f) => f.nodeNames[0])).toEqual(["BadCard"]); // only the missing library ref
    expect(flagged[0].why).toContain("@bsc/algorithms/nope");
    expect(flagged[0].why).toContain("no matching node in the library");
    expect(flagged[0].why).not.toContain("import-map"); // a library miss isn't reported as a bare npm miss
  });

  it("resolves @bsc/sounds/click (not flagged) but flags @bsc/sounds/<missing> (#3117)", () => {
    // The sounds arm of the third import class: a `@bsc/sounds/<id>` reference matching a real cue is a
    // resolvable class (the preview vendors a generated player module) — never flagged; a missing one is.
    const good = comp("PlayBtn", "composite", 2, [], {
      source: undefined,
      srcText: 'import { play } from "@bsc/sounds/click";\nexport function PlayBtn(){ return play(); }',
    });
    const bad = comp("BadBtn", "composite", 2, [], {
      source: undefined,
      srcText: 'import { play } from "@bsc/sounds/nope";\nexport function BadBtn(){ return play(); }',
    });
    const flagged = analyzeGraphHealth([good, bad]).filter((f) => f.category === "unresolvable-import");
    expect(flagged.map((f) => f.nodeNames[0])).toEqual(["BadBtn"]); // only the missing sound ref
    expect(flagged[0].why).toContain("@bsc/sounds/nope");
    expect(flagged[0].why).toContain("no matching node in the library");
    expect(flagged[0].why).not.toContain("import-map");
  });

  it("leaves a normal component (no library import) unaffected by the library check (#3116)", () => {
    const chart = comp("Chart", "composite", 2, [], {
      source: undefined,
      srcText: 'import React from "react";\nimport * as d3 from "d3";\nexport function Chart(){ return null; }',
    });
    expect(analyzeGraphHealth([chart])).toEqual([]);
  });

  // ── reimplementation guardrail — "compose, don't recreate" (#3118) ──────────────────────────────

  it("flags an inline reimplementation of a library algorithm as reimplementation (#3118)", () => {
    // An own-source component declaring `fibonacci` (no @bsc/algorithms/fibonacci import) re-codes the
    // library algorithm. used>0 so no orphan; renders no JSX so no self-reference — ONLY reimplementation.
    const widget = comp("FibWidget", "composite", 2, [], {
      source: "export function fibonacci(n){ return n < 2 ? n : fibonacci(n-1) + fibonacci(n-2); }",
    });
    const fs = analyzeGraphHealth([widget]);
    expect(fs.map((f) => f.category)).toEqual(["reimplementation"]);
    expect(fs[0].severity).toBe(3);
    expect(fs[0].nodeNames).toEqual(["FibWidget"]);
    expect(fs[0].why).toContain("fibonacci"); // names the re-coded symbol
    expect(fs[0].why).toContain("@bsc/algorithms/fibonacci"); // names the library import to compose instead
  });

  it("flags a node that RE-DECLARES a component that already exists in the graph (#3892)", () => {
    // The harvested-kit failure: a record carries `function Box` while a `Box` node sits in the same
    // graph, so the preview renders the STUB — the node looks correct while composing nothing real.
    const box = comp("Box", "primitive", 9, [], {
      source: "export function Box({children}){ return <div>{children}</div>; }",
    });
    const face = comp("AgentFace", "composite", 2, ["Box"], {
      source: "function Box({children}){ return <div>{children}</div>; }\nexport function AgentFace(){ return <Box>hi</Box>; }",
    });
    const fs = analyzeGraphHealth([box, face]);
    const f = fs.find((x) => x.category === "reimplemented-component");
    expect(f, `flagged: ${JSON.stringify(fs)}`).toBeTruthy();
    expect(f!.severity).toBe(3);
    expect(f!.nodeNames).toEqual(["AgentFace"]);
    expect(f!.why).toContain("`Box`");
    // The node that OWNS the name is never flagged for declaring itself.
    expect(fs.some((x) => x.category === "reimplemented-component" && x.nodeNames[0] === "Box")).toBe(false);
  });

  it("treats a REGISTERED platform module import as resolvable (#3897)", () => {
    // `@/features/security/lib/badgeTone` is resolved at runtime by the feature's graphPlatform, and is
    // neither an artifact path nor a sibling `src`. Before the manifest it read as no-implementation while
    // the app mounted the page fine — and the finding pressured authors to STUB the import to silence it.
    const tab = comp("ProfilesTab", "composite", 2, [], {
      src: "src/features/security/ProfilesTab.tsx",
      source: 'import { badgeTone } from "@/features/security/lib/badgeTone";\nexport function ProfilesTab(){ return <i>{badgeTone(1)}</i>; }',
    });
    const cats = analyzeGraphHealth([tab]).map((f) => f.category);
    expect(cats).not.toContain("no-implementation");
    expect(cats).not.toContain("unresolvable-import");
  });

  it("still flags an UNREGISTERED internal import (#3897)", () => {
    const x = comp("X", "composite", 2, [], {
      src: "src/features/x/X.tsx",
      source: 'import { nope } from "@/features/x/lib/doesNotExist";\nexport function X(){ return <i>{nope}</i>; }',
    });
    const cats = analyzeGraphHealth([x]).map((f) => f.category);
    expect(cats.includes("unresolvable-import") || cats.includes("no-implementation")).toBe(true);
  });

  it("does NOT flag a sibling extracted from the SAME module (#3895)", () => {
    // `AgentFace` and `TeamsCanvas` are both lifted from TeamsCanvas.tsx, so that module's closure
    // legitimately CONTAINS both declarations — flagging it would demand importing the file from itself.
    const face = comp("AgentFace", "primitive", 3, [], {
      src: "src/features/teams/TeamsCanvas.tsx",
      source: "export function AgentFace(){ return <i/>; }",
    });
    const canvas = comp("TeamsCanvas", "composite", 2, [], {
      src: "src/features/teams/TeamsCanvas.tsx",
      source: "function AgentFace(){ return <i/>; }\nexport function TeamsCanvas(){ return <AgentFace/>; }",
    });
    expect(analyzeGraphHealth([face, canvas]).some((f) => f.category === "reimplemented-component")).toBe(false);
  });

  it("does NOT flag a re-declaration once the real component is IMPORTED (#3892)", () => {
    const box = comp("Box", "primitive", 9, [], {
      source: "export function Box({children}){ return <div>{children}</div>; }",
    });
    const face = comp("AgentFace", "composite", 2, ["Box"], {
      source: 'import { Box } from "@/shared/ui/layout/Box";\nexport function AgentFace(){ return <Box>hi</Box>; }',
    });
    expect(analyzeGraphHealth([box, face]).some((f) => f.category === "reimplemented-component")).toBe(false);
  });

  it("does NOT flag a component that imports the library algorithm (#3118)", () => {
    // Imports + uses the library node (declares no local `fibonacci`) — already composing, and the library
    // ref resolves, so it's clean overall.
    const card = comp("FibCard", "composite", 2, [], {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function FibCard(){ return fibonacci(10); }',
    });
    expect(analyzeGraphHealth([card])).toEqual([]);
  });

  it("does NOT flag a declaration matching no library node (#3118)", () => {
    // `Sparkline` is no library node → never a reimplementation.
    const sp = comp("Sparkline", "composite", 2, [], { source: "export function Sparkline(){ return null; }" });
    expect(analyzeGraphHealth([sp]).map((f) => f.category)).not.toContain("reimplementation");
  });

  it("does NOT flag a reimplementation when the component also imports the node (#3118)", () => {
    // Degenerate belt-and-suspenders: importing @bsc/algorithms/fibonacci suppresses the flag even if a
    // local `fibonacci` is also declared (the component is composing, not recreating).
    const shadow = comp("FibShadow", "composite", 2, [], {
      source: 'import { fibonacci } from "@bsc/algorithms/fibonacci";\nexport function fibonacci(n){ return n; }',
    });
    expect(analyzeGraphHealth([shadow]).map((f) => f.category)).not.toContain("reimplementation");
  });

  it("does NOT flag a symbol matching a SOUND cue id — the detector is algorithms-only (#3118)", () => {
    // Sounds are DELIBERATELY excluded: cue/voice ids (`click`, `toggle`, `error`, …) collide with
    // extremely common handler/function names, so `function click()` must NOT be flagged — and you don't
    // re-code a cue as a function anyway. (`@bsc/sounds/…` import resolution + vendoring, #3117, is untouched.)
    const fx = comp("ClickFx", "composite", 2, [], { source: "export function click(){ /* a click handler */ return null; }" });
    expect(analyzeGraphHealth([fx]).map((f) => f.category)).not.toContain("reimplementation");
  });

  it("nodeHealth badges a reimplementation node (#3118)", () => {
    const widget = comp("FibWidget", "composite", 2, [], { source: "export function fibonacci(n){ return n; }" });
    expect(nodeHealth([widget]).get("FibWidget")).toBe("reimplementation");
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

  it("flags a component not wired to the theme as hardcoded-color (#3704)", () => {
    // Hardcodes hex colors + NO `var(--…)` token → not wired to the theme (the mobile-studio-code case).
    const unwired = comp("WorkerCard", "composite", 2, [], {
      source: 'export function WorkerCard(){ const s = { color: "#e8ecf4", background: "#161b26", accent: "#7aa2ff" }; return s ? null : null; }',
    });
    // Uses a theme token → wired → NOT flagged, even though it also has one raw value.
    const themed = comp("Btn", "primitive", 2, [], {
      source: 'export function Btn(){ const s = { color: "var(--fg)", ring: "#000000" }; return s ? null : null; }',
    });
    const builtin = comp("Native", "primitive", 2, [], { builtin: true, source: 'export function Native(){ const s = { color: "#ffffff" }; return s ? null : null; }' });
    const hc = analyzeGraphHealth([unwired, themed, builtin]).filter((f) => f.category === "hardcoded-color");
    expect(hc.map((f) => f.nodeNames[0])).toEqual(["WorkerCard"]); // only the unwired one
    expect(hc[0].severity).toBe(1);
    expect(hc[0].why).toContain("#e8ecf4"); // names a sample literal
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

  it("flags a data component with no empty/loading/error state support (#3135/#3555)", () => {
    // A chart with a data array that renders it raw — no EmptyState/empty-guard, no `loading`/`error` prop.
    const chart = comp("BarChart", "composite", 2, [], {
      source: "export function BarChart({ data }){ return <svg>{data.map((d) => <rect key={d} />)}</svg>; }",
      props: [{ name: "data", type: "Datum[]", req: false, desc: "" }],
    });
    const cats = analyzeGraphHealth([chart]).map((f) => f.category);
    expect(cats).toContain("no-empty-state");
    expect(cats).toContain("no-loading-state");
    expect(cats).toContain("no-error-state");
    expect(analyzeGraphHealth([chart]).find((f) => f.category === "no-empty-state")?.severity).toBe(1);
  });

  it("does NOT flag when a data component handles empty AND exposes loading + error props, or has no data prop (#3135/#3555)", () => {
    // Handles empty (Array.isArray) + has loading + error props → supports every state.
    const good = comp("Good", "composite", 2, [], {
      source: "export function Good({ data, loading, error }){ if (error) return <span>!</span>; if (loading) return <span>…</span>; return <svg>{Array.isArray(data) ? data.map((d) => <rect key={d} />) : null}</svg>; }",
      props: [{ name: "data", type: "Datum[]", req: false, desc: "" }, { name: "loading", type: "boolean", req: false, desc: "" }, { name: "error", type: "string", req: false, desc: "" }],
    });
    // No collection prop at all → not a data component → never flagged.
    const button = comp("Button", "primitive", 5, [], {
      source: "export function Button({ label }){ return <button>{label}</button>; }",
      props: [{ name: "label", type: "string", req: false, desc: "" }],
    });
    const cats = analyzeGraphHealth([good, button]).map((f) => f.category);
    expect(cats).not.toContain("no-empty-state");
    expect(cats).not.toContain("no-loading-state");
    expect(cats).not.toContain("no-error-state");
  });
});

// ── motion checks (#3163, `bsc ui doctor --motion`) ─────────────────────────────────────────────────
describe("analyzeMotion (#3163, mirrors bsc ui doctor --motion)", () => {
  const kf = (props: Record<string, string>): KitAnimation["keyframes"] => ({ from: props, to: props });
  const anim = (over: Partial<KitAnimation> & { name: string }): KitAnimation => ({ keyframes: kf({ opacity: "1" }), ...over });

  it("(a) flags an animation selector whose class hook the source never renders — a dead selector", () => {
    const dead = comp("Chart", "composite", 2, [], {
      source: "export function Chart(){ return <svg><rect/></svg>; }", srcText: "",
      animations: [anim({ name: "spin", selector: ".bar", keyframes: kf({ transform: "scale(1)" }) })],
    });
    const fs = analyzeMotion([dead]);
    expect(fs.map((f) => f.category)).toContain("motion-dead-selector");
    expect(fs.find((f) => f.category === "motion-dead-selector")?.why).toContain("`.bar`");
    // A component whose source DOES render the `.bar` class hook is not flagged.
    const live = comp("Chart2", "composite", 2, [], {
      source: "export function Chart2(){ return <svg><rect className=\"bar\"/></svg>; }", srcText: "",
      animations: [anim({ name: "spin", selector: ".bar", keyframes: kf({ transform: "scale(1)" }) })],
    });
    expect(analyzeMotion([live]).map((f) => f.category)).not.toContain("motion-dead-selector");
  });

  it("(b) flags a stroke-dash keyframe on a component that sets no pathLength", () => {
    const draw = comp("Path", "composite", 2, [], {
      source: "export function Path(){ return <svg><path d=\"M0 0\"/></svg>; }", srcText: "",
      animations: [anim({ name: "draw", keyframes: kf({ "stroke-dashoffset": "0" }) })],
    });
    expect(analyzeMotion([draw]).map((f) => f.category)).toContain("motion-dash-no-pathlength");
    // A component that sets pathLength is fine (the draw has a known geometry length).
    const ok = comp("Path2", "composite", 2, [], {
      source: "export function Path2(){ return <svg><path pathLength={1} d=\"M0 0\"/></svg>; }", srcText: "",
      animations: [anim({ name: "draw", keyframes: kf({ "stroke-dashoffset": "0" }) })],
    });
    expect(analyzeMotion([ok]).map((f) => f.category)).not.toContain("motion-dash-no-pathlength");
  });

  it("(c) flags a CSS transform keyframe on a component using an SVG transform= attribute", () => {
    const clash = comp("Group", "composite", 2, [], {
      source: "export function Group(){ return <svg><g transform=\"translate(4,4)\"><rect/></g></svg>; }", srcText: "",
      animations: [anim({ name: "rot", keyframes: kf({ transform: "rotate(90deg)" }) })],
    });
    expect(analyzeMotion([clash]).map((f) => f.category)).toContain("motion-transform-attr");
    // A CSS-transform keyframe with NO SVG transform attribute in the source is fine.
    const cssOnly = comp("Box", "composite", 2, [], {
      source: "export function Box(){ return <div className=\"box\"/>; }", srcText: "",
      animations: [anim({ name: "rot", keyframes: kf({ transform: "rotate(90deg)" }) })],
    });
    expect(analyzeMotion([cssOnly]).map((f) => f.category)).not.toContain("motion-transform-attr");
  });

  it("(d) flags a cross-component inline keyframe-name collision, but not a shared kit-library name-ref", () => {
    const a = comp("Bar", "composite", 2, [], { animations: [anim({ name: "draw", keyframes: kf({ opacity: "1" }) })] });
    const b = comp("Line", "composite", 2, [], { animations: [anim({ name: "draw", keyframes: kf({ opacity: "1" }) })] });
    const fs = analyzeMotion([a, b]);
    const collision = fs.find((f) => f.category === "motion-name-collision");
    expect(collision).toBeTruthy();
    expect(collision?.nodeNames).toEqual(["Bar", "Line"]);
    expect(collision?.nodeIds).toEqual(["Bar", "Line"]);
    // Two components that merely NAME-REF the same kit animation (strings) do NOT collide — that's sharing.
    const c = comp("A", "composite", 2, [], { animations: ["draw"] });
    const d = comp("B", "composite", 2, [], { animations: ["draw"] });
    expect(analyzeMotion([c, d]).map((f) => f.category)).not.toContain("motion-name-collision");
  });

  it("returns nothing for components with no inline animations (name-refs / none)", () => {
    expect(analyzeMotion([comp("X", "composite", 2)])).toEqual([]);
    expect(analyzeMotion([comp("Y", "composite", 2, [], { animations: ["fade-in", "pulse"] })])).toEqual([]);
  });
});

describe("runtime data-state categories (#3191)", () => {
  it("carries the two RUNTIME blank-state categories at the mild-warning tier (2, above the #3135 advisories)", () => {
    expect(HEALTH_SEVERITY["empty-empty-state"]).toBe(2);
    expect(HEALTH_SEVERITY["empty-loading-state"]).toBe(2);
    // Above the static #3135 advisories, so a render-confirmed blank wins the badge over a static one.
    expect(HEALTH_SEVERITY["empty-empty-state"]).toBeGreaterThan(HEALTH_SEVERITY["no-empty-state"]);
    expect(HEALTH_SEVERITY["empty-loading-state"]).toBeGreaterThan(HEALTH_SEVERITY["no-loading-state"]);
  });

  it("is NEVER produced by the static analyzer — these are render-confirmed by the scan, not analyzeGraphHealth", () => {
    // A data component with a raw-render collection + a loading prop: the STATIC analyzer emits the #3135
    // no-empty-state advisory, but never the RUNTIME empty-*-state categories (it can't run the component).
    const chart = comp("BarChart", "composite", 2, [], {
      source: "export function BarChart({ data, loading }){ return <svg>{data.map((d) => <rect key={d}/>)}</svg>; }",
      props: [{ name: "data", type: "Datum[]", req: false, desc: "" }, { name: "loading", type: "boolean", req: false, desc: "" }],
    });
    const cats = analyzeGraphHealth([chart]).map((f) => f.category);
    expect(cats).not.toContain("empty-empty-state");
    expect(cats).not.toContain("empty-loading-state");
  });

  it("HEALTH_BADGE has a glyph + label for EVERY category — the #3026 gap stays closed (#3191)", () => {
    // HEALTH_SEVERITY is a total Record<HealthCategory, number>, so its keys ARE the complete category set;
    // assert HEALTH_BADGE covers each (the compiler already enforces this via the Record type — this pins it
    // at runtime too, since #3026 was a category shipping without a badge).
    for (const cat of Object.keys(HEALTH_SEVERITY)) {
      const badge = HEALTH_BADGE[cat as keyof typeof HEALTH_BADGE];
      expect(badge, `missing HEALTH_BADGE entry for "${cat}"`).toBeTruthy();
      expect(badge.glyph.length, `empty glyph for "${cat}"`).toBeGreaterThan(0);
      expect(badge.label.length, `empty label for "${cat}"`).toBeGreaterThan(0);
    }
    expect(HEALTH_BADGE["empty-empty-state"].glyph).toBeTruthy();
    expect(HEALTH_BADGE["empty-loading-state"].glyph).toBeTruthy();
  });
});
