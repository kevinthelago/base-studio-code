// The visualization hook for an implementation (#3233). Resolving a viz is now ASYNC when the impl carries
// a stored `vizCode` (it is compiled + run in the sandbox Web Worker), so the sync `vizForImpl` became this
// hook: the in-app program (trusted, main-thread) shows IMMEDIATELY, and a stored `vizCode` — when the
// worker returns its frames — REPLACES it. A malformed / timed-out `vizCode` falls back to the program.

import { useEffect, useState } from "react";
import type { AlgoImpl } from "../lib/knowledge";
import { programVizForImpl, resolveVizExample, type VizExample } from "./examples/registry";

/**
 * The {@link VizExample} to render for `impl`, or `undefined` when it has none.
 *
 * The in-app program is derived synchronously during render, so an algorithm with an in-app viz never
 * flashes empty. A stored `vizCode` resolves asynchronously via the sandbox and, once ready, replaces the
 * program (it is the durable per-algorithm form). The resolved code-viz is kept KEYED by its code string,
 * so switching implementations never shows a previous impl's stored viz. `null` impl → `undefined`.
 */
export function useVizForImpl(impl: Pick<AlgoImpl, "id" | "name" | "vizCode"> | null): VizExample | undefined {
  // The in-app program — synchronous, trusted, stable identity (a singleton per base name).
  const program = impl ? programVizForImpl(impl) : undefined;
  const vizCode = impl?.vizCode?.trim() ?? "";

  // The sandbox-resolved stored viz, tagged with the code it came from (so it's never used for a different
  // impl before its own resolves). Only the async callback sets state — no synchronous setState-in-effect.
  const [resolved, setResolved] = useState<{ code: string; viz: VizExample | undefined }>({ code: "", viz: undefined });

  useEffect(() => {
    if (!vizCode) return;
    let cancelled = false;
    void resolveVizExample(vizCode).then((viz) => {
      if (!cancelled) setResolved({ code: vizCode, viz });
    });
    return () => {
      cancelled = true;
    };
  }, [vizCode]);

  const codeViz = resolved.code === vizCode ? resolved.viz : undefined;
  return codeViz ?? program;
}
