// The Algorithms page ↔ `bsc graph dump` bridge (#2856) — the live hydrate over the packaged seed.
// Mirrors extractionBridge/themeBridge: `loadGraph` returns `null` when the bridge is unreachable (the
// web shell, the tests, or an OLD bundled `bsc` without the `graph dump` verb from #2853) so the page
// keeps rendering the embedded seed rather than blanking. The whole-graph doc `bsc graph dump` returns
// is shape-gated (nodes + edges must be arrays) before it's trusted, matching themeBridge's discipline.
import { bscJson } from "@/shared/lib/core/bsc";
import { buildKnowledge, type KnowledgeGraph, type RawKnowledge } from "./knowledge";

/** Run `bsc graph dump` and build the {@link KnowledgeGraph} from the librarian's writable store
 *  (`~/.base-studio-code/knowledge/algorithms.json`, #2853). `null` on ANY failure — an unreachable
 *  bridge, an old `bsc` without the verb, non-JSON output, or a payload whose `nodes`/`edges` aren't
 *  arrays — so a degraded environment simply shows the packaged seed. */
export async function loadGraph(): Promise<KnowledgeGraph | null> {
  try {
    const doc = await bscJson<{ nodes?: unknown; edges?: unknown; implementations?: unknown } | null>(
      null,
      ["graph", "dump"],
      null,
    );
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;
    // `implementations` is optional/additive — an old binary or a bare store may omit it; buildKnowledge
    // defaults it to [].
    return buildKnowledge(doc as unknown as RawKnowledge);
  } catch {
    return null;
  }
}
