// A GRAPH FOLD WITH NO CALLER IS A NODE NOBODY SEES.
//
// This exists because it already happened, and every other gate stayed green while it did. Slice 1 of
// `epic-command-surfaces-are-nodes` landed `surfaceGraph` with a full vocabulary test and a projection
// test, marked the item `verified`, and **nothing ever called it** — `surfaceGraph(` occurred exactly
// once in the whole tree, its own definition. So no crate node existed in the running app, and no test
// could notice, because a pure projection tested in isolation passes identically whether or not
// anything renders it.
//
// The fix for the instance was to write the fold. The fix for the CLASS is this: a projection exported
// from the glance graph libraries must be referenced by at least one module that is neither itself nor
// a test. It is a WIRING guard, deliberately — it proves a call site exists, not that the call produces
// the right picture; the fold's own behaviour is pinned in `glanceSurfaceNodes.test.ts`. A weaker claim
// honestly stated beats the strong one nobody made.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every module body the app ships — records live in the SEED, not on disk (docs/records.md). */
function sources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];

  const walk = (dir: string, take: (p: string) => boolean) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, take);
      else if (take(p)) out.push({ name: p, text: readFileSync(p, "utf8") });
    }
  };

  // The component seed: one JSON record per module, body in `srcText`.
  const comp = "src-tauri/data/components";
  walk(comp, (p) => p.endsWith(".json"));

  // The algorithms seed: many records in one file. Kept whole — we only ever substring-search it, and
  // splitting it per record would need a schema this guard has no reason to know.
  out.push({ name: "algorithms.json", text: readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8") });

  // …and the modules still on disk.
  walk("src", (p) => (p.endsWith(".ts") || p.endsWith(".tsx")) && !/\.(test|spec)\./.test(p));
  return out;
}

describe("every glance graph fold has a caller", () => {
  // Each entry is `[exported fold, the module that DEFINES it]`. Add a fold here when you write one —
  // the point is that adding the projection and forgetting the call site is caught by the gate rather
  // than by a maintainer noticing the node is missing months later.
  // ENTRY POINTS ONLY — the folds a COMPONENT is supposed to call.
  //
  // `surfaceGraph` is deliberately NOT listed, and the first draft listing it was wrong in an
  // instructive way: it is called by `withSurfaceNodes`, its sibling in the same module, so the guard
  // demanded a component call a helper it has no business calling. A helper is covered TRANSITIVELY —
  // if the entry point has a caller and the helper has one inside the module, the helper runs. Listing
  // every exported function here would trade a real signal for noise, which is how a gate gets demoted.
  const FOLDS: [string, string][] = [
    ["withSurfaceNodes", "surface-nodes.ts"],
    ["crateDrillGraph", "surface-nodes.ts"],
    // `the-feature-band-has-no-caller` — the SECOND instance of the class this file was written for.
    // `featureBand` shipped with three passing tests and no call site, so there was no feature node in
    // the running app and the maintainer found it by opening Glance. It is listed here now; that this
    // list is hand-maintained is exactly why it did not help, and the item says so.
    ["withFeatureNodes", "feature-nodes.ts"],
  ];

  const all = sources();

  it("reads a corpus at all — a scan that finds nothing would pass every assertion below", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.some((s) => s.text.includes("buildGlanceData"))).toBe(true);
  });

  it.each(FOLDS)("%s is called from outside %s", (fold, definedIn) => {
    // A call, not a mention: `withSurfaceNodes(` excludes the import line and any prose naming it.
    const callers = all.filter((s) => {
      if (s.name.includes(definedIn.replace(/\.ts$/, ""))) return false;
      // The algorithms seed holds the definition AND other records, so a bare hit there is ambiguous.
      // Count it only when the call appears somewhere other than the defining record's own body.
      if (s.name === "algorithms.json") {
        const defining = s.text.indexOf(`export function ${fold}(`);
        if (defining < 0) return s.text.includes(`${fold}(`);
        // strip a generous window around the definition, then look again
        const without = s.text.slice(0, defining) + s.text.slice(defining + 4000);
        return without.includes(`${fold}(`);
      }
      return s.text.includes(`${fold}(`);
    });
    expect(
      callers.map((c) => c.name),
      `${fold} is exported and projected but nothing calls it — the node it draws cannot appear`,
    ).not.toHaveLength(0);
  });
});

// THE HAND-MAINTAINED LIST ABOVE IS WHY THIS CLASS SHIPPED TWICE.
//
// `withFeatureNodes` was added to `FOLDS` when `the-feature-band-has-no-caller` landed, so the BAND was
// covered — and `featureDrill`, exported from the same module and written in the same commit, was not.
// It had no caller at all, and clicking a feature node was a dead click until a maintainer found it.
// A list you must remember to extend does not catch the thing you forgot.
//
// So this half is DERIVED: every function a projection module exports must be CALLED somewhere other
// than its own body. That is a weaker claim than the list above makes — a sibling caller satisfies it,
// which is right, because a helper reached only from its module's entry point genuinely does run
// (`surfaceGraph` is the standing example, and demanding a component call it would be wrong). It is
// strictly stronger than nothing, and it is the exact claim that was false for `featureDrill`.
describe("every projection a graph library exports is called somewhere", () => {
  /** The modules whose whole job is projecting store rows into graph nodes. */
  const PROJECTION_RECORDS = ["feature-nodes.ts", "surface-nodes.ts"];

  const seed = JSON.parse(readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8")) as {
    implementations: { id: string; code?: string }[];
  };
  const byId = new Map(seed.implementations.map((i) => [i.id, i.code ?? ""]));
  /**
   * Every module body EXCEPT the one that defines the symbol, WITH EVERY DEFINITION SITE STRIPPED.
   *
   * Excluding the defining record by id is not enough, and the first draft of this guard was green
   * against a deliberately broken tree because of it: the packaged kit (`react-ui.json`) carries a
   * GENERATED copy of every record's source in its runtime map, so `export function featureDrill(`
   * appears there too — and a substring search for `featureDrill(` matched the copy's own definition.
   * The guard reported a call site that was a second copy of the declaration.
   *
   * Stripping `function <sym>(` removes declarations wherever they are copied to, while leaving real
   * calls intact. A sibling's call inside the module's own generated copy still counts, which is the
   * transitive-coverage rule stated above.
   */
  const elsewhere = (exclude: string, sym: string) => {
    const hay = [
      ...seed.implementations.filter((i) => i.id !== exclude).map((i) => i.code ?? ""),
      ...sources()
        .filter((s) => s.name !== "algorithms.json")
        .map((s) => s.text),
    ].join("\n");
    return hay.split(`function ${sym}(`).join("function \u0000(");
  };

  const cases = PROJECTION_RECORDS.flatMap((rec) =>
    [...(byId.get(rec) ?? "").matchAll(/export function (\w+)/g)].map((m) => [rec, m[1]] as [string, string]),
  );

  it("found the projection modules and their exports", () => {
    // Non-vacuity: a regex that stopped matching would report a clean sweep for the wrong reason.
    expect(PROJECTION_RECORDS.every((r) => byId.has(r))).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cases)("%s::%s has a call site", (rec, sym) => {
    const hay = elsewhere(rec, sym);
    expect(
      hay.includes(`${sym}(`),
      `${rec} exports ${sym} and NOTHING outside that module calls it. A projection with no call ` +
        `site draws nothing, and every other gate passes while it does — that is how the feature ` +
        `band shipped with no caller, and then the feature DRILL after it.`,
    ).toBe(true);
  });
});
