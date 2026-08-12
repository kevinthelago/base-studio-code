// glance-progress-ref-namespace-split — a fleet stream's `issues` and plan.db's `ref` column are two
// SEPARATE ownership records, and they need not share a namespace.
//
// WHY NO EXISTING TEST CAUGHT THIS. Every fixture in the suite uses ONE ref shape throughout — refs go
// in, the same refs come out, `done` matches, green. The bug only exists where the two shapes MEET, so
// it is structurally invisible to a single-shape fixture. That is what this file supplies: both shapes
// in one fixture, which is the shape of the real data.
//
// Measured on the two live projects when this was filed:
//   base-studio-code   22 stream refs, ALL plan.db slugs   -> 22/22 resolve, the ref path is right
//   studio-code        56 stream refs, ALL GitHub numbers  -> 0/56 resolve, and every owning node read
//                                                             0/N while plan.db knew the real answer
import { describe, it, expect } from "vitest";
import { fleetPlanProgress, knownRefAliases, mergeStreamProgress, unionDone } from "./fleetPlanProgress";
import { streamProgress, projectProgress } from "./streamProgress";
import type { OwnedIssue } from "@/shared/lib/fleet/workerEnd";

/** plan.db as `studio-code` actually holds it: slug refs, no GitHub identity anywhere. */
const SLUG_ISSUES: OwnedIssue[] = [
  { ref: "glance-planner-node-per-project", status: "verified", stream: "glance" },
  { ref: "glance-project-studio-sessions", status: "verified", stream: "glance" },
  { ref: "glance-open-issue", status: "open", stream: "glance" },
  { ref: "design-studio-a", status: "complete", stream: "design-studio" },
  { ref: "design-studio-b", status: "verified", stream: "design-studio" },
  // Owned by NO stream — counted by the project, never by a worker.
  { ref: "unowned-chore", status: "verified" },
];

/** The same project's fleet, whose streams were authored with GitHub NUMBERS. */
const NUMERIC_STREAMS = [
  { id: "glance", issues: ["#233", "#234"] },
  { id: "design-studio", issues: ["#243", "#245", "#246"] },
];

describe("stream refs in a namespace plan.db has never seen", () => {
  const known = knownRefAliases(SLUG_ISSUES);
  const done = unionDone(SLUG_ISSUES.filter((i) => i.status === "verified" || i.status === "complete").map((i) => i.ref));

  it("resolves none of them — the premise of the bug, stated as a fact", () => {
    const refs = NUMERIC_STREAMS.flatMap((s) => s.issues).map((r) => r.replace(/^#/, ""));
    expect(refs.some((r) => known.has(r))).toBe(false);
  });

  it("emits NO ref-path entry for a stream whose refs all resolve to nothing", () => {
    const out = fleetPlanProgress(NUMERIC_STREAMS, done, undefined, known);
    expect(out.has("glance")).toBe(false);
    expect(out.has("design-studio")).toBe(false);
  });

  it("so plan.db answers, and a stream that IS done stops reading 0/N", () => {
    const merged = mergeStreamProgress(
      fleetPlanProgress(NUMERIC_STREAMS, done, undefined, known),
      streamProgress(SLUG_ISSUES),
    );
    // The reported case: plan.db knows design-studio is 2/2, the ref path claimed 0/3, and the ref path won.
    expect(merged.get("design-studio")).toEqual({ done: 2, total: 2 });
    expect(merged.get("glance")).toEqual({ done: 2, total: 3 });
  });

  it("gives the DIRECTOR no aggregate it cannot substantiate", () => {
    const out = fleetPlanProgress(NUMERIC_STREAMS, done, "director", known);
    // Not `{done: 0, total: 5}` — an unmovable denominator is worse than none, and 0/5 reads as
    // "nothing done" for a board that is mostly finished.
    expect(out.has("director")).toBe(false);
  });

  it("the project number the director falls back to counts UNOWNED issues too", () => {
    // 5 of 6 are complete|verified — including `unowned-chore`, which NO stream counts. Summing the
    // per-stream rows says 4/5, and that gap is exactly why the director cannot just add up its workers.
    expect(projectProgress(SLUG_ISSUES)).toEqual({ done: 5, total: 6 });
    const perStream = [...streamProgress(SLUG_ISSUES).values()].reduce(
      (a, p) => ({ done: a.done + p.done, total: a.total + p.total }), { done: 0, total: 0 },
    );
    expect(perStream).not.toEqual(projectProgress(SLUG_ISSUES));
  });
});

describe("stream refs in plan.db's OWN namespace still work — this must not regress", () => {
  // `base-studio-code`: the streams carry the same slugs plan.db does.
  const SLUG_STREAMS = [
    { id: "glance", issues: ["glance-planner-node-per-project", "glance-open-issue"] },
    { id: "design-studio", issues: ["design-studio-a", "design-studio-b"] },
  ];
  const known = knownRefAliases(SLUG_ISSUES);
  const done = unionDone(["glance-planner-node-per-project", "design-studio-a", "design-studio-b"]);

  it("the ref path answers, with the stream's OWN denominator", () => {
    const out = fleetPlanProgress(SLUG_STREAMS, done, "director", known);
    expect(out.get("glance")).toEqual({ done: 1, total: 2 });
    expect(out.get("design-studio")).toEqual({ done: 2, total: 2 });
    // …and the director aggregates the union, de-duplicated.
    expect(out.get("director")).toEqual({ done: 3, total: 4 });
  });

  it("a slug carrying its origin number also answers to that number", () => {
    const aliases = knownRefAliases([{ ref: "4260-sandbox-by-default" }]);
    expect(aliases.has("4260-sandbox-by-default")).toBe(true);
    expect(aliases.has("4260")).toBe(true);
    // …so a stream written with `#4260` resolves against a plan.db that stores the slug.
    const out = fleetPlanProgress([{ id: "s", issues: ["#4260"] }], unionDone(["4260-sandbox-by-default"]), undefined, aliases);
    expect(out.get("s")).toEqual({ done: 0, total: 1 });
    expect(out.has("s")).toBe(true); // it RESOLVED — done-ness is a separate question from resolvability
  });

  it("omitting `knownRefs` keeps the old behaviour exactly — no caller is forced to change", () => {
    const out = fleetPlanProgress(NUMERIC_STREAMS, done, "director");
    expect(out.get("glance")).toEqual({ done: 0, total: 2 });
    expect(out.get("director")).toEqual({ done: 0, total: 5 });
  });
});
