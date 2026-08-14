// The algorithms feature's store slice — the IMPLS the runtime resolver can reach.
//
// WHY A SLICE AND NOT `useKnowledgeGraph`. The Algorithms page already hydrates the live graph by
// polling `graph_dump` through that hook, and it stays the page's source. But `resolveGraphSource` is
// SYNCHRONOUS — `(specifier) => string | null`, reading a `getState()` snapshot — so it cannot invoke a
// Tauri command, and it lives in `shared/`, which may not import a feature. The only surface satisfying
// both is the app store, which is exactly how COMPONENTS already reach it (`hydrateComponents`, #3610).
// So this mirrors that path rather than inventing a second one.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { AlgoImpl } from "./lib/knowledge";
import { loadGraph } from "@/features/algorithms/lib/graphBridge";

export interface AlgorithmsSlice {
  /** Every implementation in the writable store — the set `resolveGraphSource` matches `provides` against.
   *  A CACHE, never persisted (#3610): it is re-read from the store at each boot. */
  algorithmImpls: AlgoImpl[];
  /** Read the librarian's writable store into memory. Idempotent; a no-op in a degraded environment. */
  hydrateAlgorithms: () => Promise<void>;
}

export const createAlgorithmsSlice: StateCreator<AppStore, [], [], AlgorithmsSlice> = (set) => ({
  algorithmImpls: [],
  hydrateAlgorithms: async () => {
    // `loadGraph` returns null on ANY failure — the web shell, the tests, an old `bsc` — so a degraded
    // environment simply resolves nothing rather than throwing during boot. Same contract the
    // Algorithms page already relies on.
    const graph = await loadGraph();
    if (!graph) return;
    set({ algorithmImpls: graph.implementations });
  },
});
