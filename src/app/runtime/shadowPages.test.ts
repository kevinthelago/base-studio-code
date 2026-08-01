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
  it("covers EVERY migrated page — a new one cannot slip past the report", () => {
    const pageRecords = records.filter((r) => r.role === "page").map((r) => r.id).sort();
    expect(pageRecords.length, "there are page records to cover").toBeGreaterThan(0);
    expect(SHADOW_PAGES.map((p) => p.pageId).sort()).toEqual(pageRecords);
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
