// The platform-kernel boundary guard (#3858, part of #3856).
//
// The packaged kit artifact carries a completeness invariant — every first-party import in everything it
// would emit resolves. **The app's OWN UI had no such guard.**
//
// #3858 measured it as broken — 5 of 92 records short by three specifiers. Writing this guard showed that
// measurement was a FALSE ALARM: all six occurrences are `import type`, which erases at compile time and
// emits no require. The boundary was clean; the analysis counted type-only imports as runtime deps. (The
// Rust doctor already got this right, and #3901 hit the same distinction with `@/app/console/lib/models`.)
//
// It still needs a guard. A record is compiled at RUNTIME by
// `componentLoader`, so an unresolved `@/…` is not a build error — the loader falls through and the page
// renders its fallback, or worse renders minus that module's behaviour. Exactly the silent-degradation
// class #3892/#3895 spent two issues undoing. So the invariant gets a test.
//
// It reads the SEED (`data/components/app/**`), not the live store: the seed is what ships, and the guard
// has to hold on a fresh clone and in CI where no local store exists.
import { describe, it, expect, beforeAll } from "vitest";
import platformModules from "@data/ui/platform-modules.json";
import { registerPlatformModules } from "@/app/runtime/appModules";
import { registerAutomationsPlatform } from "@/features/automations/graphPlatform";
import { registerGithubPlatform } from "@/features/github/graphPlatform";
import { registerMcpPlatform } from "@/features/mcp/graphPlatform";
import { registerSecurityPlatform } from "@/features/security/graphPlatform";
import { registerSkillsPlatform } from "@/features/skills/graphPlatform";
import { registerGlancePlatform } from "@/features/glance/graphPlatform";
import { registerFleetPlatform } from "@/features/planner/fleet/graphPlatform";
import { registerProjectsPlatform } from "@/features/planner/list/graphPlatform";
import { registerPanePlatform } from "@/features/planner/pane/graphPlatform";
import { isAppModule } from "@/shared/lib/runtime/moduleRegistry";

interface SeedRecord {
  id: string;
  kitId?: string;
  src?: string;
  srcText?: string;
  provides?: string;
  suppressed?: boolean;
}

// Every packaged app record, exactly as it ships.
const seedModules = import.meta.glob<{ default: SeedRecord }>("@data/components/app/**/*.json", { eager: true });
const RECORDS: SeedRecord[] = Object.values(seedModules)
  .map((m) => m.default)
  .filter((r) => r && r.id && r.suppressed !== true);

/** Every RUNTIME `from "…"` specifier.
 *
 *  Includes `export … from`, since esbuild compiles a re-export to the same `require` an import produces
 *  (the #3874 defect). EXCLUDES `import type` / `export type`, which erase at compile time and emit no
 *  require at all — counting them is what made #3858 read as broken when it was not. A MIXED
 *  `import { type A, B }` still requires, so only the whole-statement form is skipped. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

beforeAll(() => {
  // The REAL registration path, not a duplicated list — a list would drift from the thing it describes,
  // which is the bug class this file exists to prevent.
  registerPlatformModules();
  registerAutomationsPlatform();
  registerGithubPlatform();
  registerMcpPlatform();
  registerSecurityPlatform();
  registerSkillsPlatform();
  registerGlancePlatform();
  registerFleetPlatform();
  registerProjectsPlatform();
  registerPanePlatform();
});

describe("the platform-kernel boundary (#3858)", () => {
  it("has records to check — the glob still resolves", () => {
    // Non-vacuity: if the glob ever stops matching, every assertion below passes while checking nothing.
    expect(RECORDS.length).toBeGreaterThan(50);
  });

  it("EVERY packaged record's first-party imports resolve", () => {
    const ids = new Set(RECORDS.map((r) => r.id));
    const provides = new Set(RECORDS.map((r) => r.provides?.trim()).filter(Boolean) as string[]);
    const unresolved: string[] = [];

    for (const r of RECORDS) {
      for (const spec of importsOf(r.srcText ?? "")) {
        if (!spec.startsWith("@/")) continue; // bare npm specifiers are the import-map's concern
        // The THREE ways a first-party specifier resolves at runtime — exactly what `routeImport` +
        // `makeRequire` do, and nothing more. There used to be a fourth: a record whose `src` matched the
        // specifier's path counted as resolved. The LOADER HAS NO SUCH RULE — `src` is provenance
        // metadata, not a resolution route — so the guard was passing specifiers that throw by name at
        // runtime. #4185's real-Chromium harness caught four of them in Glance (GraphCanvas, TabBar,
        // IconButton, previewReview) that this file had waved through, and #4188 removed the rule.
        if (isAppModule(spec)) continue;                                   // a registered platform module
        if (provides.has(spec)) continue;                                  // a graph component that PROVIDES it
        const id = spec.startsWith("@/components/") ? spec.slice("@/components/".length) : null;
        if (id && ids.has(id)) continue;                                   // a sibling BY ID
        unresolved.push(`${r.id} → ${spec}`);
      }
    }

    expect(unresolved, `unresolved first-party imports:\n  ${unresolved.join("\n  ")}`).toEqual([]);
  });

  it("the generated manifest is what the registry actually holds", () => {
    // The manifest is data the Rust doctor embeds; if it drifts from the live registry the two analyzers
    // disagree about what resolves, and the doctor starts crying wolf (#3897).
    for (const spec of platformModules as string[]) {
      expect(isAppModule(spec), `${spec} is in the manifest but not registered`).toBe(true);
    }
  });
});
