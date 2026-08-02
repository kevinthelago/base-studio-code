// The Algorithms page host (#4219, epic #3604) — renders the knowledge-graph workspace FROM THE GRAPH.
// The workspace and the four views it composes are sourced from the components graph (`algorithmspage` +
// siblings, seeded from `data/components/app/**`), not bundled files.
//
// Like Sounds (#4215), this host is composed by ANOTHER PAGE: the planner Screen lazy-mounts it as a tab.
// It registers the feature's injected platform surface at module load, then mounts the record through the
// runtime loader.
//
// A pleasing symmetry worth noting: this is the page for the ALGORITHMS graph, now itself rendered from
// the COMPONENTS graph. Two stores, same idea — the app's knowledge and the app's UI both as data.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerAlgorithmsPlatform } from "./graphPlatform";

registerAlgorithmsPlatform();

export function AlgorithmsGraphHost() {
  return <GraphComponent id="algorithmspage" fallback={<GraphPageFallback page="Algorithms" icon="∑" />} />;
}
