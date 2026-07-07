import { describe, it, expect } from "vitest";
import { matchesQuery, resolveComposes, resolveUsedBy, DATA_SHAPES, ROLE_COLOR, ROLES, type ComponentRecord, type DataShape } from "./model";
import { SEED_COMPONENTS, SEED_KITS } from "./seed";

const byName = (n: string) => SEED_COMPONENTS.find((c) => c.name === n)!;

describe("component model helpers (#2269)", () => {
  it("matchesQuery is case-insensitive across name/role/tags, and empty → all", () => {
    const chip = byName("Chip");
    expect(matchesQuery(chip, "")).toBe(true);
    expect(matchesQuery(chip, "CHI")).toBe(true); // name
    expect(matchesQuery(chip, "primitive")).toBe(true); // role
    expect(matchesQuery(chip, "status")).toBe(true); // tag
    expect(matchesQuery(chip, "zzz")).toBe(false);
  });

  it("resolveComposes pairs each dependency with its record (undefined when absent)", () => {
    const seg = byName("SegmentedControl"); // composes ["Button"]
    const resolved = resolveComposes(seg, SEED_COMPONENTS);
    expect(resolved.map((r) => r.name)).toEqual(["Button"]);
    expect(resolved[0].comp?.name).toBe("Button");
    // A dependency name not in the kit resolves to undefined (renders non-clickable).
    const orphan = { ...seg, composes: ["Nonexistent"] };
    expect(resolveComposes(orphan, SEED_COMPONENTS)[0].comp).toBeUndefined();
  });

  it("resolveUsedBy finds the components that compose the target", () => {
    const button = byName("Button"); // composed by SegmentedControl + ConfirmButton + EmptyState
    const users = resolveUsedBy(button, SEED_COMPONENTS).map((c) => c.name);
    expect(users).toContain("SegmentedControl");
    expect(users).toContain("EmptyState");
    // A page root that nothing composes.
    expect(resolveUsedBy(byName("DashboardPage"), SEED_COMPONENTS)).toEqual([]);
  });

  it("every role has a color token", () => {
    for (const r of ROLES) expect(ROLE_COLOR[r]).toMatch(/^var\(--/);
  });

  it("seed ids are unique + lowercased from the name", () => {
    const ids = SEED_COMPONENTS.map((c: ComponentRecord) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byName("Button").id).toBe("button");
  });

  it("the data-shape vocabulary is exactly the six canonical shapes (#2475)", () => {
    expect(DATA_SHAPES).toEqual(["list", "linked-list", "tree", "graph", "table", "key-value"]);
    // `shapes` is an optional, typed axis on ComponentRecord — every stamped value is in-vocabulary.
    for (const c of SEED_COMPONENTS) {
      for (const s of c.shapes ?? []) {
        expect(DATA_SHAPES, `${c.name} stamps an in-vocabulary shape`).toContain(s as DataShape);
      }
    }
  });

  it("every packaged kit carries the rail-hierarchy axes: tech (a lowercase slug) + style (#2487)", () => {
    const byId = new Map(SEED_KITS.map((k) => [k.id, k]));
    expect(byId.get("react-ui")).toMatchObject({ tech: "react", style: "studio" });
    for (const k of SEED_KITS) {
      expect(k.tech, `${k.id} tech is a lowercase slug`).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(k.style, `${k.id} carries a visual-language label`).toBeTruthy();
    }
  });
});
