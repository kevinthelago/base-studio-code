// useKnowledgeGraph (#2856) — the Algorithms page's live graph. Starts on the packaged seed for an
// instant first paint, then hydrates from the writable store (`bsc graph dump`, #2853) so the knowledge
// librarian's `bsc graph set`/`link`/`remove` edits show — polled, since the page is kept-mounted and a
// live session can curate at any time. The seed is the fallback (persist/seed = cache, the store is the
// source of truth — the golden rule); a degraded environment (web shell, tests, old `bsc`) just keeps
// the seed because `loadGraph` returns null.
import { useRef, useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { KNOWLEDGE, type KnowledgeGraph } from "./lib/knowledge";
import { loadGraph } from "./lib/graphBridge";

/** How often to re-read the store. The dump is a fast local read; the librarian edits show within a tick. */
const HYDRATE_MS = 5000;

/** An order-independent content signature — so an unchanged store (serde may reorder JSON keys) does NOT
 *  churn a re-render every tick, while any implementation edit does. */
function graphSig(g: KnowledgeGraph): string {
  return g.implementations
    .map((im) => `${im.id}:${im.tech}:${im.role}:${im.name}:${im.summary ?? ""}:${im.composes.join(",")}`)
    .sort()
    .join("|");
}
const SEED_SIG = graphSig(KNOWLEDGE);

/** The live knowledge graph: the seed, hydrated + kept fresh from the writable store. */
export function useKnowledgeGraph(): KnowledgeGraph {
  const [graph, setGraph] = useState<KnowledgeGraph>(KNOWLEDGE);
  // The signature currently rendered — start on the seed so a store that still equals the seed never
  // triggers a redundant swap; only a real edit does.
  const appliedSig = useRef(SEED_SIG);
  usePoll(
    async (isCancelled) => {
      const g = await loadGraph();
      if (isCancelled() || !g) return; // unreachable / old bsc → keep the current graph
      const sig = graphSig(g);
      if (sig === appliedSig.current) return; // no change → no re-render
      appliedSig.current = sig;
      setGraph(g);
    },
    HYDRATE_MS,
  );
  return graph;
}
