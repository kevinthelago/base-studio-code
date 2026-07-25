// The store-backed graph-sibling resolver (#3606, epic #3604) — lets a graph component import ANOTHER graph
// component by id, so a page can compose its panels. Feature-agnostic (it only reads `@/store`, which shared/
// may import), so it sits with the loader in shared/lib/runtime; the loader stays store-agnostic and takes
// this as an injected [`GraphSourceResolver`].
import { useAppStore } from "@/store";
import type { GraphSourceResolver } from "@/shared/lib/runtime/componentLoader";

/** How a graph component imports a SIBLING by id: `import … from "@/components/<id>"`. There is no physical
 *  `@/components/` dir (feature-first killed the layer dirs, #1309), so this specifier never resolves to a
 *  real module — the loader intercepts it and vendors the sibling's source in its place. */
export const GRAPH_SIBLING_PREFIX = "@/components/";

/** Resolve a graph import to `srcText` the loader vendors — reading a snapshot (`getState`), not a
 *  subscription: a page re-loads on ITS OWN source change (the host keys on that); a sibling/override edit
 *  reflects on the page's next load. Two forms resolve to graph source; anything else returns `null` so it
 *  stays external (→ the registry):
 *    1. `@/components/<id>` — a SIBLING by id (a page composing its panels, #3606).
 *    2. a component whose `provides` field equals the specifier — a graph component OVERRIDING a registered
 *       PLATFORM module (#3660), e.g. a shared/ui primitive authored as DATA. Graph-first: this is why
 *       `routeImport` consults the resolver before the registry. */
export const resolveGraphSource: GraphSourceResolver = (specifier) => {
  const components = useAppStore.getState().components;
  if (specifier.startsWith(GRAPH_SIBLING_PREFIX)) {
    const id = specifier.slice(GRAPH_SIBLING_PREFIX.length);
    return components.find((c) => c.id === id)?.srcText ?? null;
  }
  return components.find((c) => c.provides === specifier)?.srcText ?? null;
};
