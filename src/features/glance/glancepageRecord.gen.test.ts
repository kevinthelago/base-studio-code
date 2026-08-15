// The glancepage record ↔ file GUARD + generator
// (#the-glance-record-lost-the-architect-and-four-other-fixes).
//
// THE BUG THIS PINS, and why a normal test could not have caught it. Glance renders the `glancepage`
// RECORD, not `GlanceWorkspace.tsx` — `lazyWorkspaces.tsx` aliases the workspace to `GlanceGraphHost`,
// which mounts `<GraphComponent id="glancepage" />` (#4185, epic #3604). So the `.tsx` is dead code at
// runtime unless something keeps the record in step with it. Nothing did: the record was mirrored BY
// HAND in bc3f38d1 (2026-08-12) and then drifted, losing FIVE shipped fixes — the architect drill, the
// contract re-read, plan.db outranking the persisted fleet, the progress ref-namespace split, and the
// director progress fallback. Every one passed typecheck, lint and the whole vitest suite, because all
// of them were correct IN THE FILE. The file was simply not what ran.
//
// That is the shape of the failure: not a broken assertion anywhere, but an absent one. This test is
// the missing assertion. It is deliberately a `.gen.test.ts` in the same mould as
// `reactUiKit.gen.test.ts` — the generator and the drift guard are ONE file, so the only way to
// satisfy the guard is to regenerate, and regenerating is what ships the fix.
//
//     UPDATE_RECORDS=1 npx vitest run glancepageRecord.gen
//
// SEED, NOT STORE. This writes the packaged seed under `src-tauri/data/components/`. The live
// `components.db` record is reseeded from that seed, so the seed is what makes a fix survive; pushing
// only to the store leaves the next reseed free to revert it (the mechanism behind requests #61/#63).
// Landing this therefore also needs `bsc ui set` against the running store — the seed alone updates
// what a FRESH install renders, not what this machine is rendering right now.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectGlancePage, GRAPH_SOURCE_HEADER } from "./lib/glancepageProjection";

const SRC_FILE = join(process.cwd(), "src/features/glance/GlanceWorkspace.tsx");
const SEED_FILE = join(process.cwd(), "src-tauri/data/components/app/features/glance/glancepage.json");

/** LF-normalized, so the check is identical on every platform (the tree is `* text=auto eol=lf`). */
const readLf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the glancepage record is the projection of GlanceWorkspace.tsx", () => {
  it("stays in sync with the file (UPDATE_RECORDS=1 to regenerate)", () => {
    const projected = projectGlancePage(readLf(SRC_FILE));
    const seed = JSON.parse(readLf(SEED_FILE));

    if (process.env.UPDATE_RECORDS) {
      // Rewrite ONLY `srcText`. The rest of the record — id/name/kitId/role/src/folder/props/composes —
      // is authored metadata that the file cannot express, so regenerating it from the source would
      // destroy it. 2-space JSON + a trailing newline matches the committed formatting.
      seed.srcText = projected;
      writeFileSync(SEED_FILE, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
      return;
    }

    // The failure message has to name the REAL consequence, because the diff on its own reads as a
    // cosmetic mismatch between two copies of the same thing — which is exactly how this went unnoticed.
    expect(
      seed.srcText,
      "the glancepage record has drifted from GlanceWorkspace.tsx. Glance RENDERS THE RECORD, so " +
      "whatever is missing here is missing from the running app no matter how correct the file is. " +
      "Regenerate with `UPDATE_RECORDS=1 npx vitest run glancepageRecord.gen`.",
    ).toBe(projected);
  });
});

describe("the projection reproduces what the runtime loader needs", () => {
  // GUARD THE GUARD. The sync assertion above is satisfied just as well by a projection that is wrong
  // in the same way on both sides — it only proves seed == f(file), never that `f` is right. These pin
  // the three deliberate transformations, so a projection that silently stopped doing one of them
  // fails HERE rather than shipping a record the loader cannot compile.
  const projected = projectGlancePage(readLf(SRC_FILE));

  it("keeps the AS GRAPH SOURCE preamble ahead of the file's own header", () => {
    expect(projected.split("\n").slice(0, 4)).toEqual(GRAPH_SOURCE_HEADER);
  });

  it("leaves NO relative specifier — the loader resolves against the registry, not a directory", () => {
    const relative = projected.split("\n").filter((l) => /from "\.\.?\//.test(l));
    expect(relative, `unresolved relative imports:\n${relative.join("\n")}`).toEqual([]);
  });

  it("routes sibling COMPONENTS to their graph records, not to feature paths", () => {
    // The two resolve differently, and getting this wrong yields a path that type-checks nowhere and
    // fails only at runtime, inside the loader.
    expect(projected).toContain('from "@/components/glance-canvas"');
    expect(projected).toContain('from "@/components/glance-chat-dock"');
    expect(projected).not.toContain('from "@/features/glance/GlanceCanvas"');
  });

  it("strips the CSS side-effect import the loader cannot resolve", () => {
    expect(readLf(SRC_FILE)).toContain('import "./glance.css";'); // the file really does have it…
    expect(projected).not.toContain("glance.css"); // …and the record really must not.
  });

  it("carries the five fixes the drift had silently dropped", () => {
    // Named individually rather than asserted as one blob: each was a separate shipped change that was
    // live in the file and dead in the app, and naming them is what makes a future regression legible.
    for (const needle of [
      "isArchitectNodeId",          // the architect drill (#architect-node-expands-into-system-sessions)
      "buildArchitectFleetData",    //   …and the graph it expands into
      "isStudioDrill",              //   …the predicate that keeps its six behaviours together
      "hydrateProjectLinks",        // the contract re-read (#architect-wires-project-relationships)
      "streamDoneWithDirector",     // the director progress fallback (#4122)
      "knownRefs",                  // the progress ref-namespace split
      "closedByRef",                //   …and the Plan screen's half of it
    ]) {
      expect(projected, `${needle} must reach the record — the app runs the record`).toContain(needle);
    }
    // plan.db outranking the persisted mirror is an ORDERING, so it is pinned by shape, not by a name.
    expect(projected).toContain("loadedFleet && loadedFleet.streams.length > 0 ? loadedFleet : storeFleet");
  });
});
