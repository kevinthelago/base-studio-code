// GraphComponent (#3605, epic #3604) — mount a component LOADED FROM THE GRAPH, live, in the app tree.
//
// The whole point of the epic: the app's UI comes from the components graph, not bundled files. This host
// reads a component's `srcText` from the store, hands it to the runtime loader (compile → eval → real
// modules), and renders the result — with an ERROR BOUNDARY + fallback around it, because the loaded code
// is graph-authored: a compile error, an unresolved import, or a render throw must degrade to a fallback,
// never white-screen the shell. Re-loads when the store's source changes (a designer edit shows live).
import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import { resolveGraphSource } from "./graphResolver";
import { log } from "@/shared/lib/core/log";
import { ThemeProvider } from "@/shared/ui/kit";

// Per-id COMPILE counter (module-level, survives re-renders) — the loop probe. A healthy page compiles
// ONCE (`#1`) and never again, because the load effect keys on the srcText VALUE and a re-hydrate re-reads
// the same string (`Object.is` true → effect skipped). A fast-climbing `#N` in the `graph-loader` log means
// the source is churning (a new srcText value each hydrate) and the page is recompiling — the real lag risk.
const compileCounts = new Map<string, number>();

/** Catches a RENDER throw from the loaded component (load-time throws are caught by the effect below).
 *  Keyed by the caller so a new source remounts a fresh boundary (React boundaries don't self-reset). */
class GraphErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Render the graph component `id`, passing `props` through. `fallback` shows while loading and on any
 * failure (compile / unresolved import / render throw) — a graph render can never break the shell.
 */
export function GraphComponent({
  id,
  props,
  fallback = null,
  themeId,
}: {
  id: string;
  props?: Record<string, unknown>;
  fallback?: ReactNode;
  /** The theme to resolve for a `themeSystem: "js"` component (#3715) — passed to the wrapping
   *  `<ThemeProvider>`. Ignored for a CSS component (it follows the cascade). Absent ⇒ the base theme. */
  themeId?: string;
}): ReactNode {
  const source = useAppStore((s) => s.components.find((c) => c.id === id)?.srcText);
  // The theme SYSTEM this component renders under (#3715): "js" → wrap in <ThemeProvider> so it can read the
  // resolved token VALUES; "css"/absent → it follows the CSS cascade as today. A primitive selector (string
  // | undefined), so it never churns re-renders (mirrors the `srcText` selector above).
  const themeSystem = useAppStore((s) => s.components.find((c) => c.id === id)?.themeSystem);
  const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to loading on each (id, source) change */
    setLoaded(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!source) return;
    const n = (compileCounts.get(id) ?? 0) + 1;
    compileCounts.set(id, n);
    const startedAt = performance.now();
    log.info(`graph-loader: compile #${n} "${id}" (source ${source.length} chars)`, "graph-loader");
    loadComponentFromSource(source, resolveGraphSource) // vendor sibling panels (#3606)
      // setState((prev) => …) treats a function arg as an UPDATER — a component IS a function, so wrap it.
      .then((c) => {
        if (cancelled) return;
        log.info(`graph-loader: mounted "${id}" (compile #${n}) in ${Math.round(performance.now() - startedAt)}ms`, "graph-loader");
        setLoaded(() => c);
      })
      .catch((e) => {
        if (cancelled) return;
        log.warn(`graph-loader: "${id}" failed to load — falling back: ${String(e).slice(0, 160)}`, "graph-loader");
        setLoaded(null); // fall through to fallback (a load error → fallback)
      });
    return () => { cancelled = true; };
  }, [id, source]);

  if (!Loaded) return fallback;
  // A `themeSystem: "js"` component renders to a non-CSS surface — wrap it so `useResolvedTheme()` reaches it
  // (#3715). A "css"/absent component renders bare and follows the cascade, byte-identical to before.
  const el = <Loaded {...(props ?? {})} />;
  return (
    <GraphErrorBoundary key={`${id}:${source?.length ?? 0}`} fallback={fallback}>
      {themeSystem === "js" ? <ThemeProvider themeId={themeId}>{el}</ThemeProvider> : el}
    </GraphErrorBoundary>
  );
}
