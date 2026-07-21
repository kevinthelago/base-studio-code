// The algorithm-kind classifier (#3210, epic #3209) — the heuristic that infers an algorithm's
// MANIPULATION kind (`sort`/`search`/`traversal`/`accumulate`) from its name/id/tags (+ a light code
// hint). This is the SAFETY NET: the creator SHOULD type an algorithm at creation (`bsc graph impl set
// --kind`), and this fills the gap for untyped impls so they still animate. `resolveKind` (in the viz
// registry) prefers the assigned `kind` and only falls back here.
//
// A Rust twin lives in `bsc-graph` for the `bsc graph doctor` / `--fix` scan (#3212); keep the two aligned
// (the graphHealth twin pattern). Deliberately conservative: an unrecognized algorithm returns `null`
// (no false type) rather than guessing.
import type { AlgoImpl, AlgoKind } from "./knowledge";

/** The signals we read — name + id (hyphenated ids tokenize the words) + tags + code. */
export type Classifiable = Pick<AlgoImpl, "name" | "id" | "code" | "tags">;

/**
 * Infer an algorithm's kind from its name/id/tags, else a light code hint, else `null`. Ordered so
 * ambiguous names disambiguate: **traversal** first (a `…-first-search` / bfs / dfs is a traversal, not a
 * search), then the exact **sort**, then **search**, then **accumulate**.
 */
export function classifyKind(impl: Classifiable): AlgoKind | null {
  const hay = `${impl.name} ${impl.id} ${(impl.tags ?? []).join(" ")}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));

  if (has("bfs", "dfs", "traverse", "traversal", "walk", "breadth-first", "depth-first")) return "traversal";
  if (has("sort")) return "sort";
  if (has("transpose", "rotate", "reflect", "transform", "flip", "mirror")) return "transform";
  if (has("search", "find", "lookup", "bisect")) return "search";
  if (has("fib", "factorial", "prefix-sum", "prefixsum", "accumulate", "cumulative", "reduce", "scan")) return "accumulate";

  // Light code-pattern fallbacks for un-obvious names (kept minimal — names carry most of the signal).
  const code = (impl.code ?? "").toLowerCase();
  if (/\bmid\b/.test(code) && /\b(lo|low|hi|high)\b/.test(code)) return "search"; // lo/hi/mid bisection
  if (/\bswap\b/.test(code) || /\[[^\]]+\],\s*[a-z0-9_[\].]+\s*=\s*\[/.test(code)) return "sort"; // element swap

  return null;
}
