// GraphComponent (#3605, epic #3604) — mount a component LOADED FROM THE GRAPH, live, in the app tree.
//
// The whole point of the epic: the app's UI comes from the components graph, not bundled files. This host
// reads a component's `srcText` from the store, hands it to the runtime loader (compile → eval → real
// modules), and renders the result — with an ERROR BOUNDARY + fallback around it, because the loaded code
// is graph-authored: a compile error, an unresolved import, or a render throw must degrade to a fallback,
// never white-screen the shell. Re-loads when the store's source changes (a designer edit shows live).
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import { resolveGraphSource } from "@/shared/lib/runtime/graphResolver";
import { lastGood } from "./renderGate";
import { recoveryLadder } from "@/shared/lib/runtime/recoveryLadder";
import { log } from "@/shared/lib/core/log";
import { attest, srcHash } from "@/shared/lib/runtime/attest";
import { ThemeProvider } from "@/shared/ui/kit";

// Per-id COMPILE counter (module-level, survives re-renders AND remounts) — the loop probe. A healthy page
// compiles ONCE (`#1`) and never again.
//
// A climbing `#N` has TWO causes, and the difference matters
// (#three-compiles-race-for-every-graph-page-mount). This comment used to name only the first:
//
//   1. THE SOURCE IS CHURNING — a new `srcText` value each hydrate. The effect keys on the srcText VALUE,
//      so an equal string is `Object.is` true and the effect is skipped; a climbing count therefore means
//      the value really is changing.
//   2. THE HOST IS REMOUNTING — this map is module-level, so it survives the remount that resets the
//      component's own state, and the count climbs with an IDENTICAL source. This is what the Console page
//      actually did: three compiles of the same 18,462 chars inside one second, 72 compiles for 24 mounts
//      across a whole log. Reading that as churn sends you hunting a hydration bug that is not there.
//
// The two are told apart by the `(source N chars)` in the log: a constant N across a climbing #N is a
// remount, a varying N is churn.
const compileCounts = new Map<string, number>();

/**
 * IN-FLIGHT compiles, keyed by record + export (never the record alone — see `cacheKey`).
 *
 * WHY (#three-compiles-race-for-every-graph-page-mount): each remount started its OWN compile of the
 * identical source, so three raced and two were discarded — which is why the surviving mount took ~2.1s
 * rather than the ~700ms one compile costs. A remount whose source matches an entry here awaits THAT
 * promise instead of starting a second compile.
 *
 * This is the same in-flight join the `bsc` read coalescer uses, and for the same reason: two identical
 * pieces of work happening at the same moment should never be two pieces of work.
 *
 * IN-FLIGHT ONLY — an entry is evicted the moment its promise settles, and that is deliberate. Keeping
 * settled compiles would make returning to a page instant, but a compile vendors its SIBLINGS at build
 * time (#3606) while the load effect re-fires only on this record's OWN source; a retained entry would
 * therefore serve a remount a component built from stale siblings, trading the designer's live-edit loop
 * for speed. Everything after the race is left exactly as it was.
 *
 * NOT a replacement for {@link lastGood}, which is a different and stronger claim: this is what
 * COMPILED, `lastGood` is what actually RENDERED without the boundary catching, and only that is
 * eligible to serve as a degraded fallback.
 */
const compiles = new Map<
  string,
  { source: string; n: number; promise: Promise<ComponentType<Record<string, unknown>>> }
>();

/** Drop every in-flight compile — for tests, which must see each mount reach the loader rather than
 *  joining an entry a previous test left behind. */
export function resetGraphCompiles(): void {
  compiles.clear();
  compileCounts.clear();
}

/** Catches a RENDER throw from the loaded component (load-time throws are caught by the effect below).
 *  Keyed by the caller so a new source remounts a fresh boundary (React boundaries don't self-reset).
 *
 *  It LOGS what it caught (#3874). A load failure has always logged; a render throw did not, so the two
 *  outcomes were indistinguishable from outside: the log said `mounted "projectspage"` while the screen
 *  showed the fallback, and finding the cause meant patching this class by hand. A graph page that renders
 *  its fallback is exactly when someone needs the reason, so it goes to the log with its stack. */
class GraphErrorBoundary extends Component<
  { id: string; fallback: ReactNode; children: ReactNode; onRenderThrow?: () => void; srcHash?: string },
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
    // RENDER THREW — distinct from every decline above: this record compiled, linked, evaluated AND
    // mounted, so nothing upstream refused it. Only a render caught it, which is the one failure the
    // loader's own decline paths structurally cannot see.
    attest({
      specifier: this.props.id,
      recordId: this.props.id,
      srcHash: this.props.srcHash,
      outcome: "render-threw",
      reason: String(error).slice(0, 200),
    });
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
   *  mounting one of them must say WHICH. Absent ⇒ defaults to the record's OWN name (#121), which is
   *  what makes an id-only mount self-correct for a record whose module carries a foreign sibling ahead
   *  of its own definition; only a record whose own name matches no export at all falls through to
   *  `pickComponent`'s default/first-export behaviour. */
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
  // The DURABLE half of the gate: the sources this record's own change history retained. `lastGood` below
  // is per-session and therefore empty on a fresh boot, which is precisely when a bad write does its
  // damage — the 02:00 incident's five records were rewritten, the app was restarted, and the first
  // version the gate ever saw of each was the broken one. These rungs live in the store, so they survive
  // the restart. Selected as the ARRAY (not the record) so an unrelated field moving cannot re-render.
  const history = useAppStore((s) => s.components.find((c) => c.id === id)?.history);
  // How many ALGORITHM impls the resolver can currently see. `resolveGraphSource` reads them from the
  // store as a SNAPSHOT at compile time, and `useAppBoot` fires `hydrateComponents()` and
  // `hydrateAlgorithms()` as parallel `void` calls — so a page whose record imports an algorithm-record
  // specifier (the Projects page imports `@/shared/hooks/useFleetLive`) can compile the instant its own
  // source lands, while the impls are still `[]`, and fail with "is not a registered app module".
  //
  // Losing that race used to be PERMANENT: the load effect keys on the page's own source, which never
  // changes afterwards, so the impls arriving re-fired nothing and the page sat on its fallback until a
  // reload — which just runs the same race again. A COUNT is the right dependency: a primitive that goes
  // 0 → N exactly once, so it cannot churn renders the way selecting the array would.
  const implCount = useAppStore((s) => s.algorithmImpls.length);
  // Both caches key on record + EXPORT, never the record alone: the same id serves a different component
  // per export, so an id-keyed `lastGood` would hand TextArea the component it cached for TextField.
  //
  // Absent `exportName` resolves to the record's OWN name (#121-pickComponent-mounts-wrong-export): a
  // record's module can carry a foreign sibling ahead of its own definition — `Field.tsx` is one file
  // with `Field`, `TextField`, `TextArea` and `SelectField`, and a record transcribed from it for one of
  // the latter three still opens with `Field` — and `pickComponent` falls back to whichever export comes
  // first in source order when it has no name to match against. Resolving it here fixes every existing
  // id-only caller in one place; `pickComponent` still refuses to guess when the name matches nothing and
  // the module is ambiguous.
  const componentName = useAppStore((s) => s.components.find((c) => c.id === id)?.name);
  const resolvedExportName = exportName ?? componentName;
  const cacheKey = resolvedExportName ? `${id}#${resolvedExportName}` : id;
  const [Loaded, setLoaded] = useState<ComponentType<Record<string, unknown>> | null>(null);
  // The source the MOUNTED component was built from. Usually `source`; the last-good source when the gate
  // fell back. Kept apart from `source` so the good-marking effect can never mark the CURRENT (broken)
  // source good just because a fallback rendered under it.
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  /** What is currently mounted, as `{ key, source }` — the load effect's "already done" check.
   *
   *  A ref rather than state because the effect both READS and WRITES it: as a dep it would loop, and as
   *  state it would trail a render behind the thing it guards. Cleared whenever a load starts, so a
   *  failed attempt leaves it null and the next resolver-input change is free to retry. */
  const mountedRef = useRef<{ key: string; source: string } | null>(null);

  /** Mount the last version that worked, if there is one and it is not the source we just tried. */
  const mountLastGood = (why: string): boolean => {
    const good = lastGood.get(cacheKey);
    if (!good || good.source === source) return false;
    log.warn(`graph-loader: "${id}" ${why} — rendering the last version that worked (${good.source.length} chars)`, "graph-loader");
    // Attested against the CURRENT source's hash, not the one that served. The finding is "this version
    // did not run"; recording the good version's hash would instead assert that an older version ran —
    // true, but it is the fact that hides the problem rather than the one that reveals it.
    attest({ specifier: id, recordId: id, srcHash: source ? srcHash(source) : undefined, outcome: "fell-back", reason: why });
    setLoaded(() => good.Comp);
    setActiveSource(good.source);
    setDegraded(true);
    return true;
  };

  /** Walk the record's retained history, mounting the newest rung that compiles.
   *
   *  The tier BELOW `mountLastGood`, reached when this session never saw a version work — a fresh boot
   *  onto a record a designer broke while the app was down. Each rung is compiled on demand (unlike
   *  `lastGood`, which holds an already-built component), so this costs a compile per rung tried; it runs
   *  only on the failure path, where the alternative is an empty surface or a dead app.
   *
   *  Deliberately does NOT write `lastGood`: a rung that compiles has not yet RENDERED, and conflating
   *  the two is the distinction the gate is built on. It mounts inside the same error boundary, so a rung
   *  that compiles and then throws falls through to the caller's fallback exactly as before. */
  const mountFromHistory = async (why: string): Promise<boolean> => {
    const rungs = recoveryLadder(history, source);
    for (const rung of rungs) {
      try {
        const Comp = await loadComponentFromSource(rung, resolveGraphSource, resolvedExportName);
        log.warn(
          `graph-loader: "${id}" ${why} and this session has no last-good — falling back to a retained ` +
            `earlier version from the record's history (${rung.length} chars). Recover it properly with ` +
            `\`bsc ui revert ${id}\`.`,
          "graph-loader",
        );
        setLoaded(() => Comp);
        setActiveSource(rung);
        setDegraded(true);
        return true;
      } catch {
        // This rung is broken too — try the one before it. A record can accumulate several bad writes in
        // a row, which is exactly what a designer working around breakage produces.
      }
    }
    return false;
  };

  useEffect(() => {
    // ALREADY MOUNTED FROM THIS EXACT SOURCE ⇒ nothing to do. The guard exists for `implCount`: that dep
    // is here so a page whose compile LOST the hydration race gets a second chance, and without this the
    // impls landing would tear down and recompile every graph page on screen — trading one broken surface
    // for a boot-wide stall of ~700ms per page. Read from a ref rather than from `Loaded`, which cannot
    // be a dep (the effect sets it, so listing it would loop).
    if (mountedRef.current?.key === cacheKey && mountedRef.current.source === source) return;
    let cancelled = false;
    // Nothing is mounted from the source we are about to try. Clearing it here is what leaves a FAILED
    // attempt retryable: the guard above then lets the next resolver-input change back in.
    mountedRef.current = null;
    /* eslint-disable react-hooks/set-state-in-effect -- reset to loading on each (id, source) change */
    setLoaded(null);
    setActiveSource(null);
    setDegraded(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!source) return;
    // JOIN an existing compile of this exact source rather than starting a second one
    // (#three-compiles-race-for-every-graph-page-mount). A source that CHANGED never joins — the entry is
    // replaced — so a designer edit is always compiled fresh and is never served a stale component.
    const startedAt = performance.now();
    let entry = compiles.get(cacheKey);
    if (entry && entry.source === source) {
      log.info(`graph-loader: joined compile #${entry.n} "${id}" — no second compile`, "graph-loader");
    } else {
      const n = (compileCounts.get(cacheKey) ?? 0) + 1;
      compileCounts.set(cacheKey, n);
      log.info(`graph-loader: compile #${n} "${id}" (source ${source.length} chars)`, "graph-loader");
      const promise = loadComponentFromSource(source, resolveGraphSource, resolvedExportName); // vendor sibling panels (#3606)
      entry = { source, n, promise };
      compiles.set(cacheKey, entry);
      // EVICT ON SETTLE — this is an in-flight join, deliberately NOT a compile cache. A compile
      // vendors its SIBLINGS at build time (#3606) while the effect only re-fires on this record's own
      // source, so a settled entry kept around would serve a remount a component built from stale
      // siblings — trading the designer's live-edit loop for speed. Identity-checked so a newer entry
      // for a changed source is never evicted by an older one settling late.
      const evict = () => { if (compiles.get(cacheKey) === entry) compiles.delete(cacheKey); };
      promise.then(evict, evict);
    }
    const { n } = entry;
    entry.promise
      // setState((prev) => …) treats a function arg as an UPDATER — a component IS a function, so wrap it.
      .then((c) => {
        if (cancelled) return;
        const ms = performance.now() - startedAt;
        log.info(`graph-loader: mounted "${id}" (compile #${n}) in ${Math.round(ms)}ms`, "graph-loader");
        // SERVED (#runtime-attests-what-actually-ran) — the strongest claim in the store: this record,
        // at THIS source version, is what the app rendered. `srcHash` is what makes it a claim about a
        // VERSION rather than about a name, so a later edit does not inherit this evidence.
        //
        // `n` rides along as the compile ordinal. A healthy page compiles once; a climbing count is
        // either source churn or a remount storm, and this is what lets `doctor` see the second — the
        // loop that cost Console ~2.1s for work one compile does in ~700ms, invisible to every gate.
        attest({ specifier: id, recordId: id, srcHash: srcHash(source), outcome: "served", ms });
        mountedRef.current = { key: cacheKey, source };
        setLoaded(() => c);
        setActiveSource(source);
      })
      .catch((e) => {
        if (cancelled) return;
        log.warn(`graph-loader: "${id}" failed to load: ${String(e).slice(0, 160)}`, "graph-loader");
        // GATE, path 1 — it did not COMPILE. Prefer the last version that rendered over an empty surface,
        // then a version the record's own history retained, then the caller's fallback.
        if (mountLastGood("failed to compile")) return;
        void mountFromHistory("failed to compile").then((recovered) => {
          if (!cancelled && !recovered) setLoaded(null);
        });
      });
    return () => { cancelled = true; };
    // `mountLastGood` is re-created each render and reads only `id`/`source`, which are already deps —
    // listing it would re-fire the effect on every render and recompile in a loop.
    //
    // `implCount` IS a dep, and deliberately: `resolveGraphSource` reads `algorithmImpls` as a snapshot at
    // compile time, so a page that compiled before they hydrated resolved nothing and stayed failed
    // forever. It re-fires only for a surface the guard above did not short-circuit — i.e. one with
    // nothing mounted from the current source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, resolvedExportName, implCount]);

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
      // The hash of what is ACTUALLY mounted — which on a degraded mount is the last-good source, not
      // the record's current one. A throw is then attributed to the version that threw.
      srcHash={activeSource ? srcHash(activeSource) : undefined}
      fallback={fallback}
      // GATE, path 2 — it COMPILED but threw while rendering. Same preference: the last version that
      // worked beats an empty surface, then a retained earlier one. Guarded by `degraded` so a throw from
      // a fallback version itself cannot loop — it falls through to the caller's fallback, as before.
      //
      // This is the path the null-dispatcher failure takes: a hook resolving against the wrong React
      // instance compiles perfectly well and only throws once something mounts it, which is why a
      // syntax-level write gate could never have caught it.
      onRenderThrow={
        degraded
          ? undefined
          : () => {
              if (!mountLastGood("threw while rendering")) void mountFromHistory("threw while rendering");
            }
      }
    >
      {themeSystem === "js" ? <ThemeProvider themeId={themeId}>{el}</ThemeProvider> : el}
    </GraphErrorBoundary>
  );
}
