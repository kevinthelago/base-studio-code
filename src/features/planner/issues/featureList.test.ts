import { describe, it, expect } from "vitest";
import { parseFeaturesFile, featureDefined, featuresSummary, featuresGateComplete, featuresAwaitingConfirm, featuresToPlanIssues, featureDependencyCycle, type PlanFeature } from "./featureList";

describe("parseFeaturesFile", () => {
  it("returns [] for empty / bad JSON / non-array", () => {
    expect(parseFeaturesFile("")).toEqual([]);
    expect(parseFeaturesFile("   ")).toEqual([]);
    expect(parseFeaturesFile("{not json")).toEqual([]);
    expect(parseFeaturesFile('{"slug":"x","name":"X"}')).toEqual([]); // object, not array
  });

  it("parses a clean feature array", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "invite", name: "Invite teammates", behavior: "send an invite", acceptance: ["email sent"], tools: ["resend"] },
    ]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ slug: "invite", name: "Invite teammates", behavior: "send an invite" });
    expect(f[0].acceptance).toEqual(["email sent"]);
    expect(f[0].tools).toEqual(["resend"]);
    expect(f[0].stream).toBe("invite"); // defaults to slug
  });

  it("parses dependsOn (#plan-db)", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "kernel", name: "Kernel" },
      { slug: "sketcher", name: "Sketcher", dependsOn: ["kernel"] },
    ]));
    expect(f[1].dependsOn).toEqual(["kernel"]);
  });

  // #4080 — the plan → algorithms-graph edge. Both spellings, because the store emits camelCase but a
  // hand-written or older payload may carry snake, and silently dropping it loses the reference outright.
  it("parses requires, tolerating both spellings (#4080)", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "sorter", name: "Sorter", requires: ["merge.rs", "binary-search.ts"] },
      { slug: "snake", name: "Snake", requires_: ["merge.rs"] },
      { slug: "none", name: "None" },
    ]));
    expect(f[0].requires).toEqual(["merge.rs", "binary-search.ts"]);
    expect(f[1].requires).toEqual(["merge.rs"]);
    // Absent ⇒ `undefined`, the same convention every other array field here follows (`strArray`
    // collapses absent AND empty to undefined). Deliberately NOT normalized to `[]` for this one field
    // — a lone exception would be worse than the convention.
    expect(f[2].requires).toBeUndefined();
  });

  it("derives a slug from the name when missing, and an explicit stream wins", () => {
    const f = parseFeaturesFile(JSON.stringify([{ name: "Export to CSV", stream: "exporter" }]));
    expect(f[0].slug).toBe("export-to-csv");
    expect(f[0].stream).toBe("exporter");
  });

  it("drops entries with no name and de-dupes slugs", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "a", name: "A" },
      { slug: "a", name: "A duplicate" },
      { behavior: "no name" },
    ]));
    expect(f.map((x) => x.slug)).toEqual(["a"]);
  });

  it("ignores malformed field types", () => {
    const f = parseFeaturesFile(JSON.stringify([{ slug: "a", name: "A", acceptance: "not-an-array", tools: [1, "ok", ""] }]));
    expect(f[0].acceptance).toBeUndefined();
    expect(f[0].tools).toEqual(["ok"]);
  });
});

describe("featureDefined / featuresSummary", () => {
  const full = { slug: "a", name: "A", behavior: "does a thing", acceptance: ["x"] };
  it("a feature is defined only with name + behavior + ≥1 acceptance", () => {
    expect(featureDefined(full)).toBe(true);
    expect(featureDefined({ slug: "a", name: "A" })).toBe(false);
    expect(featureDefined({ slug: "a", name: "A", behavior: "b" })).toBe(false);
    expect(featureDefined({ slug: "a", name: "A", behavior: "b", acceptance: [] })).toBe(false);
  });

  it("summary reports count + all-defined", () => {
    expect(featuresSummary([])).toEqual({ count: 0, allConfirmed: false });
    expect(featuresSummary([full])).toEqual({ count: 1, allConfirmed: true });
    expect(featuresSummary([full, { slug: "b", name: "B" }])).toEqual({ count: 2, allConfirmed: false });
  });
});

describe("featuresGateComplete / featuresAwaitingConfirm (#plan-db — the auto-complete fix)", () => {
  it("a single fully-populated feature does NOT complete the stage until the user confirms", () => {
    const populated = { allConfirmed: true }; // even one defined feature reports all-defined
    expect(featuresGateComplete(populated, false)).toBe(false); // the old auto-complete is gone
    expect(featuresGateComplete(populated, true)).toBe(true);   // completes once the user confirms
  });

  it("offers the confirm only once everything is populated, not mid-population", () => {
    expect(featuresAwaitingConfirm({ allConfirmed: false }, false)).toBe(false); // still populating → no offer
    expect(featuresAwaitingConfirm({ allConfirmed: true }, false)).toBe(true);   // all populated → offer confirm
    expect(featuresAwaitingConfirm({ allConfirmed: true }, true)).toBe(false);   // already confirmed → nothing pending
  });
});

describe("featuresToPlanIssues (#plan-db — publish generates issues from features)", () => {
  it("maps one issue per feature: slug→ref, acceptance/dependsOn carry over, prose→body", () => {
    const issues = featuresToPlanIssues([
      { slug: "kernel", name: "Geometry kernel", behavior: "evaluate solids", acceptance: ["booleans work"], approach: "BREP", tools: ["opencascade"], dependsOn: [] },
      { slug: "sketcher", name: "Sketcher", dependsOn: ["kernel"] },
    ]);
    expect(issues[0]).toMatchObject({ ref: "kernel", title: "Geometry kernel", acceptance: ["booleans work"], stream: "kernel" });
    expect(issues[0].body).toContain("evaluate solids");
    expect(issues[0].body).toContain("## Approach");
    expect(issues[1]).toMatchObject({ ref: "sketcher", dependsOn: ["kernel"] }); // feature edge → issue dep
  });
});

describe("featureDependencyCycle (#plan-db — the feature DAG)", () => {
  const f = (slug: string, dependsOn?: string[]): PlanFeature => ({ slug, name: slug, dependsOn });
  it("returns [] for an acyclic graph (a foundation many depend on)", () => {
    const feats = [f("kernel"), f("sketcher", ["kernel"]), f("assembly", ["kernel", "sketcher"])];
    expect(featureDependencyCycle(feats)).toEqual([]);
  });
  it("finds a direct cycle", () => {
    const cyc = featureDependencyCycle([f("a", ["b"]), f("b", ["a"])]);
    expect(cyc[0]).toBe(cyc[cyc.length - 1]); // closes on itself
    expect(new Set(cyc)).toEqual(new Set(["a", "b"]));
  });
  it("catches a self-dependency", () => {
    expect(featureDependencyCycle([f("a", ["a"])])).toEqual(["a", "a"]);
  });
  it("ignores edges to unknown slugs (dangling dep is not a cycle)", () => {
    expect(featureDependencyCycle([f("a", ["ghost"])])).toEqual([]);
  });
});
