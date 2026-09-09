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
import { registerMcpPlatform } from "@/features/mcp/graphPlatform";
import { registerLogsPlatform } from "@/features/logs/graphPlatform";
import { registerSkillsPlatform } from "@/features/skills/graphPlatform";
import { registerGlancePlatform } from "@/features/glance/graphPlatform";
import { registerSoundsPlatform } from "@/features/sounds/graphPlatform";
import { registerAlgorithmsPlatform } from "@/features/algorithms/graphPlatform";
import { registerConsolePlatform } from "@/app/console/graphPlatform";
// SIX REGISTRARS ARE DELIBERATELY ABSENT — `registerDebugPlatform`, `registerDesignsPlatform`,
// `registerPersonasPlatform`, `registerStudioSessionsPlatform`, `registerTeamsPlatform`,
// `registerTunnelPlatform` (record-links-is-red-on-develop).
//
// They used to arrive INCIDENTALLY, via a barrel side effect; when the barrels stopped doing that
// (ensure-platform-imports-the-platform-not-the-barrel) this file imported them DIRECTLY to keep
// itself green. That made the guard resolve six surfaces **nothing registers at runtime**: measured,
// each has zero callers outside its own definition and this file, and `shadowPages`'s `ensurePlatform`
// covers a different set (algorithms, automations, fleet, glance, logs, mcp, settings, skills, sounds).
//
// So the guard was more permissive than the runtime it stands for — the exact failure its own comments
// warn about twice below — and 24 records with imports resolving to nothing sailed past it, visible
// only to the opt-in `e2e/recordLinks.spec.ts`. Restoring these six imports makes this file green while
// the app stays broken. If a specifier needs to resolve, register it in `appModules` where the runtime
// will actually see it.
import { isAppModule } from "@/shared/lib/runtime/moduleRegistry";
// READS THE COMMITTED STORE, not the packaged seed (`retire-the-packaged-seed-directories`). The seed
// used to be the right source here for a stated reason — it is what ships, and a guard has to hold on a
// fresh clone and in CI where no local runtime store exists. Both halves of that are now true of
// `graph/algorithms.json` + `graph/records/*.json`, which is git-tracked, and it is what `bsc-emit`
// materializes `.bsc-records/` from and what `graph-materialize` compiles 25 crates from. Left on the
// seed, this guard would police a copy nothing compiles.
import { loadImplementations } from "@scripts/lib/recordStore.mjs";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { runtimeImports } from "../../../scripts/lib/recordSource.mjs";

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
 *  `import { type A, B }` still requires, so only the whole-statement form is skipped.
 *
 *  SHARED with `bsc ui promote-seed` rather than restated. Promotion is the act this guard
 *  judges, so a promoter reading imports differently is wrong in whichever direction it differs: more
 *  permissive and it packages a record that turns this suite red; STRICTER and it silently refuses
 *  records that were always fine — which is what it did, blocking 170 modules on `import type` and on the
 *  word `from` appearing in a comment. Two regexes that agree today are the setup for that, not a
 *  safeguard against it. */
const importsOf = runtimeImports;

beforeAll(() => {
  // The REAL registration path, not a duplicated list — a list would drift from the thing it describes,
  // which is the bug class this file exists to prevent.
  registerPlatformModules();
  registerAutomationsPlatform();
  registerMcpPlatform();
  registerLogsPlatform();
  registerSkillsPlatform();
  registerGlancePlatform();
  registerSoundsPlatform();
  registerAlgorithmsPlatform();
  registerConsolePlatform();
});

describe("the platform-kernel boundary (#3858)", () => {
  it("has records to check — the glob still resolves", () => {
    // Non-vacuity: if the glob ever stops matching, every assertion below passes while checking nothing.
    expect(RECORDS.length).toBeGreaterThan(50);
  });

  it("has the IMPLEMENTATION half too — a vacuous store load resolves every import", () => {
    // The impl `provides` set is the third resolution path (see below), so an empty load does not fail
    // — it reports every migrated module as a broken import, or, once the specifier moves, silently
    // stops answering. `loadImplementations()` reads the committed store off disk relative to the cwd,
    // which is exactly the kind of thing that returns `[]` rather than throwing.
    const impls = (loadImplementations() ?? []) as { provides?: string }[];
    expect(impls.length, "the committed store loaded no implementations").toBeGreaterThan(600);
    expect(impls.filter((im) => im.provides?.startsWith("@/")).length).toBeGreaterThan(500);
  });

  it("EVERY packaged record's first-party imports resolve", () => {
    const ids = new Set(RECORDS.map((r) => r.id));
    const provides = new Set(RECORDS.map((r) => r.provides?.trim()).filter(Boolean) as string[]);
    // The THIRD resolution path, and the third place that has had to learn it (after `routeImport` itself
    // and the e2e harness): a logic module authored as an ALGORITHM record, matched on the same `provides`
    // field. A retired module's specifier resolves here and NOWHERE else, so omitting this reports every
    // migrated module as a broken import — a false alarm about the change that just landed.
    const implProvides = new Set(
      ((loadImplementations() ?? []) as { provides?: string }[])
        .map((im) => im.provides?.trim())
        .filter(Boolean) as string[],
    );
    const unresolved: string[] = [];

    for (const r of RECORDS) {
      for (const spec of importsOf(r.srcText ?? "")) {
        // #4224: a BARE specifier is checked too. This used to `continue` — "the import-map's
        // concern" — but the import map belongs to the PREVIEW; the loader's `makeRequire` demands
        // every specifier be registered, first-party or not. `zustand/react/shallow` sailed past this
        // guard and failed in the browser, which is the same shape as the `src`-path rule #4188
        // removed: a check more permissive than the runtime it stands for.
        // #4232: a RELATIVE specifier is not skipped either — it is REJECTED. The loader routes `./x`
        // to the registry under that literal key, so it needs a registration exactly like an absolute
        // one, and `provides` (which matches on the exact specifier) can never reach it. `projectspage`
        // was the only record in the library that carried them — the one page transcribed by hand rather
        // than by a generator — and `list/graphPlatform.ts` compensated by registering BOTH spellings of
        // every sibling. Regenerating that record absolute retired the workaround, so the rule is now
        // simply: records carry absolute specifiers.
        if (spec.startsWith(".")) { unresolved.push(`${r.id} → ${spec} (relative — records must import absolutely)`); continue; }
        // The THREE ways a first-party specifier resolves at runtime — exactly what `routeImport` +
        // `makeRequire` do, and nothing more. There used to be a fourth: a record whose `src` matched the
        // specifier's path counted as resolved. The LOADER HAS NO SUCH RULE — `src` is provenance
        // metadata, not a resolution route — so the guard was passing specifiers that throw by name at
        // runtime. #4185's real-Chromium harness caught four of them in Glance (GraphCanvas, TabBar,
        // IconButton, previewReview) that this file had waved through, and #4188 removed the rule.
        if (isAppModule(spec)) continue;                                   // a registered platform module
        if (provides.has(spec)) continue;                                  // a graph component that PROVIDES it
        if (implProvides.has(spec)) continue;                              // an ALGORITHM record that provides it
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
