import { describe, it, expect } from "vitest";
import { REACT_UI_COMPONENTS, REACT_UI_KIT } from "./reactUiKit";
import { SEED_COMPONENTS, SEED_KITS } from "./seed";
import { componentRules } from "./rules";
import { UI_KIT } from "@/shared/ui/manifest";

const byName = (name: string) => REACT_UI_COMPONENTS.find((c) => c.name === name);

/** The chart primitives whose rich guidance is a follow-up (#2305 slice 3 remainder). */
const CHART_PRIMS = new Set(["LineArea", "Bars", "Donut", "HBars", "Swimlane", "Spark", "Legend", "StackedDayBars"]);

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

  it("drops the fake demo rows from react-ui", () => {
    for (const fake of ["PersonasPanel", "BscBridge", "FsWatcher", "PersonaService", "CommandRouter"]) {
      expect(byName(fake)).toBeUndefined();
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
    expect(byName("Box")!.role).toBe("layout");         // layout group
    expect(byName("Button")!.role).toBe("primitive");   // controls group
    expect(byName("Card")!.role).toBe("layout");        // overlay override (data group → layout)
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

  it("authors when-to-use / when-not guidance for every non-chart primitive (#2305 slice 3)", () => {
    for (const c of REACT_UI_COMPONENTS) {
      if (CHART_PRIMS.has(c.name)) continue; // chart guidance is a follow-up
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

  it("keeps the demos in a separate `examples` kit", () => {
    expect(SEED_KITS.map((k) => k.id)).toEqual(["react-ui", "examples"]);
    const examples = SEED_COMPONENTS.filter((c) => c.kitId === "examples").map((c) => c.name);
    expect(examples).toContain("PersonaService");
    expect(examples).toContain("PersonasPanel");
    // The seed is the generated react-ui kit + the examples demos.
    expect(SEED_COMPONENTS.length).toBe(REACT_UI_COMPONENTS.length + examples.length);
  });
});
