// The Algorithms page's knowledge-graph hydrate (#2856) — the live read over the packaged seed.
// `loadGraph` returns `null` when the read is unavailable (the web shell, the tests) so the page keeps
// rendering the embedded seed rather than blanking. The whole-graph doc is shape-gated
// (`implementations` must be an array) before it's trusted, matching themeBridge's discipline.
//
// IN-PROCESS since #4078 (`graph_dump`), not the `bsc` bridge. `useKnowledgeGraph` polls this every 5s
// while the page is mounted, and through the bridge every tick SPAWNED a subprocess — to read 84 KB,
// hash it, and discard the result because nothing had changed, which is the common case. The command
// calls `bsc_graph::load`, the CLI's own reader, so it resolves the same store and reconciles the same
// seed; the rows are byte-identical.
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { buildKnowledge, type KnowledgeGraph, type RawKnowledge } from "./knowledge";

/** Read the librarian's writable store (`~/.base-studio-code/knowledge/algorithms.json`, #2853) and
 *  build the {@link KnowledgeGraph}. `null` on ANY failure — an unavailable command, or a payload whose
 *  `implementations` isn't an array — so a degraded environment simply shows the packaged seed. */
export async function loadGraph(): Promise<KnowledgeGraph | null> {
  try {
    const doc = await safeInvoke<{ implementations?: unknown } | null>(
      "graph_dump",
      undefined,
      null,
    );
    if (!doc || !Array.isArray(doc.implementations)) return null;
    return buildKnowledge(doc as unknown as RawKnowledge);
  } catch {
    return null;
  }
}
