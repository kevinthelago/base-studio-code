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
import { lastGood } from "./renderGate";
import { log } from "@/shared/lib/core/log";
import { ThemeProvider } from "@/shared/ui/kit";

// Per-id COMPILE counter (module-level, survives re-renders) — the loop probe. A healthy page compiles
// ONCE (`#1`) and never again, because the load effect keys on the srcText VALUE and a re-hydrate re-reads
// the same string (`Object.is` true → effect skipped). A fast-climbing `#N` in the `graph-loader` log means
// the source is churning (a new srcText value each hydrate) and the page is recompiling — the real lag risk.
const compileCounts = new Map<string, number>();

/** Catches a RENDER throw from the loaded component (load-time throws are caught by the effect below).
 *  Keyed by the caller so a new source remounts a fresh boundary (React boundaries don't self-reset).
 *
 *  It LOGS what it caught (#3874). A load failure has always logged; a render throw did not, so the two
 *  outcomes were indistinguishable from outside: the log said `mounted "projectspage"` while the screen
 *  showed the fallback, and finding the cause meant patching this class by hand. A graph page that renders
 *  its fallback is exactly when someone needs the reason, so it goes to the log with its stack. */
class GraphErrorBoundary extends Component<
  { id: string; fallback: ReactNode; children: ReactNode; onRenderThrow?: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    // Tell the host so the render gate can swap in the last version that worked. Reported from
    // componentDidCatch rather than render: the swap is a state change, and doing it during render would
    // be a setState-in-render on the parent.
    this.props.onRenderThrow?.();
    // One line per frame: the sink caps a single message, and a stack folded into one line gets truncated
    // to uselessness — which is what the by-hand version of this hit first.
    log.warn(`graph-loader: "${this.props.id}" RENDER THREW - falling back: ${String(error)}`, "graph-loader");
    for (const frame of String((error as Error)?.stack ?? "").split("\n").slice(1, 9)) {
      if (frame.trim()) log.warn(`graph-loader:   at ${frame.trim().slice(0, 200)}`, "graph-loader");
    }
    for (const frame of String(info?.componentStack ?? "").split("\n").slice(0, 8)) {
      if (frame.trim()) log.warn(`graph-loader:   in ${frame.trim().slice(0, 160)}`, "graph-loader");
    }
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
  exportName,
}: {
  id: string;
  props?: Record<string, unknown>;
  fallback?: ReactNode;
  /** Which export of the record to mount. A record provides a MODULE, and a module can export several
   *  components — `@/shared/ui/controls/Field` exports TextField, TextArea and SelectField — so a host
   *  mounting one of them must say WHICH, or the loader picks whichever function comes first. Absent ⇒
   *  the default/only export, the behaviour every existing caller relies on. */
  exportName?: string;
  /** The theme to resolve for a `themeSystem: "js"` component (#3715) — passed to the wrapping
   *  `<ThemeProvider>`. Ignored for a CSS component (it follows the cascade). Absent ⇒ the base theme. */
  themeId?: string;
}): ReactNode {
  const source = useAppStore((s) => s.components.find((c) => c.id === id)?.srcText);
  // The theme SYSTEM this component renders under (#3715): "js" → wrap in <ThemeProvider> so it can read the
  // resolved token VALUES; "css"/absent → it follows the CSS cascade as today. A primitive selector (string
  // | undefined), so it never churns re-renders (mirrors the `srcText` selector above).
  const themeSystem = useAppStore((s) => s.components.find((c) => c.id === id)?.themeSystem);
  // Both caches key on record + EXPORT, never the record alone: the same id serves a different component
  // per export, so an id-keyed `lastGood` would hand TextArea the component it cached for TextField.
  const cacheKey = exportName ? `${id}#${exportName}` : id;
  const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null);
  // The source the MOUNTED component was built from. Usually `source`; the last-good source when the gate
  // fell back. Kept apart from `source` so the good-marking effect can never mark the CURRENT (broken)
  // source good just because a fallback rendered under it.
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);

  /** Mount the last version that worked, if there is one and it is not the source we just tried. */
  const mountLastGood = (why: string): boolean => {
    const good = lastGood.get(cacheKey);
    if (!good || good.source === source) return false;
    log.warn(`graph-loader: "${id}" ${why} — rendering the last version that worked (${good.source.length} chars)`, "graph-loader");
    setLoaded(() => good.Comp);
    setActiveSource(good.source);
    setDegraded(true);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to loading on each (id, source) change */
    setLoaded(null);
    setActiveSource(null);
    setDegraded(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!source) return;
    const n = (compileCounts.get(cacheKey) ?? 0) + 1;
    compileCounts.set(cacheKey, n);
    const startedAt = performance.now();
    log.info(`graph-loader: compile #${n} "${id}" (source ${source.length} chars)`, "graph-loader");
    loadComponentFromSource(source, resolveGraphSource, exportName) // vendor sibling panels (#3606)
      // setState((prev) => …) treats a function arg as an UPDATER — a component IS a function, so wrap it.
      .then((c) => {
        if (cancelled) return;
        log.info(`graph-loader: mounted "${id}" (compile #${n}) in ${Math.round(performance.now() - startedAt)}ms`, "graph-loader");
        setLoaded(() => c);
        setActiveSource(source);
      })
      .catch((e) => {
        if (cancelled) return;
        log.warn(`graph-loader: "${id}" failed to load: ${String(e).slice(0, 160)}`, "graph-loader");
        // GATE, path 1 — it did not COMPILE. Prefer the last version that rendered over an empty surface.
        if (!mountLastGood("failed to compile")) setLoaded(null);
      });
    return () => { cancelled = true; };
    // `mountLastGood` is re-created each render and reads only `id`/`source`, which are already deps —
    // listing it would re-fire the effect on every render and recompile in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, exportName]);

  // MARK GOOD — after a commit in which the boundary did NOT catch. This effect cannot run for a render
  // that threw, which is exactly the distinction the gate needs: compiling is a weaker claim than
  // rendering. Only marks the source actually mounted, and only when it is the CURRENT one — a degraded
  // mount must never re-mark the good version as good for the broken source.
  useEffect(() => {
    if (!Loaded || degraded || !activeSource || activeSource !== source) return;
    const prev = lastGood.get(cacheKey);
    if (prev?.source === activeSource) return; // already known good — no churn
    lastGood.set(cacheKey, { source: activeSource, Comp: Loaded });
  }, [cacheKey, id, Loaded, activeSource, source, degraded]);

  if (!Loaded) return fallback;
  // A `themeSystem: "js"` component renders to a non-CSS surface — wrap it so `useResolvedTheme()` reaches it
  // (#3715). A "css"/absent component renders bare and follows the cascade, byte-identical to before.
  const el = <Loaded {...(props ?? {})} />;
  return (
    <GraphErrorBoundary
      // Keyed on the source ACTUALLY mounted, not the record's — a boundary does not self-reset, so
      // swapping in the last-good version has to give it a fresh one or it stays latched on `failed`
      // and renders the empty fallback over a component that works.
      key={`${id}:${activeSource?.length ?? 0}:${degraded ? "good" : "cur"}`}
      id={id}
      fallback={fallback}
      // GATE, path 2 — it COMPILED but threw while rendering. Same preference: the last version that
      // worked beats an empty surface. Guarded by `degraded` so a throw from the last-good version
      // itself cannot loop — it falls through to the caller's fallback, as before.
      onRenderThrow={degraded ? undefined : () => { mountLastGood("threw while rendering"); }}
    >
      {themeSystem === "js" ? <ThemeProvider themeId={themeId}>{el}</ThemeProvider> : el}
    </GraphErrorBoundary>
  );
}
