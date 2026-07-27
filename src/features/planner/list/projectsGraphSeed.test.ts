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

/** Every `from "…"` specifier in a source text. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/^\s*import\s[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("projectspage record (#3874)", () => {
  it("carries the REAL page source, not a transcription", () => {
    // The #3833 failure was a record that looked plausible and was far smaller than the source it claimed
    // to be. Pin the record against the actual file: same size (bar the stripped CSS import) and the same
    // distinctive internals, so a future reduction cannot pass quietly.
    expect(record.srcText.length).toBeGreaterThan(25_000);
    expect(Math.abs(record.srcText.length - sourceText.length)).toBeLessThan(200);
    for (const marker of ["filterProjects", "mergeDbDrafts", "buildProjectItems", "ProjectsRail"]) {
      expect(record.srcText, `record retains ${marker}`).toContain(marker);
    }
    // …and it is the graph-side copy: the CSS side-effect import the loader cannot resolve is stripped.
    expect(record.srcText).not.toMatch(/^import\s+"[^"]*\.css";/m);
    expect(sourceText).toMatch(/^import\s+"[^"]*\.css";/m);
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
