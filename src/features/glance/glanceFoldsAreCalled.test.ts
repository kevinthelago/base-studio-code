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
  const FOLDS: [string, string][] = [["withSurfaceNodes", "surface-nodes.ts"]];

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
