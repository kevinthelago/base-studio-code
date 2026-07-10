// The Algorithms page ↔ `bsc graph extract` bridge (#2777, Phase 2 slice 2). Mirrors themeBridge.ts:
// `runExtract` returns `null` when the bridge is unreachable — the web shell, the tests, or an OLD
// bundled `bsc` without the `graph extract` verb — so the page keeps its no-badges state rather than
// throwing. Kept thin + defensive: the ExtractResult shape is validated (all three arms must be arrays)
// before it's trusted, matching themeBridge's shape-gate discipline.
import { bsc } from "@/shared/lib/core/bsc";
import type { Tech } from "./knowledge";
import type { ExtractResult } from "./extraction";

/** Run `bsc graph extract <dir> [--tech <tech>]` and parse the {@link ExtractResult}; `null` on ANY
 *  failure — an unreachable bridge, an old `bsc` without the verb, non-JSON output, or a payload whose
 *  `matched`/`unmatched`/`duplicates` aren't all arrays. A degraded environment therefore simply shows
 *  no badges rather than surfacing an error. */
export async function runExtract(dir: string, tech?: Tech): Promise<ExtractResult | null> {
  try {
    const out = await bsc(null, ["graph", "extract", dir, ...(tech ? ["--tech", tech] : [])]);
    const parsed = JSON.parse(out.trim() || "null") as Partial<ExtractResult> | null;
    if (
      !parsed ||
      !Array.isArray(parsed.matched) ||
      !Array.isArray(parsed.unmatched) ||
      !Array.isArray(parsed.duplicates)
    ) {
      return null;
    }
    // `calls` (#2779) is additive — an OLD bundled `bsc` omits it, so default to `[]` rather than
    // rejecting the whole payload, keeping the page working against a pre-call-graph binary.
    return {
      matched: parsed.matched,
      unmatched: parsed.unmatched,
      duplicates: parsed.duplicates,
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    };
  } catch {
    return null;
  }
}
