// The Sounds page host (#4215, epic #3604) — renders the Sounds pillar FROM THE GRAPH. The workspace and
// the three views it composes are sourced from the components graph (`soundspage` + siblings, seeded from
// `data/components/app/**`), not bundled files.
//
// Unlike the seven rail pages, this host is composed by ANOTHER PAGE: the planner Screen mounts it as one
// of its tabs. Nothing else about the recipe changes — the host registers the feature's injected platform
// surface at module load, then mounts the record through the runtime loader.
//
// The CSS ships as a normal bundled import here: the loader cannot resolve a CSS side-effect import, so it
// was stripped from the graph source and the host owns the stylesheet the page's classes need.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerSoundsPlatform } from "./graphPlatform";
import "./sounds.css";

registerSoundsPlatform();

export function SoundsGraphHost() {
  return <GraphComponent id="soundspage" fallback={<GraphPageFallback page="Sounds" icon="♪" />} />;
}
