import { describe, it, expect } from "vitest";
import { UI_KIT, findPrimitive, primitivesByGroup, manifestJson, type PropType } from "./manifest";
import { BASE_ANIMATIONS } from "./kit/baseAnimations";
import { UI_COMPONENTS, componentFor } from "./registry";

const PROP_TYPES: PropType[] = [
  "string", "number", "boolean", "enum", "node", "function", "style", "array", "object", "space", "fontSize", "tracks", "color",
];

describe("UI kit manifest — integrity", () => {
  it("has unique names and well-formed entries", () => {
    const seen = new Set<string>();
    for (const p of UI_KIT) {
      expect(p.name, "name").toBeTruthy();
      expect(seen.has(p.name), `duplicate ${p.name}`).toBe(false);
      seen.add(p.name);
      expect(p.importPath).toMatch(/^@\/shared\/ui\//);
      expect(p.description.length).toBeGreaterThan(0);
      expect(Array.isArray(p.props)).toBe(true);
    }
  });

  it("every prop has a valid type; enum props list their values", () => {
    for (const p of UI_KIT) {
      for (const prop of p.props) {
        expect(prop.name, `${p.name}.<prop>`).toBeTruthy();
        expect(PROP_TYPES, `${p.name}.${prop.name} type`).toContain(prop.type);
        expect(prop.description.length, `${p.name}.${prop.name} description`).toBeGreaterThan(0);
        if (prop.type === "enum") {
          expect(prop.values && prop.values.length, `${p.name}.${prop.name} values`).toBeTruthy();
        }
      }
    }
  });

  it("serialises to JSON round-trip (pure data, no component refs)", () => {
    const parsed = JSON.parse(manifestJson());
    expect(parsed).toHaveLength(UI_KIT.length);
    expect(parsed[0].name).toBe(UI_KIT[0].name);
  });

  it("helpers resolve", () => {
    expect(findPrimitive("Row")?.group).toBe("layout");
    expect(primitivesByGroup().layout.map((p) => p.name)).toContain("Grid");
    const groups = primitivesByGroup();
    const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
    expect(total).toBe(UI_KIT.length);
  });

  it("carries the pages tier (#2505, +RecordPage #2508) — the seven complete page compositions in their own group", () => {
    expect(primitivesByGroup().pages.map((p) => p.name).sort()).toEqual(
      ["CollectionPage", "DashboardPage", "NetworkPage", "PipelinePage", "RecordPage", "TablePage", "TreeExplorerPage"]);
  });

  it("binds the base motions by NAME (#2871/#3451) — the defs are owned by the `base` kit", () => {
    // The primitives REFERENCE the shared base motion library; they no longer carry the defs
    // themselves (those moved to `shared/ui/kit/baseAnimations.ts`, so ONE edit propagates to every
    // consuming kit instead of react-ui owning motion the whole platform leans on).
    const exemplars = { StatusDot: "pulse", Card: "fade-in", Button: "lift" } as const;
    for (const [comp, want] of Object.entries(exemplars)) {
      expect(findPrimitive(comp as never)?.animations, `${comp} binds the base motion`).toEqual([want]);
    }
  });

  it("references only base animations that actually exist (#3451) — no dangling motion refs", () => {
    // A name with no def in the base library resolves to NOTHING and the component silently plays no
    // motion — exactly the failure the name-ref indirection introduces, so it is pinned here.
    const defined = new Set(BASE_ANIMATIONS.map((a) => a.name));
    for (const p of UI_KIT) {
      for (const name of p.animations ?? []) {
        expect(defined.has(name), `${p.name} references a base animation that exists: ${name}`).toBe(true);
      }
    }
  });
});

describe("UI kit manifest — sync with the render-map registry", () => {
  it("the data manifest and the component registry cover exactly the same names", () => {
    const manifestNames = [...UI_KIT.map((p) => p.name)].sort();
    const registryNames = Object.keys(UI_COMPONENTS).sort();
    expect(manifestNames).toEqual(registryNames);
  });

  it("every registry entry is a renderable component", () => {
    for (const [name, comp] of Object.entries(UI_COMPONENTS)) {
      expect(typeof comp, name).toBe("function");
    }
  });

  it("componentFor resolves each manifested name", () => {
    for (const p of UI_KIT) {
      expect(componentFor(p.name), p.name).toBe(UI_COMPONENTS[p.name]);
    }
  });

  it("every importPath actually exports its named component", async () => {
    for (const p of UI_KIT) {
      const mod = await import(/* @vite-ignore */ p.importPath);
      expect(typeof mod[p.name], `${p.name} @ ${p.importPath}`).toBe("function");
    }
  });
});
