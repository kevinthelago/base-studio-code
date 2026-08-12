// The shadow catalogue ↔ reality contract (#4169, epic #3604).
//
// A shadow report's worst failure mode is a QUIET one: a page missing from the catalogue, a file path
// that matches nothing, a record id that no longer exists. Each of those reads as "nothing to report" —
// the same output as "no drift" — and the coverage data the epic is now steering by would be quietly
// short. So every half of the mapping is pinned against the thing it claims to describe: the seed records
// on disk, the raw glob, and the workspace wiring that decides what actually renders.
import { describe, it, expect } from "vitest";
import { SHADOW_PAGES, globbedFiles } from "./shadowPages";
import lazyWorkspacesSource from "@/app/lazyWorkspaces.tsx?raw";

/** The packaged graph records — the same glob `seed.ts` seeds the component library from. */
const seedRecords = import.meta.glob<{ id: string; role?: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});
const records = Object.values(seedRecords);

describe("the shadow page catalogue", () => {
  // `role: "page"` is TWO populations, which is why this asserted over the wrong set for a long time.
  // Twelve records are APP SCREENS the shell navigates to; ten are page-shaped KIT COMPOSITIONS — the
  // shared Pages tier (#2505), the `KeptMountedPage` wrapper, the Telemetry/Teams galleries. A kit page
  // has no workspace and no host feature, so its entry's `ensurePlatform` could only import nothing.
  //
  // The split is read off the RECORD (`pageKind: "kit"`), never off an id list here: an exclusion list is
  // the tempting fix and the wrong one, because the next kit page joins it by being forgotten. Marked on
  // the record, a new kit page declares itself and a new APP SCREEN still fails this until catalogued.
  it("covers EVERY migrated app screen — a new one cannot slip past the report", () => {
    const appScreens = records.filter((r) => r.role === "page" && r.pageKind !== "kit").map((r) => r.id).sort();
    expect(appScreens.length, "there are app-screen records to cover").toBeGreaterThan(0);
    expect(SHADOW_PAGES.map((p) => p.pageId).sort()).toEqual(appScreens);
  });

  it("the kit tier is MARKED, not merely uncatalogued — the exclusion is a stated fact", () => {
    // Without this, deleting every `pageKind` would make the guard above pass vacuously by widening the
    // catalogue's expected set to nothing it does not already contain... in the wrong direction.
    const kit = records.filter((r) => r.role === "page" && r.pageKind === "kit").map((r) => r.id);
    expect(kit.length, "the kit page tier is marked on the records").toBeGreaterThan(0);
    expect(kit.filter((id) => SHADOW_PAGES.some((p) => p.pageId === id)), "no kit page is catalogued").toEqual([]);
  });

  it("names records that exist", () => {
    const ids = new Set(records.map((r) => r.id));
    const missing = SHADOW_PAGES.flatMap((p) => p.modules.map((m) => m.recordId)).filter((id) => !ids.has(id));
    expect(missing, `catalogue entries with no seed record: ${missing.join(", ")}`).toEqual([]);
  });

  it("names files the raw glob actually resolves", () => {
    // A path the glob does not match loads as `null`, which the runner reports as "no file baseline" —
    // indistinguishable from a deliberately deleted file. This is what keeps those two apart.
    const globbed = new Set(globbedFiles());
    const declared = SHADOW_PAGES.flatMap((p) => p.modules.map((m) => m.file)).filter((f): f is string => f !== null);
    expect(declared.filter((f) => !globbed.has(f)), "declared files the glob missed").toEqual([]);
    expect(globbedFiles().filter((f) => !declared.includes(f)), "globbed files no entry uses").toEqual([]);
  });

  it("declares fleet as graph-only — its files were deleted with the first cutover", () => {
    const fleet = SHADOW_PAGES.find((p) => p.pageId === "fleetpage");
    expect(fleet?.modules.every((m) => m.file === null)).toBe(true);
  });

  // Four page copies lived in their feature's index barrel and were dead — `lazyWorkspaces` resolved
  // each workspace symbol to that feature's GraphHost, so the app mounted the RECORD and never the
  // file. They were removed. Each entry therefore declares `file: null` (read as "no file baseline"),
  // and the glob above no longer names those `index` files — the two halves have to move together or
  // the test above catches it. Their PART modules are untouched: a page going graph-only does not
  // take its parts with it.
  // The counts fall as files are RELEASED FOR DELETION (graph-retire-shadow-and-generators): a released
  // entry goes `file: null` here and leaves the glob, ahead of the `git rm`, because the per-stream
  // deletion item does not own this file and so cannot flip it itself.
  const RETIRED_PAGE_COPIES: Record<string, number> = {
    mcppage: 0,        // mcp-analytics RELEASED — this page is now wholly record-only
    securitypage: 1,   // AssignmentsTab only — Profiles/Activity/Flow DELETED once their merge landed
    automationspage: 0,   // Schedules DELETED once its three-way merge landed — wholly record-only now
    githubpage: 0,        // BranchGraph + the eight summary/ cards went in the code-fallback cut too
  };

  for (const [pageId, parts] of Object.entries(RETIRED_PAGE_COPIES)) {
    it(`declares ${pageId} as graph-only, with ${parts} part module(s) still file-backed`, () => {
      const page = SHADOW_PAGES.find((p) => p.pageId === pageId);
      expect(page, `${pageId} is in the catalogue`).toBeTruthy();
      expect(page?.modules.find((m) => m.recordId === pageId)?.file, `${pageId} page module`).toBeNull();
      expect(page?.modules.filter((m) => m.file !== null), `${pageId} part modules`).toHaveLength(parts);
    });
  }

  it("reports what each page renders from TODAY, matching the workspace wiring", () => {
    // `rendersFrom` is the context every number in the report is read against — a `differs` verdict on a
    // graph-rendered page is a live problem, the same verdict on a file-rendered one is a not-yet. It is
    // decided in lazyWorkspaces.tsx (a graph host ⇒ graph), so it is read back from there rather than
    // trusted — a page CAN be flipped back, as Settings was (#3758, and its graph copy deleted in #4183).
    const workspaceSymbols = new Map(
      [...lazyWorkspacesSource.matchAll(/export const (\w+)\s*=\s*lazy\([\s\S]*?default:\s*m\.(\w+)\s*\}/g)]
        .map((m) => [m[1], m[2]] as const),
    );
    const railWorkspace: Record<string, string> = {
      githubpage: "GitHubWorkspace",
      automationspage: "AutomationsWorkspace",
      mcppage: "McpWorkspace",
      skillspage: "SkillsWorkspace",
      securitypage: "SecurityWorkspace",
    };
    // Projects resolves to the planner's own workspace (which mounts the graph host inside it) and Fleet
    // is mounted by Glance, so neither is decidable from this file — they are excluded, not guessed.
    for (const [pageId, symbol] of Object.entries(railWorkspace)) {
      const resolved = workspaceSymbols.get(symbol);
      expect(resolved, `${symbol} is wired in lazyWorkspaces.tsx`).toBeTruthy();
      const rendersFrom = resolved?.endsWith("GraphHost") ? "graph" : "file";
      expect(SHADOW_PAGES.find((p) => p.pageId === pageId)?.rendersFrom, `${pageId} renders from`).toBe(rendersFrom);
    }
    // Settings is absent by design: rolled back in #3758 and its graph copy deleted in #4183, so it has
    // no record to compare and nothing for the catalogue to carry. Pinned so its return is deliberate.
    expect(SHADOW_PAGES.map((p) => p.pageId)).not.toContain("settingspage");
  });
});
