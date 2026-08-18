// Retiring a BARREL — the specifier a directory's `index.ts` actually answers.
//
// `promote-records.mjs` derives a module's specifier with `specOf`, which strips a trailing `/index`:
// `lib/plannerCore/index.ts` answers `@/features/planner/lib/plannerCore`. `retire-module.mjs` did not
// strip it, so it rewrote importers onto `@/features/planner/lib/plannerCore/index` — a specifier
// nothing provides — and left the DIRECTORY-form importers (`from "./lib/plannerCore"`) untouched
// because they did not match the `/index` path either. Three real files landed broken and typecheck
// caught it only after the module was already deleted.
//
// The two rules are pinned here rather than in the script, which runs on import and deletes files.
import { describe, it, expect } from "vitest";

/** The specifier a retired module answers — mirrors `retire-module.mjs`. */
const specifierFor = (rel: string) => `@/${rel.replace(/\/index$/, "")}`;

/** Does a relative import, resolved from `fromDir`, name the module being retired? */
function resolvesToTarget(fromDir: string, relSpec: string, rel: string) {
  const relSpecifier = rel.replace(/\/index$/, "");
  const out: string[] = [];
  for (const p of `${fromDir}/${relSpec}`.split("/")) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  const hit = out.join("/");
  return hit === rel || hit === relSpecifier;
}

describe("retiring a barrel", () => {
  it("addresses it by its DIRECTORY, not `/index`", () => {
    expect(specifierFor("features/planner/lib/plannerCore/index")).toBe("@/features/planner/lib/plannerCore");
    expect(specifierFor("features/studio-sessions/index")).toBe("@/features/studio-sessions");
  });

  it("leaves a non-barrel module's specifier alone", () => {
    expect(specifierFor("shared/lib/session/roleModel")).toBe("@/shared/lib/session/roleModel");
    // `indexed.ts` merely ENDS with the letters — only a whole `/index` segment is a barrel.
    expect(specifierFor("features/x/indexed")).toBe("@/features/x/indexed");
  });

  it("rewrites BOTH spellings of an importer — the directory form and the explicit `/index`", () => {
    const rel = "features/planner/lib/plannerCore/index";
    expect(resolvesToTarget("features/planner", "./lib/plannerCore", rel)).toBe(true);
    expect(resolvesToTarget("features/planner", "./lib/plannerCore/index", rel)).toBe(true);
    expect(resolvesToTarget("features/planner/lib/plannerSync", "../plannerCore", rel)).toBe(true);
  });

  it("does not rewrite a SIBLING that merely shares a prefix", () => {
    const rel = "features/planner/lib/plannerCore/index";
    expect(resolvesToTarget("features/planner", "./lib/plannerCoreExtra", rel)).toBe(false);
    expect(resolvesToTarget("features/planner", "./lib/plannerCore/types", rel)).toBe(false);
  });
});
