// The projectspage record ↔ platform-surface contract (#3874, epic #3604).
//
// What this can and cannot check. The loader's COMPILE step is esbuild-wasm and browser-only, so no test
// here can prove the page renders — that is real-Chromium or nothing, and the epic accepted it. What IS
// checkable, and is the failure mode this migration can actually have, is the SURFACE: every specifier the
// record's source imports must resolve to something, or the loader silently falls through to the external
// path and the page loses that behaviour without erroring.
//
// #3833 is why this file exists. The Skills record shipped as a preview-grade transcription — sample data,
// none of the real wiring — and every revision after iterated on the reduced version for days, because the
// page still LOOKED right. A silent gap is the expensive kind here, so it gets a test rather than trust.
import { describe, it, expect, beforeAll } from "vitest";
import record from "@data/components/app/features/planner/projectspage.json";
import sourceText from "@/features/planner/list/ProjectsList.tsx?raw";
import { registerPlatformModules } from "@/app/runtime/appModules";
import { registerProjectsPlatform } from "./graphPlatform";
import { isAppModule, __resetRegistry } from "@/shared/lib/runtime/moduleRegistry";

// Exercise the REAL registration path — the shell's platform set plus the feature's own — rather than a
// duplicated list. A list would drift from the thing it claims to describe, which is the whole bug class here.
beforeAll(() => {
  __resetRegistry();
  registerPlatformModules();
  registerProjectsPlatform();
});

/** Every `from "…"` specifier in a source text — `import … from` AND `export … from`.
 *
 *  The re-export form is load-bearing here and was the gap this scan originally had: esbuild compiles
 *  `export { X } from "./y"` to the same `require("./y")` an import produces, so an unregistered
 *  re-export fails the loader at runtime exactly like an unregistered import. Scanning only `import`
 *  let `export { ProjectRow } from "./published/ProjectRow"` through, and the page fell back to its
 *  error state on the first real-browser mount. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("projectspage record (#3874)", () => {
  it("carries the REAL page source, not a transcription", () => {
    // The #3833 failure was a record that looked plausible and was far smaller than the source it claimed
    // to be. Pin the record against the actual file: same size (bar the stripped CSS import) and the same
    // distinctive internals, so a future reduction cannot pass quietly.
    expect(record.srcText.length).toBeGreaterThan(25_000);
    // ONE-SIDED since #4232, and that is the honest shape of the check. The failure this guards against
    // is a REDUCTION — a plausible-looking record far smaller than the source it claims to be — so the
    // record may not be meaningfully shorter than the file. It is legitimately LONGER: the record carries
    // a provenance header and its specifiers are absolute (`@/features/planner/list/ProjectCard` for
    // `./ProjectCard`), which only ever adds. A symmetric window would have to be widened every time a
    // specifier is renamed, and a guard you widen is a guard you stop reading. Structural drift is
    // covered properly by the record↔file parity guard (`src/app/runtime/graphParity.test.ts`), which
    // compares the two ignoring exactly those three things.
    expect(sourceText.length - record.srcText.length).toBeLessThan(200);
    for (const marker of ["filterProjects", "mergeDbDrafts", "buildProjectItems", "ProjectsRail"]) {
      expect(record.srcText, `record retains ${marker}`).toContain(marker);
    }
    // …and it is the graph-side copy: the CSS side-effect import the loader cannot resolve is stripped.
    expect(record.srcText).not.toMatch(/^import\s+"[^"]*\.css";/m);
    expect(sourceText).toMatch(/^import\s+"[^"]*\.css";/m);
  });

  it("exports the PAGE first — the export `pickComponent` will mount", () => {
    // `pickComponent` takes `default`, else the FIRST exported function. The bundled module re-exports
    // `ProjectRow` for its existing importers, and that re-export sits above `export function ProjectsList`
    // — so the graph copy mounted ProjectRow, which threw on `p.id` with no props and rendered the page's
    // fallback. The loader had already logged `mounted`, so nothing pointed at the cause. The graph copy
    // strips the re-export (the same treatment the CSS import gets, and for the same reason: it exists for
    // the bundled module's consumers, not for the graph).
    expect(sourceText, "the bundled module still re-exports ProjectRow for its importers")
      .toMatch(/^export\s*\{\s*ProjectRow\s*\}\s*from/m);
    expect(record.srcText, "the graph copy does NOT — it would be mounted instead of the page")
      .not.toMatch(/^export\s*\{[^}]*\}\s*from/m);
    // Whatever the source shape, the first thing `pickComponent` can reach must BE the page.
    const firstExport = /^export\s+(?:default\s+)?function\s+([A-Za-z0-9_]+)/m.exec(record.srcText)?.[1];
    expect(firstExport, "the first exported function is the page component").toBe("ProjectsList");
  });

  it("declares the page node's identity the loader mounts by", () => {
    expect(record.id).toBe("projectspage");
    expect(record.role).toBe("page");
    expect(record.kitId).toBe("base-studio-code");
  });

  it("EVERY import the source makes resolves to a registered platform module or a sibling", () => {
    // The silent-failure guard: an unresolved specifier does not throw, it falls through — so the page would
    // render minus that module's behaviour. Enumerate rather than trust.
    const specifiers = importsOf(record.srcText);
    // Non-vacuity guard: if the regex ever stops matching, `unresolved` is trivially empty and this test
    // passes while checking NOTHING. Pin the count so that failure is loud instead of silent.
    expect(specifiers.length, "the import scan still sees the page's imports").toBeGreaterThan(30);
    // …and it still sees the RE-EXPORT form. The record itself no longer HAS one (stripped, above), so
    // prove the widened scan against the bundled source that does — otherwise the day a record grows a
    // re-export, this scan silently skips it again, which is exactly how it shipped broken the first time.
    expect(importsOf(sourceText), "the scan covers `export … from` too").toContain("./published/ProjectRow");

    const unresolved = specifiers.filter((s) => !isAppModule(s));
    expect(unresolved, `unregistered specifiers: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("composes lists COMPONENTS only — the vocabulary the page draws with", () => {
    // Mirrors fleetpage.json's shape: no types, no consts, no hooks. A type leaking in here is harmless at
    // runtime but makes the graph's composition edges lie about what the page is built from.
    for (const name of record.composes) {
      expect(name, `${name} is PascalCase`).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect(name.startsWith("use"), `${name} is not a hook`).toBe(false);
      expect(name, `${name} is not a SHOUTING const`).not.toMatch(/^[A-Z0-9_]+$/);
    }
    expect(record.composes).toContain("ProjectCard");
    expect(record.composes).toContain("ProjectsRail");
  });
});
