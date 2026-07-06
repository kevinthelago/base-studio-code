import { describe, it, expect } from "vitest";
import { matchesQuery, resolveComposes, resolveUsedBy, ROLE_COLOR, ROLES, type ComponentRecord } from "./model";
import { SEED_COMPONENTS } from "./seed";

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
    const button = byName("Button"); // composed by SegmentedControl + EmptyState + PersonasPanel
    const users = resolveUsedBy(button, SEED_COMPONENTS).map((c) => c.name);
    expect(users).toContain("SegmentedControl");
    expect(users).toContain("EmptyState");
    // A leaf that nothing composes.
    expect(resolveUsedBy(byName("FsWatcher"), SEED_COMPONENTS)).toEqual([]);
  });

  it("every role has a color token", () => {
    for (const r of ROLES) expect(ROLE_COLOR[r]).toMatch(/^var\(--/);
  });

  it("seed ids are unique + lowercased from the name", () => {
    const ids = SEED_COMPONENTS.map((c: ComponentRecord) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byName("Button").id).toBe("button");
  });
});
