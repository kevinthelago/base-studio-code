import { describe, it, expect } from "vitest";
import { REACT_UI_COMPONENTS, REACT_UI_KIT } from "./reactUiKit";
import { SEED_COMPONENTS, SEED_KITS } from "./seed";
import { componentRules } from "./rules";
import { UI_KIT } from "@/shared/ui/manifest";

const byName = (name: string) => REACT_UI_COMPONENTS.find((c) => c.name === name);

describe("react-ui kit generated from the manifest (#2305)", () => {
  it("covers exactly the registered primitives — no drift, no missing, no extra", () => {
    const kit = new Set(REACT_UI_COMPONENTS.map((c) => c.name));
    const manifest = new Set(UI_KIT.map((p) => p.name));
    expect(kit).toEqual(manifest);
    expect(REACT_UI_COMPONENTS.length).toBe(UI_KIT.length);
    // Every generated record belongs to the react-ui kit, is a built-in, and has a lowercase id.
    for (const c of REACT_UI_COMPONENTS) {
      expect(c.kitId).toBe(REACT_UI_KIT.id);
      expect(c.builtin).toBe(true);
      expect(c.id).toBe(c.name.toLowerCase());
    }
  });

  it("layers the authored guidance overlay onto the generated records", () => {
    const button = byName("Button")!;
    expect(button.wraps).toBe("button");            // → derives the anti-duplication lint rule
    expect(button.whenUse.length).toBeGreaterThan(0);
    expect(button.variants).toContain("primary");
    expect(button.srcText).toContain("function Button");
    expect(byName("Chip")!.composes).toContain("StatusDot");
    expect(byName("SegmentedControl")!.composes).toContain("Button");
  });

  it("maps the manifest group to a role (overlay wins)", () => {
    expect(byName("Box")!.role).toBe("layout");         // layout group — a true positioner
    expect(byName("Button")!.role).toBe("primitive");   // controls group
    expect(byName("Card")!.role).toBe("composite");     // overlay override (#2970: a chrome container, not a positioner)
    expect(byName("SegmentedControl")!.role).toBe("composite"); // overlay override
  });

  it("records `loading` as a variant wherever the manifest registers a loading prop (#2302)", () => {
    // Card/Chip/Text/TextField/FillBar/Code declare a `loading` prop in the manifest.
    for (const n of ["Card", "Chip", "Text", "TextField", "FillBar", "Code"]) {
      expect(byName(n)!.variants, `${n} should record a loading variant`).toContain("loading");
    }
    // A control without a loading prop does not fabricate one.
    expect(byName("Checkbox")!.variants).not.toContain("loading");
  });

  it("carries the prop schema + a derived source path from the manifest", () => {
    const button = byName("Button")!;
    expect(button.src).toBe("shared/ui/controls/Button.tsx");
    expect(button.props.find((p) => p.name === "variant")?.type).toContain('"primary"');
    // A component without an authored srcText gets a generated usage stub.
    expect(byName("Box")!.srcText).toContain('import { Box } from "@/shared/ui/layout/Box"');
  });

  it("authors when-to-use / when-not guidance for EVERY primitive incl. charts (#2305)", () => {
    for (const c of REACT_UI_COMPONENTS) {
      expect(c.whenUse.length, `${c.name} missing whenUse guidance`).toBeGreaterThan(0);
      expect(c.whenNot.length, `${c.name} missing whenNot guidance`).toBeGreaterThan(0);
    }
  });

  it("derives an anti-duplication lint rule from each primitive that wraps a raw element", () => {
    // The kit dogfoods its own no-raw-element rule: Box→div, Text→span, Button→button, etc.
    const wrapsRule = (name: string, target: string) => {
      const rules = componentRules(byName(name)!);
      const r = rules.find((x) => x.kind === "forbid-element" && x.target === target);
      expect(r, `${name} should derive a forbid-<${target}> rule`).toBeTruthy();
      expect(r!.use).toBe(name);
    };
    wrapsRule("Box", "div");
    wrapsRule("Text", "span");
    wrapsRule("Button", "button");
    wrapsRule("TextField", "input");
    wrapsRule("SelectField", "select");
  });

  it("records real composition edges from the overlay", () => {
    expect(byName("Dialog")!.composes).toEqual(expect.arrayContaining(["ModalScrim", "Card"]));
    expect(byName("ConfirmButton")!.composes).toContain("Button");
    expect(byName("StatCard")!.composes).toEqual(expect.arrayContaining(["Card", "StatTile"]));
  });

  it("stamps the data-shape axis honestly — exact sets, audited components only (#2475)", () => {
    // The ideal-rendering index the planner queries via `bsc ui shapes` / `bsc ui list --shape`.
    expect(byName("MasterDetail")!.shapes).toEqual(["list"]);     // rail = select-a-row list → detail
    expect(byName("GraphCanvas")!.shapes).toEqual(["graph"]);     // node/edge pan-zoom world
    expect(byName("DataTableRow")!.shapes).toEqual(["table"]);    // aligned fixed-column records
    expect(byName("CardListRow")!.shapes).toEqual(["list"]);      // the card-list row archetype
    expect(byName("ActivityFeed")!.shapes).toEqual(["list"]);     // striped feed of homogeneous rows
    expect(byName("KeyValueList")!.shapes).toEqual(["key-value"]); // the record/property-list rendering
    // Audited and deliberately NOT shape-indexed: SplitView's panes are heterogeneous, PaneGrid hosts
    // opaque workspace panes (not data items), StatTile renders a single KPI pair, not a record.
    for (const n of ["SplitView", "PaneGrid", "StatTile"]) {
      expect(byName(n)!.shapes, `${n} must not fake a shape ideal`).toBeUndefined();
    }
    // The Layouts-tier shape ideals: `tree` → Tree (#2476), `linked-list` → Sequence (#2477).
    expect(byName("Tree")!.shapes).toEqual(["tree"]);
    expect(byName("Sequence")!.shapes).toEqual(["linked-list"]);
    // #2505 — the Pages tier stamps the shape its WHOLE composition renders: the same shape as its
    // central layout template, one tier up. DashboardPage is honestly NOT shape-indexed — it renders
    // a heterogeneous board (KPIs + series + slices + feed); no single shape is "the page's shape".
    expect(byName("TablePage")!.shapes).toEqual(["table"]);
    expect(byName("TreeExplorerPage")!.shapes).toEqual(["tree"]);
    expect(byName("PipelinePage")!.shapes).toEqual(["linked-list"]);
    expect(byName("NetworkPage")!.shapes).toEqual(["graph"]);
    expect(byName("CollectionPage")!.shapes).toEqual(["list"]);
    expect(byName("RecordPage")!.shapes).toEqual(["key-value"]); // #2508 — the key-value shape's page
    expect(byName("DashboardPage")!.shapes, "DashboardPage must not fake a shape ideal").toBeUndefined();
  });

  it("keeps shape claimants unambiguous per role tier (#2475, refined by #2505)", () => {
    // THE CLAIMANT CONTRACT. #2475's original guard was one claimant per shape ACROSS THE KIT for
    // tree/linked-list — sized for a kit whose only claimant tier was the layouts. The Pages tier
    // (#2505) legitimately re-claims those shapes one tier up, so the contract is now per ROLE TIER:
    // within each tier that names an "ideal" — the LAYOUTS (structural templates) and the PAGES
    // (complete compositions) — a shape has AT MOST ONE claimant. The layouts stay the shape IDEALS
    // (`bsc ui shapes` answers carry `role`, so a reader tells the structural ideal from the finished
    // page); a page claiming the same shape is the complete rendering of it, never a competing
    // template — and no near-fit outside those two tiers may fake tree/linked-list coverage.
    const claimants = (shape: string, role: string) =>
      REACT_UI_COMPONENTS.filter((c) => c.role === role && ((c.shapes ?? []) as string[]).includes(shape))
        .map((c) => c.name);
    for (const s of ["list", "linked-list", "tree", "graph", "table", "key-value"]) {
      expect(claimants(s, "layout").length, `layout tier claims ${s} at most once`).toBeLessThanOrEqual(1);
      expect(claimants(s, "page").length, `page tier claims ${s} at most once`).toBeLessThanOrEqual(1);
    }
    // tree/linked-list/key-value keep exhaustive claimant sets: the ideal component/template + its
    // page, nothing else (key-value's pair is composite-tier KeyValueList + page-tier RecordPage, #2508).
    const all = (shape: string) =>
      REACT_UI_COMPONENTS.filter((c) => ((c.shapes ?? []) as string[]).includes(shape)).map((c) => c.name).sort();
    expect(all("tree")).toEqual(["Tree", "TreeExplorerPage"]);
    expect(all("linked-list")).toEqual(["PipelinePage", "Sequence"]);
    expect(all("key-value")).toEqual(["KeyValueList", "RecordPage"]);
  });

  it("the packaged seed is the generated react-ui kit + the algo-viz viz kit (#2506/#3194)", () => {
    // The #2456 examples kit demonstrated the page→primitive model; react-ui's own pages tier
    // (#2505) supersedes it, so the seed carries the one generated kit. #3194 adds the always-on
    // `algo-viz` viz kit (its AlgoCells demo component) as the second packaged builtin.
    expect(SEED_KITS.map((k) => k.id)).toEqual(["react-ui", "algo-viz"]);
    expect(SEED_COMPONENTS.map((c) => c.name).sort()).toEqual(
      [...REACT_UI_COMPONENTS.map((c) => c.name), "AlgoCells"].sort(),
    );
  });
});

describe("the pages tier (#2505) — complete data-driven page compositions", () => {
  const PAGES = ["CollectionPage", "DashboardPage", "NetworkPage", "PipelinePage", "RecordPage", "TablePage", "TreeExplorerPage"];

  it("registers exactly the seven pages, each with role `page` (the top of the pyramid)", () => {
    const pages = REACT_UI_COMPONENTS.filter((c) => c.role === "page").map((c) => c.name).sort();
    expect(pages).toEqual(PAGES);
  });

  it("every page's composes list is non-empty and every name resolves in-kit (no dangling edges)", () => {
    const names = new Set(REACT_UI_COMPONENTS.map((c) => c.name));
    for (const p of PAGES) {
      const c = byName(p)!;
      expect(c.composes.length, `${p} must record its composition`).toBeGreaterThan(0);
      for (const dep of c.composes) expect(names.has(dep), `${p} composes unknown ${dep}`).toBe(true);
    }
  });

  it("graph completeness: every page transitively reaches a primitive via composes — no orphan pages", () => {
    const byN = new Map(REACT_UI_COMPONENTS.map((c) => [c.name, c]));
    const reachesPrimitive = (name: string, seen: Set<string>): boolean => {
      const c = byN.get(name);
      if (!c || seen.has(name)) return false;
      seen.add(name);
      if (c.role === "primitive") return true;
      return c.composes.some((d) => reachesPrimitive(d, seen));
    };
    for (const p of PAGES) {
      expect(reachesPrimitive(p, new Set()), `${p} must reach a primitive through its composes chain`).toBe(true);
    }
  });

  it("each page's central layout template is a composes edge (page → layout → … in the graph)", () => {
    expect(byName("TablePage")!.composes).toContain("SplitView");
    expect(byName("TreeExplorerPage")!.composes).toContain("Tree");
    expect(byName("PipelinePage")!.composes).toContain("Sequence");
    expect(byName("NetworkPage")!.composes).toContain("GraphCanvas");
    expect(byName("CollectionPage")!.composes).toContain("MasterDetail");
    // RecordPage (#2508) has no single template either — its centre is the KeyValueList composite
    // (the key-value archetype one tier down), grouped by SectionLabel.
    expect(byName("RecordPage")!.composes).toEqual(expect.arrayContaining(["KeyValueList", "SectionLabel"]));
    // DashboardPage has no single template — its chart/feed composites are the edges down.
    expect(byName("DashboardPage")!.composes).toEqual(
      expect.arrayContaining(["StatCard", "LineArea", "Donut", "Legend", "Spark", "ActivityFeed"]),
    );
  });

  it("authors full guidance + a realistic source snippet for every page", () => {
    for (const p of PAGES) {
      const c = byName(p)!;
      expect(c.whenUse.length, `${p} whenUse`).toBeGreaterThan(0);
      expect(c.whenNot.length, `${p} whenNot`).toBeGreaterThan(0);
      expect(c.tags).toContain("page");
      expect(c.srcText).toContain(`<${p}`);
      expect(c.src).toBe(`shared/ui/pages/${p}.tsx`);
    }
  });
});
