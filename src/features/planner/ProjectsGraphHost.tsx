// The Projects page host (#3874, epic #3604) — renders the Projects workspace FROM THE GRAPH. The page is
// sourced from the components graph (the `projectspage` node, seeded from `data/components/app/**`), not a
// bundled file. It registers the planner-list feature's injected platform surface (the card/rail/setup-page/
// modal components + the draft / local-published / projects.db derivations), then mounts `projectspage`
// through the runtime loader. Mirrors the fleet/automations/security/github/skills/mcp hosts.
//
// The CSS still ships as a normal bundled import here: the loader cannot resolve a CSS side-effect import,
// so it was stripped from the graph source and the host owns the stylesheet the page's classes need.
//
// NOT YET MOUNTED. The Projects LIST is a page inside the `ProjectsWorkspace` tabbed shell (alongside
// Planning / Designs / Algorithms), so the flip is the two `<ProjectsList />` sites in
// `features/planner/index.tsx` — the tear-off (`pageOverride`) path and the normal one — not the rail-level
// `lazyWorkspaces.tsx` slot. Both are marked in place. The reason it is deferred is
// verification, not doubt about the code: the loader's compile step is esbuild-wasm and BROWSER-ONLY
// (`componentLoader.test.ts` covers only the runtime half and says so), the e2e harness drives the preview
// srcdoc rather than app page records, and the epic accepted that verification here is real-Chromium or
// nothing. So the flip is left as a deliberate act taken while someone can watch the screen — the same
// dormant state Settings' graph records sit in today (#3758).
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
