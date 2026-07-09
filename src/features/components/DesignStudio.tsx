// Design Studio (#2308) — the full-page component workbench, the standalone Rail workspace body (#2303).
// An IDE-style page over the SAME global component library the planner's condensed `PlannerComponentsPane`
// (#2314) browses. It's a Page in the Planner Screen (the PageTabs strip is its header — no page toolbar):
// a resizable kits→components tree rail (the kit switcher + the search box under its header), the
// composition GRAPH as the one-and-only center view — its header holds fit + Share (#2453 — the former
// Library center mode is
// folded into the inspector), and a resizable inspector carrying the full per-component detail: live
// preview (variant / theme / viewport switchers + the render-error card), Overview / Source / Usage tabs,
// and the generate-variants design bar.
//
// It reuses the pure domain (`lib/model`), the shared specimen renderer (`renderSpecimen`), the shared
// graph stack (`GraphCanvas` + `ZoomControls` + `useGraphViewport` + `graphEdge`, #2418; the top-down
// hierarchy layout lives in `lib/compositionLayout`, #2455), and `useDragResize` — so it stays
// on-architecture and the planner Kickoff pane is untouched. Data comes from the global store via the
// `bsc ui` bridge.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { KitShareModal } from "./KitShareModal";
import { KitChangesCard, SeedNoticesCard } from "./KitChangesCard";
import { DesignerTerminal } from "./DesignerTerminal";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { layoutComposition, selectionNeighborhood, NODE_W, NODE_H, type CompositionLayout } from "./lib/compositionLayout";
import { analyzeGraphHealth, HEALTH_SEVERITY, type HealthCategory } from "./lib/graphHealth";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { RoleDot } from "./kitChrome";
import { matchesQuery, resolveComposes, NO_COMPONENTS_TITLE, type ComponentRecord, type Kit } from "./lib/model";
import { useUiActivity } from "./lib/uiActivity";
import { groupKits, type KitTreeNode } from "./lib/kitGroups";
import { renderSpecimen, type PreviewTheme } from "./specimens";
import { SPECIMEN_FIXTURES } from "./specimenFixtures";
import type { PrimitiveName } from "@/shared/ui/manifest";
import { ThemeScope, DEFAULT_THEME } from "@/shared/ui/kit";
import type { KitThemeRecord } from "./lib/themes";
import "./designStudio.css";

type Tab = "overview" | "source" | "usage";
type Viewport = "sm" | "md" | "auto";
const VP: Record<Viewport, { w: string; label: string }> = {
  sm: { w: "380px", label: "375 · mobile" },
  md: { w: "640px", label: "768 · tablet" },
  auto: { w: "100%", label: "fluid · fills panel" },
};

// The role dot + kit chip live in kitChrome.tsx (#2420) — shared with the Planner Components pane.

export function DesignStudio() {
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);
  // The hydrated kit-THEME collection (#2488) — feeds the preview's palette switcher.
  const kitThemes = useAppStore((s) => s.kitThemes);
  // The node the designer AI is currently working (#2525) — a `.working` pulse + auto-pan target.
  const aiFocusedId = useAppStore((s) => s.aiFocusedId);

  const firstFor = (kitId: string) => components.find((c) => c.kitId === kitId);
  const [kitId, setKitId] = useState(() => kits[0]?.id ?? "");
  // The FOCUSED component (#2705) — null when nothing is focused, which hides the details pane and
  // gives the graph full width. Focusing a node (or a rail row) sets it; clicking the canvas clears it.
  const [compId, setCompId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [variant, setVariant] = useState(() => firstFor(kits[0]?.id ?? "")?.variants[0] ?? "default");
  // The preview's THEME axis (#2488) — ONE control now (#2545): the selected theme drives both the
  // component retint (its `vars`, via <ThemeScope>) AND the sandbox SURFACE (its `base`, below). The
  // old hardcoded dark/light SegmentedControl is retired — light/dark is theme data served through
  // the same `bsc ui theme` collection, so the picker grows as themes are authored.
  const [kitTheme, setKitTheme] = useState<string>(DEFAULT_THEME);
  // The sandbox surface for `renderSpecimen`, read off the selected theme's `base` (absent ⇒ dark).
  const theme: PreviewTheme = kitThemes.find((t) => t.id === kitTheme)?.base ?? "dark";
  const [vp, setVpKind] = useState<Viewport>("auto");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [kits[0]?.id ?? ""]: true }));
  const [renderKey, setRenderKey] = useState(0); // bumped by "Retry render" after a preview error
  const [shareOpen, setShareOpen] = useState(false); // the share/import kits modal (#2305 slice 1c)
  // Live-focus (#2525): the designer session is ALWAYS mounted (#2597), so poll its activity stream
  // for the whole Design Studio lifecycle; clear the focus when the studio unmounts.
  useUiActivity(true);
  useEffect(() => () => useAppStore.getState().setAiFocused(null), []);

  const rail = useDragResize({ initial: 266, min: 200, max: 400, axis: "x" });
  // The inspector carries the full library detail (#2453), so it defaults — and is allowed — wider.
  const insp = useDragResize({ initial: 420, min: 300, max: 680, axis: "x", invert: true });
  // The always-on designer terminal's height (#2624) — a row-resize handle above it; `invert` because
  // the terminal sits AFTER the handle, so dragging up grows it. The graph (flex:1) keeps priority.
  const term = useDragResize({ initial: 240, min: 140, max: 560, axis: "y", invert: true });

  const match = (c: ComponentRecord) => matchesQuery(c, query);
  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  const kitComps = useMemo(() => components.filter((c) => c.kitId === kitId), [components, kitId]);
  // The FOCUSED component (#2705) — strictly the one the user picked, in the current kit. No fallback
  // to "the first" — when nothing is focused `sel` is null, so the details pane is hidden and the graph
  // takes the full width.
  const sel = compId ? components.find((c) => c.id === compId && c.kitId === kitId) ?? null : null;

  const allVariants = sel ? sel.variants : [];
  const activeVariant = allVariants.includes(variant) ? variant : allVariants[0] ?? "default";
  const composes = sel ? resolveComposes(sel, components) : [];

  const selectKit = (id: string) => {
    // Switching kit re-scopes the graph but focuses nothing — the details pane stays hidden until the
    // user picks a node in the new kit.
    setKitId(id); setCompId(null); setExpanded((e) => ({ ...e, [id]: true })); setTab("overview");
  };
  const selectComp = (c: ComponentRecord) => {
    if (c.kitId !== kitId) setKitId(c.kitId);
    setCompId(c.id); setVariant(c.variants[0] ?? "default"); setTab("overview");
  };
  // Clicking anything other than a node (the canvas background) unfocuses → hides the details pane.
  const deselect = () => setCompId(null);

  // ── graph layout (#2455) — hierarchical top-down: composers above, dependencies below, role-tier
  // banding for edge-less nodes, `used`-desc ordering within a row. Pure model: lib/compositionLayout.
  const graph = useMemo(() => layoutComposition(kitComps), [kitComps]);
  // Graph health (#2680) — the same taxonomy `bsc ui doctor` reports (lib/graphHealth), mirrored to
  // badge dead/duplicated nodes. `nodeHealth` maps each flagged node to its MOST-SEVERE category.
  const healthFindings = useMemo(() => analyzeGraphHealth(kitComps), [kitComps]);
  const nodeHealth = useMemo(() => {
    const m = new Map<string, HealthCategory>();
    for (const f of healthFindings) for (const id of f.nodeIds) {
      const cur = m.get(id);
      if (!cur || HEALTH_SEVERITY[f.category] > HEALTH_SEVERITY[cur]) m.set(id, f.category);
    }
    return m;
  }, [healthFindings]);

  const gvp = useGraphViewport(graph.world);
  const gvpFit = gvp.fit;
  useEffect(() => { gvpFit(); }, [kitId, gvpFit]); // re-fit on mount + whenever the kit switches
  // Auto-pan the AI-touched node into view (#2525) — center it, keeping zoom (least-disruptive). Only
  // when the node lives in the CURRENT kit's graph; a touch in another kit just doesn't pan.
  const gvpCenter = gvp.centerOn;
  useEffect(() => {
    if (!aiFocusedId) return;
    const pos = graph.pos.get(aiFocusedId);
    if (pos) gvpCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2);
  }, [aiFocusedId, graph, gvpCenter]);

  // ── rail hierarchy (#2487, policy fixed by #2506) — ALWAYS technology → style; a single-kit style
  // header IS the kit (lib/kitGroups), so the packaged library reads React → Studio → components.
  const railTree = useMemo(() => groupKits(kits), [kits]);

  if (!kit) return <StudioEmpty />;

  // One rail kit entry: the collapsible kit head + its (search-filtered) component rows. Under the
  // #2506 single-kit style merge this IS the style header — `label` shows the style name instead of
  // the kit name (the kit identity stays in the tooltip), and no separate kit row renders.
  const renderRailKit = (k: Kit, label?: string) => {
    const open = !!expanded[k.id];
    const inKit = components.filter((c) => c.kitId === k.id);
    const rows = inKit.filter(match);
    return (
      <Box key={k.id} style={{ marginBottom: 4 }}>
        <Box as="button" className={`ds-kithead${k.id === kitId ? " active" : ""}`} title={label ? `${label} · ${k.name} — ${k.stack}` : k.stack} onClick={() => { setKitId(k.id); setExpanded((e) => ({ ...e, [k.id]: !e[k.id] })); }}>
          <Text as="span" className="ds-caret" style={{ transform: open ? "rotate(90deg)" : "none" }}>▸</Text>
          <ColorSwatch color={k.dot} size={7} />
          <Text as="span" weight={500} style={{ flex: 1, textAlign: "left" }}>{label ?? k.name}</Text>
          <Text mono size="xxs" tone="dim">{inKit.length}</Text>
        </Box>
        {open && (
          <Box style={{ margin: "2px 0 6px", paddingLeft: 6 }}>
            {rows.map((c) => (
              <Box as="button" key={c.id} className={`ds-comprow${c.id === compId && k.id === kitId ? " on" : ""}`} onClick={() => selectComp(c)}>
                <RoleDot role={c.role} size={7} glow={3} />
                <Text as="span" style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</Text>
                <Text mono size="xxs" tone="dim" style={{ padding: "1px 5px", background: "var(--bg-soft)", borderRadius: 4 }}>×{c.used}</Text>
              </Box>
            ))}
            {open && rows.length === 0 && query && (
              <Text size={11} tone="dim" as="div" style={{ padding: "6px 10px", fontStyle: "italic" }}>no matches</Text>
            )}
          </Box>
        )}
      </Box>
    );
  };
  // A rail tree node: a kit entry, or a collapsible tech/style group header (default OPEN — its
  // expand state shares the `expanded` record under the group's stable key). A single-kit style
  // group (#2506) renders as the kit entry labelled with the style — the style header IS the kit.
  const renderRailNode = (n: KitTreeNode): ReactNode => {
    if (n.kind === "kit") return renderRailKit(n.kit);
    if (n.kit) return renderRailKit(n.kit, n.label);
    const open = expanded[n.key] ?? true;
    return (
      <Box key={n.key} style={{ marginBottom: 4 }}>
        <Box as="button" className="ds-grouphead" aria-expanded={open} title={`${n.level === "tech" ? "technology" : "visual language"}: ${n.label}`} onClick={() => setExpanded((e) => ({ ...e, [n.key]: !(e[n.key] ?? true) }))}>
          <Text as="span" className="ds-caret" style={{ transform: open ? "rotate(90deg)" : "none" }}>▸</Text>
          <Text as="span" mono size="xxs" style={{ flex: 1, textAlign: "left", letterSpacing: ".07em", textTransform: "uppercase" }}>{n.label}</Text>
          <Text mono size="xxs" tone="dim">{n.count}</Text>
        </Box>
        {open && <Box className="ds-groupkids">{n.children.map(renderRailNode)}</Box>}
      </Box>
    );
  };

  // The live preview node, guarded — a specimen that throws surfaces the error card, not a crash.
  // Prefer the REAL component (specimenFixtures via the registry, #2555); fall back to the specimens.tsx
  // mock for any primitive/variant not yet ported (a fixture returns null to defer).
  let previewEl: ReactNode = null, previewErr: string | null = null;
  if (sel) {
    try {
      void renderKey;
      previewEl = SPECIMEN_FIXTURES[sel.name as PrimitiveName]?.(activeVariant) ?? renderSpecimen(sel, activeVariant, theme);
    } catch (e) { previewErr = e instanceof Error ? e.message : String(e); }
  }

  return (
    <Box className="ds-root">
      {/* The page-level toolbar was removed when the studio became a Planner tab (the PageTabs strip is
          its header now). Kit switching lives in the rail — click a kit head to activate it; search sits
          under the rail header; Share moved to the graph header. */}
      {shareOpen && (
        <KitShareModal
          kit={kit ?? null}
          components={kitComps}
          onClose={() => setShareOpen(false)}
          onImported={(k) => selectKit(k.id)}
        />
      )}

      {/* kit-change propagation notify surface (#2277) — renders only when changes are pending */}
      <KitChangesCard />
      {/* built-in seed-refresh notices (#2483) — customized built-ins kept through a seed divergence */}
      <SeedNoticesCard />

      {/* ── body ── */}
      <Box className="ds-body">
        {/* left rail — the kits · components list */}
        <Box className="ds-col ds-rail" style={{ width: rail.size, flexBasis: rail.size }}>
          <Box className="ds-colhead">
            <Text className="ds-eyebrow" as="span">Kits · Components</Text>
            <Text mono size="xxs" tone="dim">{kitComps.length} comps</Text>
          </Box>
          {/* search — sits under the rail header */}
          <Box style={{ flex: "none", padding: "8px 8px 0" }}>
            <Box className="ds-search">
              <Text tone="dim" size={13}>⌕</Text>
              {/* eslint-disable-next-line no-restricted-syntax -- bespoke bare search box (Field imposes a labelled layout) */}
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search components…" aria-label="Search components" />
              <Text as="span" className="ds-kbd">⌘K</Text>
            </Box>
          </Box>
          <Box className="ds-scroll" style={{ flex: 1, padding: "8px 8px 16px" }}>
            {railTree.map(renderRailNode)}
          </Box>
        </Box>
        <Box className="ds-handle" {...rail.handleProps} />

        {/* center — the composition graph, with the ALWAYS-ON designer session docked below it (#2597):
            the graph flexes; the terminal is a fixed-height bottom strip, so the panes keep priority.
            Clicking the canvas background (not a node) unfocuses → hides the details pane (#2705). */}
        <Box className="ds-col ds-center">
          <GraphView
            graph={graph} comps={kitComps} selId={sel?.id ?? ""} workingId={aiFocusedId ?? ""} kitName={kit.name} gvp={gvp} onSelect={selectComp}
            onShare={() => setShareOpen(true)} health={nodeHealth} findingsCount={healthFindings.length}
            onDeselect={deselect}
          />
          <Box className="ds-handle-h" {...term.handleProps} />
          <DesignerTerminal height={term.size} />
        </Box>

        {/* details pane — rendered ONLY when a component is focused (#2705); clicking the canvas
            unfocuses and this (with its resize splitter) disappears, giving the graph the full width. */}
        {sel && (
          <>
            <Box className="ds-handle" {...insp.handleProps} />
            <Inspector
              width={insp.size} sel={sel} kitName={kit.name} tab={tab} setTab={setTab}
              allVariants={allVariants} activeVariant={activeVariant} setVariant={setVariant}
              vp={vp} setVpKind={setVpKind}
              kitTheme={kitTheme} setKitTheme={setKitTheme} kitThemes={kitThemes}
              previewEl={previewEl} previewErr={previewErr} onRetry={() => setRenderKey((k) => k + 1)}
              composes={composes} onSelect={selectComp}
            />
          </>
        )}
      </Box>
    </Box>
  );
}

function GuideCard({ tone, title, items, glyph }: { tone: "success" | "danger"; title: string; items: string[]; glyph: string }) {
  const c = tone === "success" ? "var(--success)" : "var(--danger)";
  return (
    <Box style={{ border: `1px solid color-mix(in srgb, ${c} 30%, var(--border))`, borderRadius: 10, overflow: "hidden" }}>
      <Text mono size="xxs" as="div" style={{ padding: "8px 12px", background: `color-mix(in srgb, ${c} 10%, transparent)`, letterSpacing: ".05em", textTransform: "uppercase", color: c }}>{title}</Text>
      <Box style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
        {items.map((w) => (
          <Box key={w} style={{ display: "flex", gap: 9 }}>
            <Text as="span" style={{ color: c, flex: "0 0 auto" }}>{glyph}</Text><Text size={12.5} tone="muted" style={{ lineHeight: 1.5 }}>{w}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Graph view ───────────────────────────────────────────────────────────────
interface GraphProps {
  graph: CompositionLayout;
  comps: ComponentRecord[]; selId: string;
  /** The AI-touched node (#2525) — pulses as `.working`, distinct from the user's `.on` selection. */
  workingId: string; kitName: string;
  gvp: ReturnType<typeof useGraphViewport>; onSelect: (c: ComponentRecord) => void;
  /** Open the share/import kits modal — the Share action lives in the graph header (right of fit). */
  onShare: () => void;
  /** Graph-health badges (#2680): node id → its most-severe finding category, + the total count. */
  health: Map<string, HealthCategory>; findingsCount: number;
  /** Clicking the canvas background (not a node) unfocuses → hides the details pane (#2705). */
  onDeselect: () => void;
}

/** The health badge glyph + tooltip per category (#2680) — mirrors `bsc ui doctor`. */
const HEALTH_BADGE: Record<HealthCategory, { glyph: string; label: string }> = {
  cycle: { glyph: "⟳", label: "on a composes cycle" },
  "dangling-branch": { glyph: "⚠", label: "unused branch (nothing composes it, used = 0)" },
  duplicate: { glyph: "⧉", label: "duplicate (same intrinsic / identical source)" },
  orphan: { glyph: "○", label: "orphan — isolated & unused" },
};

function GraphView({ graph, comps, selId, workingId, kitName, gvp, onSelect, onShare, health, findingsCount, onDeselect }: GraphProps) {
  // The pan/zoom shell is the shared GraphCanvas template (#2208) — viewport ref/wheel/pan + the world
  // transform + the infinite dotted grid all live there; this brings only the toolbar + world content.
  const EDGE_COLOR = "var(--border-strong, #3a434d)";
  const EDGE_HL = "var(--accent)";
  // Selection neighborhood (#2523): the selected node's edges draw in accent, its related nodes get a
  // softer ring. Incident edges render LAST (sorted to the end) so they sit above the dim ones.
  const { incidentEdges, relatedNodes } = selectionNeighborhood(graph.edges, selId);
  const orderedEdges = [...graph.edges].sort(
    (a, b) => Number(incidentEdges.has(a.id)) - Number(incidentEdges.has(b.id)),
  );
  return (
    <GraphCanvas
      vp={gvp}
      world={graph.world}
      onBackgroundClick={onDeselect}
      grid gridSize={22} gridColor="var(--border-soft, var(--border))"
      canvasBackground="var(--bg-canvas, var(--bg))"
      toolbar={
        <>
          <Text className="ds-eyebrow" as="span">Composition graph · {kitName}</Text>
          {findingsCount > 0 && (
            <Text as="span" className="ds-healthcount" title="Graph-health findings — the same set `bsc ui doctor` reports (#2680)">
              ⚠ {findingsCount} health finding{findingsCount === 1 ? "" : "s"}
            </Text>
          )}
          <Box style={{ flex: 1 }} />
          <ZoomControls vp={gvp} step={1.15} />
          <Box as="button" className="ds-act" onClick={() => gvp.fit()}>fit</Box>
          <Box as="button" className="ds-act" title="Share or import a kit (gist / share code)" onClick={onShare}><Text as="span" tone="dim">⇅</Text> Share</Box>
        </>
      }
    >
      <svg width={graph.world.w} height={graph.world.h} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
        {orderedEdges.map((e) => {
          const a = graph.pos.get(e.from), b = graph.pos.get(e.to);
          if (!a || !b) return null;
          // The shared graph line-type (#2222) with PERIMETER-ANCHOR routing — the composition graph
          // is a layered TOP-DOWN DAG (#2455); the side-port router is horizontal-only, and the anchor
          // router leaves each card facing the other, which reads cleanly for the vertical flow.
          const g = graphEdge({ ...a, w: NODE_W, h: NODE_H }, { ...b, w: NODE_W, h: NODE_H });
          const on = incidentEdges.has(e.id); // incident to the selection → accent + thicker (#2523)
          const color = on ? EDGE_HL : EDGE_COLOR;
          return (
            <g key={e.id} className={on ? "ds-edge on" : "ds-edge"}>
              <path d={g.d} stroke={color} strokeWidth={on ? 2.25 : 1.5} fill="none" />
              <path d={g.arrow} fill={color} />
            </g>
          );
        })}
      </svg>
      {comps.map((c) => {
        const pos = graph.pos.get(c.id); if (!pos) return null;
        // Full ring for the selection, softer ring for its related nodes (#2523); .on wins over .related.
        const state = c.id === selId ? " on" : relatedNodes.has(c.id) ? " related" : "";
        // AI live-focus (#2525): the touched node pulses as `.working` — a DISTINCT state from the
        // user's selection. Precedence: the user's `.on` wins if it's the SAME node (no `.working`
        // added then), so a user's active selection is never overridden; a DIFFERENT touched node
        // pulses (and composes with `.related` — `.working` is placed after `.related` in the CSS).
        const working = c.id === workingId && c.id !== selId ? " working" : "";
        const badge = health.get(c.id); // graph-health category (#2680), if any
        return (
          <Box key={c.id} data-node onClick={() => onSelect(c)} className={`ds-node${state}${working}${badge ? " unhealthy" : ""}`} style={{ left: pos.x, top: pos.y, width: NODE_W }}>
            {badge && (
              <Text as="span" className={`ds-health ds-health-${badge}`} title={`${badge} — ${HEALTH_BADGE[badge].label}`}>{HEALTH_BADGE[badge].glyph}</Text>
            )}
            <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <RoleDot role={c.role} /><Text weight={600} size={13}>{c.name}</Text>
            </Box>
            <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Text size={10} tone="dim">{c.role}</Text><Text mono size="xxs" tone="muted">×{c.used}</Text>
            </Box>
          </Box>
        );
      })}
    </GraphCanvas>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────────
// The full per-component detail surface (#2453) — it absorbed the removed Library center view:
// identity header · live preview (variant/theme/viewport + error card) · Overview/Source/Usage tabs ·
// the generate-variants design bar.
interface InspProps {
  width: number; sel: ComponentRecord | null; kitName: string; tab: Tab; setTab: (t: Tab) => void;
  allVariants: string[]; activeVariant: string; setVariant: (v: string) => void;
  vp: Viewport; setVpKind: (v: Viewport) => void;
  /** The preview's THEME axis (#2488/#2545): the hydrated theme collection + the applied selection.
   *  The selected theme drives both the retint (`vars`) and the sandbox surface (`base`). */
  kitTheme: string; setKitTheme: (id: string) => void; kitThemes: KitThemeRecord[];
  previewEl: ReactNode; previewErr: string | null; onRetry: () => void;
  composes: ReturnType<typeof resolveComposes>; onSelect: (c: ComponentRecord) => void;
}
function Inspector(p: InspProps) {
  const sel = p.sel;
  // The width splitter is the parent's handle (it drives `width`); the inspector just fills it.
  return (
    <Box className="ds-col ds-insp" style={{ width: p.width, flexBasis: p.width }}>
      <Box className="ds-colhead">
        <Text className="ds-eyebrow" as="span">Inspector</Text>
        <Text size={10} tone="dim" style={{ display: "flex", alignItems: "center", gap: 5 }}><StatusDot color="var(--success)" size={6} />editable</Text>
      </Box>
      {!sel ? (
        <Box style={{ padding: 16 }}><Text size={12} tone="dim">Select a component — a graph node or a rail entry — to inspect it.</Text></Box>
      ) : (
        <>
          {/* identity — always visible above the preview */}
          <Box style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", flex: "none" }}>
            <RoleDot role={sel.role} size={9} glow={4} style={{ marginTop: 5 }} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text weight={600} size={16} style={{ letterSpacing: "-.01em" }}>{sel.name}</Text>
              <Text size={11.5} tone="muted" as="div" style={{ marginTop: 2 }}>{sel.role} · {p.kitName}</Text>
            </Box>
            <Text mono size={10} tone="muted" style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "2px 7px" }}>v{sel.version}</Text>
          </Box>

          {/* live preview — folded in from the removed Library center view (#2453) */}
          <Box className="ds-preview">
            <Box className="ds-prevctl">
              <Text className="ds-eyebrow" as="span">Live preview</Text>
              <SegmentedControl label="" options={p.allVariants.map((v) => ({ label: v, on: v === p.activeVariant, onClick: () => p.setVariant(v) }))} />
              <SegmentedControl label="" options={(["sm", "md", "auto"] as Viewport[]).map((k) => ({ label: k === "auto" ? "⤢ fluid" : k, on: k === p.vp, onClick: () => p.setVpKind(k) }))} />
              {/* THEME switcher (#2488/#2545): the ONE theme control — the hydrated theme collection
                  (light/dark + designer-authored), driving both the surface (`base`) and the retint
                  (`vars`). A compact select since the set is open-ended and grows via `bsc ui theme`. */}
              {/* eslint-disable-next-line no-restricted-syntax -- compact toolbar select over a dynamic set (SelectField imposes a labelled field layout) */}
              <select
                className="sel"
                aria-label="Theme"
                title="Theme — surface + semantic-token palette applied to the specimen (bsc ui theme)"
                value={p.kitTheme}
                onChange={(e) => p.setKitTheme(e.target.value)}
              >
                {p.kitThemes.map((t) => (
                  <option key={t.id} value={t.id}>◈ {t.label}</option>
                ))}
              </select>
            </Box>
            <Box className="ds-surface">
              {p.previewErr ? (
                <Box className="ds-overlay" style={{ padding: 24 }}>
                  <Box style={{ maxWidth: 400, width: "100%", background: "var(--bg-elev, var(--bg-soft))", border: "1px solid color-mix(in srgb, var(--danger) 40%, var(--border))", borderRadius: 12, overflow: "hidden" }}>
                    <Box style={{ height: 30, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", background: "color-mix(in srgb, var(--danger) 12%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)" }}>
                      <StatusDot color="var(--danger)" size={8} />
                      <Text mono size="xxs" tone="danger" style={{ letterSpacing: ".05em", textTransform: "uppercase" }}>Preview failed to render</Text>
                    </Box>
                    <Box style={{ padding: "14px 16px" }}>
                      <Code maxHeight={140} wrap>{p.previewErr}</Code>
                      <Box style={{ display: "flex", gap: 8, marginTop: 14 }}>
                        <Button variant="primary" size="sm" onClick={p.onRetry}>↻ Retry render</Button>
                      </Box>
                    </Box>
                  </Box>
                </Box>
              ) : (
                <Box className="ds-frame">
                  {/* centered on the surface (#2333); the width transition + fixed VP width are layout, not the removed motion pass.
                      The ThemeScope (#2488) applies the selected kit theme's semantic-token overrides to the specimen frame. */}
                  <ThemeScope theme={p.kitTheme} style={{ width: VP[p.vp].w, maxWidth: "100%", transition: "width .25s ease", display: "flex", justifyContent: "center" }}>{p.previewEl}</ThemeScope>
                </Box>
              )}
              <Text as="div" className="ds-vplabel">{VP[p.vp].label}</Text>
            </Box>
          </Box>

          {/* detail tabs */}
          <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Box className="ds-tabs">
              {(["overview", "source", "usage"] as Tab[]).map((t) => (
                <Box as="button" key={t} role="tab" aria-selected={p.tab === t} className={`ds-tab${p.tab === t ? " on" : ""}`} onClick={() => p.setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</Box>
              ))}
              <Box style={{ flex: 1 }} />
              <Text mono size="xxs" tone="dim">{sel.name}.tsx</Text>
            </Box>
            <Box className="ds-panel">
              {p.tab === "overview" && <InspectorOverview sel={sel} allVariants={p.allVariants} activeVariant={p.activeVariant} composes={p.composes} onSelect={p.onSelect} />}
              {p.tab === "source" && (
                <Box style={{ padding: "14px 16px" }}>
                  <Text mono size="xxs" tone="dim" as="div" style={{ marginBottom: 6 }}>{sel.src}</Text>
                  <Code maxHeight={9999} wrap={false}>{sel.srcText}</Code>
                </Box>
              )}
              {p.tab === "usage" && (
                <Box style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <GuideCard tone="success" title="✓ When to use" items={sel.whenUse} glyph="→" />
                  <GuideCard tone="danger" title="✗ When NOT to use" items={sel.whenNot} glyph="✕" />
                </Box>
              )}
            </Box>
          </Box>

        </>
      )}
    </Box>
  );
}

/** The Overview tab body — props/API (with descriptions), variants, and the composes mini-graph. */
function InspectorOverview({ sel, allVariants, activeVariant, composes, onSelect }: {
  sel: ComponentRecord; allVariants: string[]; activeVariant: string;
  composes: ReturnType<typeof resolveComposes>; onSelect: (c: ComponentRecord) => void;
}) {
  return (
    <Box style={{ padding: "14px 14px 16px" }}>
      {/* meta pills */}
      <Box style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
        <Chip color="var(--accent)">used ×{sel.used}</Chip>
        {sel.tags.map((t) => <Chip key={t}>{t}</Chip>)}
      </Box>
      {/* props */}
      <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Props / API</Text>
      <Box className="ds-inspbox" style={{ marginBottom: 18 }}>
        {sel.props.length ? sel.props.map((pr) => (
          <Box key={pr.name} className="ds-insprow" style={{ flexDirection: "column", alignItems: "stretch", gap: 3 }}>
            <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Box style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                <Text mono size={11} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pr.name}</Text>{pr.req && <Text mono size={11} tone="danger">*</Text>}
              </Box>
              <Text mono size={10.5} tone="accent" style={{ maxWidth: 160, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pr.type}</Text>
            </Box>
            {pr.desc && <Text size={11} tone="muted" as="div" style={{ lineHeight: 1.45 }}>{pr.desc}</Text>}
          </Box>
        )) : <Box className="ds-insprow"><Text size={11.5} tone="dim">No public props — this component reads from the global store.</Text></Box>}
      </Box>
      {/* variants */}
      <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Variants</Text>
      <Box style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
        {allVariants.map((v) => (
          <Text key={v} size={11.5} tone={v === activeVariant ? "accent" : "muted"} style={{ background: "var(--bg-soft)", border: `1px solid ${v === activeVariant ? "var(--accent-dim, var(--accent))" : "var(--border)"}`, borderRadius: 6, padding: "3px 9px" }}>{v}</Text>
        ))}
      </Box>
      {/* composes */}
      <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 8 }}>Composes</Text>
      <Box style={{ border: "1px solid var(--border)", borderRadius: 9, background: "var(--bg-soft)", padding: 12 }}>
        {composes.length ? (
          <>
            <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Text size={11.5} weight={600} style={{ background: "var(--bg-elev, var(--bg-canvas))", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 10px" }}>{sel.name}</Text>
              <Text tone="dim" size={11}>depends on ↓</Text>
            </Box>
            <Box style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12, borderLeft: "1px dashed var(--border)" }}>
              {composes.map(({ name, comp }) => (
                <Box as={comp ? "button" : "span"} key={name} className="ds-rel" onClick={comp ? () => onSelect(comp) : undefined} aria-disabled={!comp} style={comp ? undefined : { opacity: .55, cursor: "default" }}>
                  <Text as="span" tone="dim" size={11}>└</Text><RoleDot role={comp?.role ?? "primitive"} size={6} /><Text as="span" size={11.5} tone="accent">{name}</Text>
                </Box>
              ))}
            </Box>
          </>
        ) : <Text size={11.5} tone="dim" style={{ fontStyle: "italic" }}>Primitive — composes nothing.</Text>}
      </Box>
    </Box>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────
function StudioEmpty() {
  return (
    <EmptyState
      icon="⬡" iconVariant="dashed"
      title={NO_COMPONENTS_TITLE}
      description={<>A <b style={{ color: "var(--fg)" }}>kit</b> is a technology-scoped namespace of proven components. Seed one from the UI already living in your repo, or start an empty kit.</>}
      style={{ height: "100%" }}
    />
  );
}
