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
}: {
  id: string;
  props?: Record<string, unknown>;
  fallback?: ReactNode;
}): ReactNode {
  const source = useAppStore((s) => s.components.find((c) => c.id === id)?.srcText);
  const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to loading on each (id, source) change */
    setLoaded(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!source) return;
    loadComponentFromSource(source, resolveGraphSource) // vendor sibling panels (#3606)
      // setState((prev) => …) treats a function arg as an UPDATER — a component IS a function, so wrap it.
      .then((c) => { if (!cancelled) setLoaded(() => c); })
      .catch(() => { if (!cancelled) setLoaded(null); }); // fall through to fallback (a load error → fallback)
    return () => { cancelled = true; };
  }, [id, source]);

  if (!Loaded) return fallback;
  return (
    <GraphErrorBoundary key={`${id}:${source?.length ?? 0}`} fallback={fallback}>
      <Loaded {...(props ?? {})} />
    </GraphErrorBoundary>
  );
}
