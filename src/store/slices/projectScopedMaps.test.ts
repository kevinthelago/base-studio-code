import { describe, it, expect } from "vitest";
import type { AppStore } from "../types";
import {
  PROJECT_SCOPED_MAPS,
  REPO_SCOPED_MAPS,
  deleteProjectScoped,
  rekeyProjectScoped,
  dropProjectScoped,
} from "./projectScopedMaps";

// Build a fake store where every registered map has an entry for two projects (A, B), and every
// repo-scoped map has one entry per project (`<key>::<repo>`). Non-registered fields are irrelevant.
function makeState(): AppStore {
  const s: Record<string, Record<string, unknown>> = {};
  for (const name of PROJECT_SCOPED_MAPS) {
    s[name as string] = { A: `A:${String(name)}`, B: `B:${String(name)}` };
  }
  for (const name of REPO_SCOPED_MAPS) {
    s[name as string] = { "A::repo": `A:${String(name)}`, "B::repo": `B:${String(name)}` };
  }
  return s as unknown as AppStore;
}

const asMap = (o: Partial<AppStore>, name: keyof AppStore) =>
  (o as unknown as Record<string, Record<string, unknown>>)[name as string];

describe("projectScopedMaps registry", () => {
  it("delete removes exactly project A's entries from the delete-op maps, keeping B", () => {
    const s = makeState();
    const out = deleteProjectScoped(s, new Set(["A"]));
    // Every map the helper returns must have dropped A and kept B.
    for (const name of Object.keys(out) as (keyof AppStore)[]) {
      const m = asMap(out, name);
      expect(m).toBeDefined();
      expect("A" in m || "A::repo" in m).toBe(false);
      expect("B" in m || "B::repo" in m).toBe(true);
    }
  });

  it("delete does not touch maps outside the delete op set (e.g. reposPublic / stagePreview)", () => {
    const s = makeState();
    const out = deleteProjectScoped(s, new Set(["A"]));
    // These are `applyBlueprint`/`clearPlan`-only maps — delete must never return them.
    for (const outside of ["reposPublic", "planInjectionAck", "stagePreview", "stageRuns"] as (keyof AppStore)[]) {
      expect(asMap(out, outside)).toBeUndefined();
    }
    // …and repoPublic is not a delete-op repo map either.
    expect(asMap(out, "repoPublic" as keyof AppStore)).toBeUndefined();
  });

  it("rekey moves A -> C (target-absent) for every rekey-op map, leaving B", () => {
    const s = makeState();
    const out = rekeyProjectScoped(s, "A", "C");
    for (const name of Object.keys(out) as (keyof AppStore)[]) {
      const m = asMap(out, name);
      if (REPO_SCOPED_MAPS.includes(name)) {
        expect("A::repo" in m).toBe(false);
        expect("C::repo" in m).toBe(true);
        expect("B::repo" in m).toBe(true);
      } else {
        expect("A" in m).toBe(false);
        expect("C" in m).toBe(true);
        expect("B" in m).toBe(true);
      }
    }
  });

  it("rekey is target-wins: an existing newKey entry is kept and the old dropped", () => {
    const s = makeState();
    // planStages is a rekey-op map; give it both A and B, move A -> B.
    const out = rekeyProjectScoped(s, "A", "B");
    const m = asMap(out, "planStages");
    expect("A" in m).toBe(false);
    // B is preserved as its own value (not overwritten by A's).
    expect(m.B).toBe("B:planStages");
  });

  it("dropProjectScoped(clearPlan) drops the key from clearPlan maps but not delete-only maps", () => {
    const s = makeState();
    const out = dropProjectScoped(s, "clearPlan", "A");
    // A plan map cleared…
    expect(asMap(out, "planStages")).toBeDefined();
    expect("A" in asMap(out, "planStages")).toBe(false);
    // reposPublic is a clearPlan map…
    expect("A" in asMap(out, "reposPublic")).toBe(false);
    // …but autoTriage (delete/rekey only) must NOT be returned by clearPlan.
    expect(asMap(out, "autoTriage" as keyof AppStore)).toBeUndefined();
    expect(asMap(out, "loadVerified" as keyof AppStore)).toBeUndefined();
  });

  it("dropProjectScoped(applyBlueprint) excludes the re-seeded maps planStageConfig/projectBlueprintId", () => {
    const s = makeState();
    const out = dropProjectScoped(s, "applyBlueprint", "A");
    // These are set (not dropped) by applyBlueprintToProject, so must be absent from the drop set.
    expect(asMap(out, "planStageConfig" as keyof AppStore)).toBeUndefined();
    expect(asMap(out, "projectBlueprintId" as keyof AppStore)).toBeUndefined();
    // But a normal reset map is dropped, and its repo map (repoPublic) too.
    expect("A" in asMap(out, "planStages")).toBe(false);
    expect("A::repo" in asMap(out, "repoPublic")).toBe(false);
    expect("B::repo" in asMap(out, "repoPublic")).toBe(true);
  });

  it("dropProjectScoped(clearPlan) drops repoPublic entries for the key only", () => {
    const s = makeState();
    const out = dropProjectScoped(s, "clearPlan", "A");
    const m = asMap(out, "repoPublic");
    expect("A::repo" in m).toBe(false);
    expect("B::repo" in m).toBe(true);
  });
});
