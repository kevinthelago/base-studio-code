// The Projects page host (#3874, epic #3604) — renders the Projects workspace FROM THE GRAPH. The page is
// sourced from the components graph (the `projectspage` node, seeded from `data/components/app/**`), not a
// bundled file. It registers the planner-list feature's injected platform surface (the card/rail/setup-page/
// modal components + the draft / local-published / projects.db derivations), then mounts `projectspage`
// through the runtime loader. Mirrors the fleet/automations/security/github/skills/mcp hosts.
//
// The CSS still ships as a normal bundled import here: the loader cannot resolve a CSS side-effect import,
// so it was stripped from the graph source and the host owns the stylesheet the page's classes need.
//
// MOUNTED (#3874). Both `<ProjectsList />` sites in `features/planner/index.tsx` — the tear-off
// (`pageOverride`) path and the normal one — now render this host instead.
//
// HOW THE FLIP WAS VERIFIED, and why it had to be. The loader's compile step is esbuild-wasm and
// BROWSER-ONLY, so no headless check can prove this page renders — the epic accepted that verification here
// is real-Chromium or nothing. It was done against the RUNNING app (`bsc shot take` on a `tauri dev`
// instance), and that is what caught the one real defect: `ProjectsList` reaches
// `./published/ProjectRow` through a RE-EXPORT (`export { ProjectRow } from …`), which esbuild compiles to
// the same `require` an import produces. `graphPlatform` didn't register it and the seed test's import scan
// only matched `import … from`, so the page compiled, failed to resolve, and rendered its fallback — with a
// green suite. Both are fixed; the scan now covers `export … from` too.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerProjectsPlatform } from "./list/graphPlatform";
import "./projectsScreen.css";

export function ProjectsGraphHost() {
  // Registered at FIRST RENDER, not module load — unlike the other hosts, and deliberately.
  //
  // `graphPlatform` imports the planner-list siblings, which transitively import the planner barrel, which
  // imports this host. Registering in module scope therefore ran `registerProjectsPlatform()` *during* that
  // cycle, before `graphPlatform`'s own `let done` was initialised — a real `ReferenceError: Cannot access
  // 'done' before initialization`, caught by the seed test. Planner is the only feature whose barrel is deep
  // enough in its own import graph for this to bite.
  //
  // Render-time is still early enough: React renders this parent before the `GraphComponent` child whose
  // compiled `require()` reads the registry. Idempotent, so re-renders cost nothing.
  registerProjectsPlatform();

  // Fallback offers Reload-to-apply / Re-seed (#3648/#3652) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="projectspage"
      fallback={<GraphPageFallback page="Projects" icon="◧" />}
    />
  );
}
