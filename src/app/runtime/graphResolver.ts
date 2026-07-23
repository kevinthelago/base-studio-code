// The store-backed graph-sibling resolver (#3606, epic #3604) — lets a graph component import ANOTHER graph
// component by id, so a page can compose its panels. Lives in `app/` because only the shell knows the store;
// the loader (shared/lib) stays store-agnostic and takes this as an injected [`GraphSourceResolver`].
import { useAppStore } from "@/store";
import type { GraphSourceResolver } from "@/shared/lib/runtime/componentLoader";

/** How a graph component imports a SIBLING by id: `import … from "@/components/<id>"`. There is no physical
 *  `@/components/` dir (feature-first killed the layer dirs, #1309), so this specifier never resolves to a
 *  real module — the loader intercepts it and vendors the sibling's source in its place. */
export const GRAPH_SIBLING_PREFIX = "@/components/";

/** Resolve `@/components/<id>` → that component's `srcText` from the LIVE store, for the loader to vendor.
 *  Reads a snapshot (`getState`), not a subscription: a page re-loads on ITS OWN source change (the host
 *  keys on that); a sibling edit reflects on the page's next load. Non-sibling specifiers return `null` so
 *  they stay external (→ the registry). */
export const resolveGraphSource: GraphSourceResolver = (specifier) => {
  if (!specifier.startsWith(GRAPH_SIBLING_PREFIX)) return null;
  const id = specifier.slice(GRAPH_SIBLING_PREFIX.length);
  return useAppStore.getState().components.find((c) => c.id === id)?.srcText ?? null;
};
