import { describe, it, expect } from "vitest";
import { componentPreviewFiles, bootstrapSource, samplePropValue, looksBuildableModule, PREVIEW_ENTRY, type KitArtifact } from "./componentPreview";
import type { ComponentRecord, PropSpec } from "./model";

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
    expect(samplePropValue(prop("rows", "Row[]"))).toBe("[]");
    expect(samplePropValue(prop("tone", '"neutral" | "danger"'))).toBe('"neutral"');
    expect(samplePropValue(prop("color", "string"))).toBe('"var(--accent)"');
  });
});
