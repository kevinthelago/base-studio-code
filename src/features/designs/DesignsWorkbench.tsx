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
// The whole shell IS the shared `GraphCanvas` (#2766) — rail · [toolbar · canvas · dock] · inspector,
// the SAME structure as Teams and Glance (the bespoke `.ds-body`/`.ds-col` layout + its duplicate inner
// GraphCanvas are gone). It reuses the pure domain (`lib/model`), the live build-and-iframe preview
// (`ComponentPreviewFrame`, #2824), the shared graph stack (`ZoomControls` + `useGraphPage`/`useGraphViewport` +
// `graphEdge`, #2418; the top-down hierarchy layout lives in `lib/compositionLayout`, #2455); GraphCanvas
// owns the rail/inspector widths, so `useDragResize` sizes only the designer-terminal dock now. Data
// comes from the global store via the `bsc ui` bridge.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { KitShareModal } from "./KitShareModal";
import { DesignerTerminal } from "./DesignerTerminal";
import { DesignerLoopBanner } from "./DesignerLoopBanner";
import { useDesignerLoopPump } from "./useDesignerLoopPump";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { useDockEntrance } from "@/shared/hooks/useDockEntrance";
import { useCrumbEntity } from "@/shared/hooks/useCrumbEntity";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { useGraphPage } from "@/shared/ui/layouts/useGraphPage";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { selectionNeighborhood } from "@/shared/lib/graph/selectionNeighborhood";
import { layoutBand } from "@/shared/lib/graph/crossGraph";
import { parseNodeUrn, LIBRARY_SEGMENT } from "@/shared/lib/graph/nodeUrn";
import { resolveComponentLibraryRefs } from "./lib/libraryComposition";
import { layoutComposition, NODE_W, NODE_H } from "./lib/compositionLayout";
import { analyzeGraphHealth, analyzeMotion, isActionProp, HEALTH_SEVERITY, HEALTH_BADGE, type HealthCategory } from "./lib/graphHealth";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { RoleDot } from "./kitChrome";
import { RailTree } from "./RailTree";
import { matchesQuery, resolveComposes, resolveComponentAnimationDefs, resolveNamedAnimation, selectAnimationPreset, ROLE_COLOR, ROLES, type ComponentRecord, type ChangeEntry } from "./lib/model";
import { timeAgo } from "@/shared/lib/core/format";
import { GraphLegend } from "@/shared/ui/layouts/GraphLegend";
import { useUiActivity } from "./lib/uiActivity";
import { useComponentScan } from "./lib/useComponentScan";
import { designStudioVisible } from "./lib/studioVisibility";
import { makeLibraryResolvers } from "./lib/libraryModules";
import { useActiveSoundKit } from "./lib/useActiveSoundKit";
import { groupKits } from "./lib/kitGroups";
import { supportedStates, previewCycleStates } from "./lib/componentPreview";
import { usePreviewStateCycle } from "./lib/usePreviewStateCycle";
import { expandedPreviewFit } from "./lib/expandedPreviewFit";
import { ComponentPreviewFrame } from "./ComponentPreviewFrame";
import type { PreviewState } from "./lib/componentPreview";
import { ThemesMenu } from "./ThemesMenu";
import { AnimationsMenu } from "./AnimationsMenu";
import { PaletteStrip } from "./PaletteStrip";
import { PaletteToggle } from "./PaletteToggle";
import { DEFAULT_THEME } from "@/shared/ui/kit";

/** The preview surface's light/dark axis, read off the selected theme's `base`. */
type PreviewTheme = "dark" | "light";
import type { KitThemeRecord } from "./lib/themes";
import "./designStudio.css";

type Tab = "overview" | "source" | "tests" | "usage" | "history";
type Viewport = "sm" | "md" | "auto";

// Cross-graph library band (#3116) — the fenced top band of algorithm nodes a kit's components `require`.
/** The preview data-state axis (#3135) — the switcher's options, in order. */
const BAND_PAD = 60;         // left/right inset the band centers over (matches the composition layout pad)
const BAND_TOP = 40;         // y of the band cards' top edge
const BAND_GAP = 34;         // clearance from the band cards down to the fence divider
const BAND_BOTTOM_GAP = 30;  // clearance from the fence down to the (shifted) composition graph

// The role dot + kit chip live in kitChrome.tsx (#2420) — shared with the Planner Components pane.

export function DesignsWorkbench() {
  const components = useAppStore((s) => s.components);
  const kits = useAppStore((s) => s.kits);
  // The hydrated kit-THEME collection (#2488) — feeds the preview's palette switcher.
  const kitThemes = useAppStore((s) => s.kitThemes);
  // The node the designer AI is currently working (#2525) — a `.working` pulse + auto-pan target.
  const aiFocusedId = useAppStore((s) => s.aiFocusedId);
  // Per-component preview-BUILD status (#2838) — populated by the on-visit `useComponentScan` sweep;
  // the graph badges the `error` entries (a red build-error glyph, additive to the health badge).
  const componentBuildStatus = useAppStore((s) => s.componentBuildStatus);
  // Per-component RUNTIME data-state blanks (#3191) — the on-visit scan's render-confirmed empty/loading
  // blanks; folded into `nodeHealth` below so they badge like any other HealthCategory finding.
  const componentStateHealth = useAppStore((s) => s.componentStateHealth);
  // The standard component-edit action (#3069) — updates the store + write-throughs `bsc ui set`; the
  // animation-variation default-switch reuses it exactly like any other component edit.
  const setComponent = useAppStore((s) => s.setComponent);

  const firstFor = (kitId: string) => components.find((c) => c.kitId === kitId);
  // #3274: kit + component selection lives in the STORE, not local state — `bsc navigate component`
  // needs to set it from outside the UI so a capture can target something. Behaviour is unchanged:
  // neither is persisted, so an empty stored kit falls back to the first (what the old lazy
  // `useState(() => kits[0]?.id)` did) and the component still starts null each boot (#3090).
  const storedKitId = useAppStore((s) => s.designsKitId);
  const setKitId = useAppStore((s) => s.setDesignsKit);
  const kitId = storedKitId || kits[0]?.id || "";
  // The user-FOCUSED component — null when nothing is focused → the Inspector is hidden unless Claude is
  // working a node (#3090, restoring #2705's hide-when-empty over #2818). Focusing a node (or a rail row)
  // sets it; clicking the canvas clears it.
  const compId = useAppStore((s) => s.designsCompId);
  const setCompId = useAppStore((s) => s.setDesignsComp);
  const [tab, setTab] = useState<Tab>("overview");
  const [variant, setVariant] = useState(() => firstFor(kits[0]?.id ?? "")?.variants[0] ?? "default");
  // The preview's DATA-STATE axis (#3135): loaded (demo) · empty (no data) · loading (skeleton). In the
  // STORE (#3717), not local, so `bsc navigate component --state <s>` can drive the SAME value the
  // SegmentedControl below sets — letting an external session capture a specific render via `bsc shot`.
  const previewState = useAppStore((s) => s.designsPreviewState);
  const setPreviewState = useAppStore((s) => s.setDesignsPreviewState);
  // The preview's THEME axis (#2488) — ONE control now (#2545): the selected theme drives both the
  // component retint (its `vars`, via <ThemeScope>) AND the sandbox SURFACE (its `base`, below). The
  // old hardcoded dark/light SegmentedControl is retired — light/dark is theme data served through
  // the same `bsc ui theme` collection, so the picker grows as themes are authored.
  const [kitTheme, setKitTheme] = useState<string>(DEFAULT_THEME);
  // The applied theme record (its `vars`/`base`/`label` drive the preview, palette strip, and header).
  const activeTheme = kitThemes.find((t) => t.id === kitTheme);
  // The preview iframe's light/dark surface, read off the selected theme's `base` (absent ⇒ dark).
  const theme: PreviewTheme = activeTheme?.base ?? "dark";
  const [vp, setVpKind] = useState<Viewport>("auto");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({ [kits[0]?.id ?? ""]: true }));
  const [shareOpen, setShareOpen] = useState(false); // the share/import kits modal (#2305 slice 1c)
  // Theme try-on (#2834): clicking the inspector's preview thumbnail promotes it to a full-canvas
  // preview over the graph, where the selected component is the vehicle for viewing each theme. The
  // left rail keeps navigating components while it's open; "← Back to graph" closes it.
  const [previewMode, setPreviewMode] = useState(false);
  // Preview-mode right-pane axis (#2942): try on the palette (Themes) or the kit's MOTION (Animations).
  const [rightAxis, setRightAxis] = useState<"themes" | "animations">("themes");
  // The theme try-on's raw palette strip is HIDDEN by default (#3706); the top-bar theme label is now a
  // toggle (PaletteToggle) that reveals it — so the swatch band is opt-in and the specimen owns the full
  // preview height until you ask for the raw palette.
  const [showPalette, setShowPalette] = useState(false);
  // The kit animation PLAYED on the vehicle — the motion try-on (#2942), or null.
  const [tryAnim, setTryAnim] = useState<string | null>(null);
  // Whether the Design Studio is the VISIBLE page (not merely mounted). KeptMountedPage keeps this
  // Workbench mounted (display:none) after the first visit, and a hidden child's effects keep firing —
  // so this one flag gates every background loop below (#3616/#3620/#3627) on real visibility.
  const scanVisible = useAppStore((s) => designStudioVisible(s.activeWorkspace, s.projectsPageMode));
  // Live-focus (#2525): poll the designer session's activity stream to show what Claude is working on.
  // Gate on `scanVisible` (#3627) — an unconditional `true` kept polling `bsc logs tail ui` against a
  // hidden page forever (the same KeptMountedPage leak #3616 fixed for the scan below). Paused when
  // hidden; `bsc logs tail` catches up on return; the `setAiFocused(null)` cleanup handles unmount.
  useUiActivity(scanVisible);
  useDesignerLoopPump(); // #3292: drive the open designer loop (bsc loop) from this long-lived workspace
  useEffect(() => () => useAppStore.getState().setAiFocused(null), []);

  // The always-on designer terminal's height (#2624) — a row-resize handle above it; `invert` because
  // the terminal sits AFTER the handle, so dragging up grows it. The graph (flex:1) keeps priority.
  // The rail + inspector widths are owned by GraphCanvas now (#2766), so only the dock stays caller-owned.
  const term = useDragResize({ initial: 340, min: 140, max: 560, axis: "y", invert: true });
  useDockEntrance(term.setSize, 340); // grow the dock up into place on mount (#2905)

  const match = (c: ComponentRecord) => matchesQuery(c, query);
  const kit = kits.find((k) => k.id === kitId) ?? kits[0];
  // Name the active kit in the titlebar crumb (#3041) — "" when the library is empty.
  useCrumbEntity("designs", kit?.name ?? "");
  // The resolved try-on motion def (#2942) — the selected kit animation, kit-scoped for the vehicle.
  const tryAnimDef = useMemo(() => {
    // The try-on resolves against the SELECTED component's OWN animations first, then the kit shelf
    // (#3071) — so clicking a component animation replays it (the old kit-only lookup missed inline defs).
    const c = compId ? components.find((x) => x.id === compId && x.kitId === kitId) ?? null : null;
    return resolveNamedAnimation(c, kit, kits, tryAnim ?? "");
  }, [tryAnim, compId, components, kitId, kits, kit]);
  const kitComps = useMemo(() => components.filter((c) => c.kitId === kitId), [components, kitId]);
  // Preview-error scan (#2838): while the Studio is mounted (visit, not boot — it lazily first-mounts via
  // KeptMountedPage), esbuild-build each buildable component in the active kit — throttled — and record
  // ok/error in the store; the graph badges the failures. Re-runs only for components whose source changed.
  // The active blueprint's pinned sound kit (#3412) — the ONE resolution target the Studio's preview,
  // scan, and health pass all share, so a badge, a build, and a played cue can never disagree.
  const soundKit = useActiveSoundKit();
  const libResolver = useMemo(() => makeLibraryResolvers(soundKit).libraryModuleResolver, [soundKit]);
  // Gate the scan on the Studio being VISIBLE, not merely mounted (#3616): an unconditional `true` here
  // kept esbuild-building + iframe-probing all 154 components forever in the background (~40% renderer
  // CPU for a page nobody's on). Paused when hidden; the sig-cache means resuming re-scans nothing
  // unchanged. `scanVisible` is computed once above (#3627) and shared with the activity poll.
  useComponentScan(scanVisible, kitComps, undefined, libResolver);
  // The FOCUSED component — strictly the one the user picked, in the current kit; drives the graph's
  // `.on` selection ring. No fallback to "the first".
  const sel = compId ? components.find((c) => c.id === compId && c.kitId === kitId) ?? null : null;
  // The node Claude is actively working (#2525) becomes the inspector subject when the user hasn't
  // focused anything — so the details pane is visible while a node is focused OR being worked on by
  // Claude (#3090), showing what Claude is doing. The graph still marks it `.working` (a distinct pulse),
  // NOT `.on`, so the user-selection and AI-focus signals stay separate.
  // Dismissing Claude's auto-open (#3109): `deselect` records the AI node id here so the canvas-background
  // unfocus closes the pane even when it's showing Claude's node, and keeps it closed while Claude stays on
  // that node. A DIFFERENT node — or clicking the node yourself — re-opens it, so a dismissal silences ONE
  // node, not Claude. (The activity poll re-emits the same id with new timestamps, but aiFocusedId's VALUE
  // only changes on a genuinely different node, so this id-compare is stable against the re-emits.)
  const [dismissedAiId, setDismissedAiId] = useState<string | null>(null);
  const aiComp = aiFocusedId && aiFocusedId !== dismissedAiId
    ? components.find((c) => c.id === aiFocusedId && c.kitId === kitId) ?? null
    : null;
  const focusComp = sel ?? aiComp;

  // The expanded try-on's pan/zoom (#3190 CRISP pass + #3551 fluid fit). The iframe runs its OWN
  // DOM-transform pan/zoom ENGINE (crisp), so the host must NOT CSS-scale the iframe — a host downscale
  // both shrinks the preview AND desyncs the engine's pointer math (its drag reads iframe-internal
  // clientX), which read as "no click and drag". So the host just FRAMES the design viewport into the
  // measured canvas, and in fluid (default) mode the frame FILLS the canvas at scale 1 — width-first,
  // grows on resize, pan stays 1:1. `expandedPreviewFit` owns that pure math; the engine hands back its
  // +/−/fit API for the buttons.
  const [previewCanvas, setPreviewCanvas] = useState({ w: 0, h: 0 });
  const previewRo = useRef<ResizeObserver | null>(null);
  const mountPreviewCanvas = useCallback((el: HTMLDivElement | null) => {
    previewRo.current?.disconnect();
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => setPreviewCanvas((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
      ro.observe(el);
      previewRo.current = ro;
    }
  }, []);
  useEffect(() => () => previewRo.current?.disconnect(), []);
  const { previewW, previewH, ...previewFit } = useMemo(
    () => expandedPreviewFit(vp, previewCanvas.w, previewCanvas.h),
    [vp, previewCanvas.w, previewCanvas.h],
  );
  const [previewZoomApi, setPreviewZoomApi] = useState<{ zoomIn: () => void; zoomOut: () => void; fit: () => void } | null>(null);
  // The expanded try-on's live frame — defined once so it mounts EITHER directly (fluid: it fills the
  // canvas at scale 1) OR inside the centering placer (a fixed breakpoint), without duplicating props.
  // The zoom engine opens FIT (whole component visible); scroll zooms, drag pans.
  const expandedPreviewFrame = sel && (
    <ComponentPreviewFrame
      comp={sel}
      theme={theme}
      themeId={kitTheme}
      themeVars={activeTheme?.vars ?? {}}
      width={previewW}
      height={previewH}
      extraAnimation={tryAnimDef}
      previewState={previewState}
      zoomEngine={{}}
      registerZoomApi={setPreviewZoomApi}
      // #3596: hold Alt in the expanded preview → clicking a child component navigates the graph to it.
      // Uses the store setters directly (selectComp is declared below this const); the inspector re-derives.
      onNavigate={(name) => {
        const child = components.find((c) => c.name === name && c.kitId === kitId);
        if (!child) return;
        if (child.kitId !== kitId) setKitId(child.kitId);
        setCompId(child.id);
      }}
    />
  );

  const allVariants = focusComp ? focusComp.variants : [];
  const activeVariant = allVariants.includes(variant) ? variant : allVariants[0] ?? "default";
  const composes = focusComp ? resolveComposes(focusComp, components) : [];

  const selectKit = (id: string) => {
    // Switching kit re-scopes the graph but focuses nothing — the Inspector shows its empty state
    // until the user picks a node in the new kit.
    setKitId(id); setCompId(null); setExpanded((e) => ({ ...e, [id]: true })); setTab("overview");
  };
  const selectComp = (c: ComponentRecord) => {
    if (c.kitId !== kitId) setKitId(c.kitId);
    setCompId(c.id); setVariant(c.variants[0] ?? "default"); setTab("overview");
    setTryAnim(null); // a new vehicle clears the motion try-on (#2942)
  };
  // Select a PRESET as the component's motion (#3083): fold every inline binding into ONE motion preset
  // group with `name` as the default (`selectAnimationPreset`), so exactly the picked one plays — the
  // "pick a value to set the entire component's animation" model. Persist through the STANDARD
  // component-edit path (`setComponent` → store update + write-through `bsc ui set`), so the preview
  // replays the new pick (its `resolveComponentAnimations` re-picks) and the active marker moves at once.
  const selectPreset = (name: string) => {
    if (!sel) return;
    setComponent({ ...sel, animations: selectAnimationPreset(sel.animations ?? [], name) });
    setTryAnim(name); // also play the chosen preset immediately (guarantees a replay even when it was
                      // already active — the try-on rebuilds the preview).
  };

  // Clicking anything other than a node (the canvas background) unfocuses → hides the Inspector and the
  // graph returns to full-width (#3090). Also DISMISSES Claude's active node (#3109) so the pane closes
  // even when it was showing Claude's node — otherwise there'd be no way to unfocus it.
  const deselect = () => { setCompId(null); setDismissedAiId(aiFocusedId); };

  // ── graph layout (#2455) — hierarchical top-down: composers above, dependencies below, role-tier
  // banding for edge-less nodes, `used`-desc ordering within a row. Pure model: lib/compositionLayout.
  const graph = useMemo(() => layoutComposition(kitComps), [kitComps]);

  // ── Cross-graph composition (#3116 algorithms, #3117 sounds) — the LIBRARY nodes a kit's components
  // `require` (via a `@bsc/algorithms/…` or `@bsc/sounds/…` import), rendered in a FENCED BAND across the top
  // with dashed `requires` edges into them (A's `layoutBand`). A kit with NO library imports yields no band →
  // the graph is byte-identical to today (the band memo returns 0 nodes, `bandShift` = 0, `world` === `graph.world`).
  const libComp = useMemo(() => resolveComponentLibraryRefs(kitComps), [kitComps]);
  const band = useMemo(
    () => layoutBand(libComp.nodes.length, {
      spanX0: BAND_PAD, spanX1: Math.max(BAND_PAD, graph.world.w - BAND_PAD),
      topPad: BAND_TOP, nodeH: NODE_H, gap: BAND_GAP, maxStep: NODE_W + 70,
    }),
    [libComp.nodes.length, graph.world.w],
  );
  // How far the composition graph shifts DOWN to clear the band + its fence (0 when there's no band).
  const bandShift = libComp.nodes.length ? band.dividerY + BAND_BOTTOM_GAP : 0;
  // The world the viewport fits to — extended by the band. Preserve `graph.world`'s identity when there is
  // no band so `useGraphPage` doesn't needlessly re-fit (byte-identical behavior for a bandless kit).
  const world = useMemo(
    () => (bandShift ? { w: graph.world.w, h: graph.world.h + bandShift } : graph.world),
    [graph.world, bandShift],
  );
  // Each band node's top-left (world coords) by its canonical URN — the dashed edge's target + the card.
  const bandPosByUrn = useMemo(
    () => new Map(libComp.nodes.map((n, i) => [n.urn, band.positions[i]] as const)),
    [libComp.nodes, band.positions],
  );

  // The on-graph legend (#2909) — the component ROLES present in this kit (colored as their RoleDots) +
  // the `composes` dependency edge when the kit actually has composition. Relevant to the kit on screen.
  const legend = useMemo(() => {
    const present = new Set(kitComps.map((c) => c.role));
    const nodes = ROLES.filter((r) => present.has(r)).map((r) => ({ label: r[0].toUpperCase() + r.slice(1), color: ROLE_COLOR[r] }));
    const edges = graph.edges.length ? [{ label: "composes" }] : [];
    // A "Library" key row appears only when the kit reaches into the library (#3116/#3117) — one entry per
    // referenced graph (algorithm and/or sound), both drawn in the band's `--info` accent.
    const libGraphs = new Set(libComp.nodes.map((n) => n.graph));
    const libNodes = [
      ...(libGraphs.has("algo") ? [{ label: "algorithm", color: "var(--info)" }] : []),
      ...(libGraphs.has("sound") ? [{ label: "sound", color: "var(--info)" }] : []),
    ];
    const librarySection = libComp.nodes.length
      ? [{ label: "Library", nodes: libNodes, edges: [{ label: "requires", dashed: true, color: "var(--info)" }] }]
      : [];
    return <GraphLegend sections={[{ label: "Roles", nodes }, { label: "Composition", edges }, ...librarySection]} />;
  }, [kitComps, graph.edges.length, libComp.nodes]);
  // Graph health (#2680) — the same taxonomy `bsc ui doctor` reports (lib/graphHealth), mirrored to
  // badge dead/duplicated nodes. `nodeHealth` maps each flagged node to its MOST-SEVERE category.
  // Topology findings + the #3163 MOTION findings (`bsc ui doctor --motion`) — badge both from the graph.
  const healthFindings = useMemo(
    () => [...analyzeGraphHealth(kitComps, libResolver), ...analyzeMotion(kitComps)],
    [kitComps, libResolver],
  );
  const nodeHealth = useMemo(() => {
    const m = new Map<string, HealthCategory>();
    const consider = (id: string, cat: HealthCategory) => {
      const cur = m.get(id);
      if (!cur || HEALTH_SEVERITY[cat] > HEALTH_SEVERITY[cur]) m.set(id, cat);
    };
    for (const f of healthFindings) for (const id of f.nodeIds) consider(id, f.category);
    // Fold in the runtime data-state blanks (#3191) — render-confirmed by the scan, not analyzeGraphHealth —
    // so `empty-empty-state` / `empty-loading-state` badge alongside the static findings (most-severe wins).
    for (const [id, cats] of Object.entries(componentStateHealth)) for (const cat of cats) consider(id, cat);
    return m;
  }, [healthFindings, componentStateHealth]);

  const gvp = useGraphPage(world, [kitId]); // re-fit on mount + whenever the kit switches (band-aware world)
  // Auto-pan the AI-touched node into view (#2525) — center it, keeping zoom (least-disruptive). Only
  // when the node lives in the CURRENT kit's graph; a touch in another kit just doesn't pan.
  const gvpCenter = gvp.centerOn;
  useEffect(() => {
    if (!aiFocusedId) return;
    const pos = graph.pos.get(aiFocusedId);
    if (pos) gvpCenter(pos.x + NODE_W / 2, pos.y + bandShift + NODE_H / 2);
  }, [aiFocusedId, graph, gvpCenter, bandShift]);

  // ── rail hierarchy (#2487, policy fixed by #2506) — ALWAYS technology → style; a single-kit style
  // header IS the kit (lib/kitGroups), so the packaged library reads React → Studio → components.
  const railTree = useMemo(() => groupKits(kits), [kits]);

  // Always render the graph + panes + the designer terminal — even with NO kit (an empty library, e.g.
  // right after the default kit is cleared, #3029): the studio is where you BUILD the kit, so it must
  // never hide behind an empty-state page (that would hide the very designer session you need). The
  // graph simply draws empty, the rail is empty, the Inspector shows its own "select a component" state.

  // Selection neighborhood (#2523): the focused node's edges draw in accent, its related nodes get a
  // softer ring; incident edges render LAST so they sit above the dim ones. Hoisted out of the old
  // GraphView wrapper (#2766) now that the graph IS the page's one GraphCanvas.
  const selId = sel?.id ?? "";
  const { incidentEdges, relatedNodes } = selectionNeighborhood(graph.edges, selId);
  const orderedEdges = [...graph.edges].sort(
    (a, b) => Number(incidentEdges.has(a.id)) - Number(incidentEdges.has(b.id)),
  );
  const EDGE_COLOR = "var(--border-strong, #3a434d)";
  const EDGE_HL = "var(--accent)";

  // The whole shell is the shared GraphCanvas (#2766): rail · [toolbar · canvas · dock] · inspector —
  // structurally identical to Teams and Glance now (the bespoke .ds-body/.ds-col layout + its duplicate
  // inner GraphCanvas are gone). The page-level toolbar was already dropped when the studio became a
  // Planner tab (the PageTabs strip is its header); kit switching + search live in the rail, Share in the
  // graph header. Modals + notice cards are siblings of the canvas.
  return (
    <>
      {/* #3852: the banner lives IN the graph header now (see `toolbar` below). It stays here as the
          overlay for the one case there is no header — theme-preview mode drops the whole header row, and
          the loop's Stop must not become unreachable: it is the only brake on an unattended run. */}
      {previewMode && <DesignerLoopBanner />}
      {shareOpen && (
        <KitShareModal
          kit={kit ?? null}
          components={kitComps}
          onClose={() => setShareOpen(false)}
          onImported={(k) => selectKit(k.id)}
        />
      )}
      <GraphCanvas
        profileId="designs"
        vp={gvp}
        world={world}
        className="ds-graph"
        grid gridSize={22} gridColor="var(--border-soft, var(--border))"
        canvasBackground="var(--bg-canvas, var(--bg))"
        railResizable railWidth={266} railMin={200} railMax={400}
        inspectorResizable inspectorWidth={420} inspectorMin={300} inspectorMax={680}
        // Clicking the canvas background (not a node) unfocuses → hides the details pane (#2705).
        onBackgroundClick={deselect}
        // The ALWAYS-ON designer session (#2597), docked below the graph; the caller owns its height + a
        // `.resize-y` handle (GraphCanvas gives it a flex:none slot), mirroring the Teams dock (#2759).
        dock={
          <Box style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <Box className="resize-y" {...term.handleProps} title="Drag to resize" />
            <DesignerTerminal height={term.size} />
          </Box>
        }
        // Theme try-on (#2849): hide the graph chrome in preview mode — no toolbar → GraphCanvas drops
        // the header row so the preview overlay owns the whole center (the graph beneath it is covered).
        toolbar={previewMode ? null : (
          <>
            {/* The loop banner owns the header's leading slot (#3852) — it replaced a "Composition graph ·
                <kit>" eyebrow that repeated what the PageTabs strip and the rail already say. */}
            <DesignerLoopBanner inline />
            {/* The graph-health count (#2680). A read-only signal on purpose (#3889): `bsc ui doctor` is
                what ACTS on findings — it reports the same set, plus the render-time ones the scan mirrors
                to the durable log (#3540) — so an in-app worklist duplicated the consumer without serving one. */}
            {healthFindings.length > 0 && (
              <Text
                as="span" className="ds-healthcount"
                title={`${healthFindings.length} graph-health finding${healthFindings.length === 1 ? "" : "s"} — the same set \`bsc ui doctor\` reports (#2680)`}
              >
                ⚠ {healthFindings.length}
              </Text>
            )}
            <Box style={{ flex: 1 }} />
            <ZoomControls vp={gvp} step={1.15} />
            {/* The shared ghost Button (#2808), matching the Teams/Algorithms/Glance toolbars. */}
            <Button variant="ghost" onClick={() => gvp.fit()}>fit</Button>
            <Button variant="ghost" title="Share or import a kit (gist / share code)" onClick={() => setShareOpen(true)}><Text as="span" tone="dim">⇅</Text> Share</Button>
          </>
        )}
        rail={scanVisible ? (
          // Headerless graph-nav menu (#2797): search over the collapsible kits→components tree — no
          // label bar (the PageTabs strip already titles the studio). #3620: gated with the world content
          // so a hidden Studio doesn't re-render the 154-row component tree in the background either.
          <GraphRail
            tools={
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Search components…"
                aria-label="Search components"
                style={{ width: "100%", maxWidth: 420 }}
              />
            }
          >
            <RailTree
              railTree={railTree} expanded={expanded} setExpanded={setExpanded}
              kitId={kitId} setKitId={setKitId} compId={compId}
              components={components} match={match} selectComp={selectComp} query={query}
            />
          </GraphRail>
        ) : undefined}
        // Details pane — selection-driven visibility (#3090, restoring #2705 over #2818): the Inspector
        // renders ONLY when a component is focused (`focusComp` = the user's pick, else the node Claude is
        // working), so the graph is full-width by default — a clean rail + graph at half-screen. Focusing a
        // node or a rail row reveals it; clicking the canvas background hides it again. (In preview mode the
        // right pane is always present — the themes/animations navigator — since it's reached from a live pick.)
        inspector={
          // In preview mode the right pane BECOMES the themes navigator (#2834): pick a theme here, the
          // center retints. Otherwise it's the per-component inspector, whose preview thumbnail opens
          // preview mode.
          previewMode ? (
            // #2942: the try-on right pane toggles between the palette (Themes) and the kit's MOTION
            // (Animations); each menu owns its left border, so the toggle bar matches it.
            <Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Box style={{ flex: "none", padding: "8px 8px 0", borderLeft: "1px solid var(--border)", background: "var(--bg-elev)" }}>
                <SegmentedControl options={[
                  { label: "Themes", on: rightAxis === "themes", onClick: () => setRightAxis("themes") },
                  { label: "Animations", on: rightAxis === "animations", onClick: () => setRightAxis("animations") },
                ]} />
              </Box>
              {rightAxis === "themes" ? (
                <ThemesMenu themes={kitThemes} activeId={kitTheme} onSelect={setKitTheme} />
              ) : (
                <AnimationsMenu
                  // The FULL resolved set (#3069) — ALL variations, each carrying its `group`/`default` —
                  // so the menu can present + switch each slot; the preview narrows it to what plays.
                  componentAnimations={sel ? resolveComponentAnimationDefs(sel, kits) : []}
                  shelf={kit?.animations ?? []}
                  boundShelfNames={(sel?.animations ?? []).filter((a): a is string => typeof a === "string")}
                  activeName={tryAnim}
                  onPlay={setTryAnim}
                  onSelectPreset={selectPreset}
                />
              )}
            </Box>
          ) : focusComp ? (
            <Inspector
              sel={focusComp} kitName={kit?.name ?? ""} tab={tab} setTab={setTab}
              allVariants={allVariants} activeVariant={activeVariant} setVariant={setVariant}
              vp={vp} setVpKind={setVpKind}
              previewState={previewState} setPreviewState={setPreviewState}
              kitTheme={kitTheme} setKitTheme={setKitTheme} kitThemes={kitThemes}
              previewTheme={theme}
              composes={composes} onSelect={selectComp}
              // Expanding to the theme try-on needs a real user selection; if the pane is showing Claude's
              // active node (no user pick), adopt it as the selection first so preview mode has a subject (#3090).
              onExpand={() => { if (!sel && focusComp) setCompId(focusComp.id); setPreviewMode(true); }}
            />
          ) : undefined
        }
        // Theme try-on (#2834): the expanded preview rides the untransformed `overlays` slot so it
        // covers the canvas (not the rail/inspector) and never pans/zooms. It renders only with an open
        // preview AND a live selection; stopPropagation keeps clicks off the canvas pan/deselect wiring.
        overlays={previewMode && sel ? (
          <Box
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            // cursor:default — the overlay covers the pannable canvas, so its bars must not inherit the
            // canvas `cursor: grab` (the graph beneath is covered and can't be panned here).
            style={{ position: "absolute", inset: 0, zIndex: 5, display: "flex", flexDirection: "column", background: "var(--bg-canvas, var(--bg))", cursor: "default" }}
          >
            <Box style={{ display: "flex", alignItems: "center", gap: 12, flex: "none", padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)" }}>
              <Button variant="ghost" onClick={() => { setPreviewMode(false); setTryAnim(null); }}>← Back to graph</Button>
              <Eyebrow size={9.5}>Theme preview</Eyebrow>
              <Text weight={600} size={13}>{sel.name}</Text>
              <Box style={{ flex: 1 }} />
              {/* Variant + viewport controls (#2834): moved here from the inspector — hidden in preview
                  mode — so the component's variant/breakpoint stay flippable while trying themes. The
                  variant switcher shows only when the component has more than one. */}
              {allVariants.length > 1 && (
                <SegmentedControl label="" options={allVariants.map((v) => ({ label: v, on: v === activeVariant, onClick: () => setVariant(v) }))} />
              )}
              {/* #3555: offer only the states THIS component supports (a static component gets no tabs). */}
              <SegmentedControl label="" options={supportedStates(sel).map((s) => ({ label: s, on: s === previewState, onClick: () => setPreviewState(s) }))} />
              <SegmentedControl label="" options={(["sm", "md", "auto"] as Viewport[]).map((k) => ({ label: k === "auto" ? "⤢ fluid" : k, on: k === vp, onClick: () => setVpKind(k) }))} />
              {/* Zoom controls (#3190) — post to the iframe's crisp pan/zoom engine (not a host viewport). */}
              <Box style={{ display: "flex", gap: 4 }}>
                <Button variant="ghost" onClick={() => previewZoomApi?.zoomOut()} aria-label="zoom out">−</Button>
                <Button variant="ghost" onClick={() => previewZoomApi?.zoomIn()} aria-label="zoom in">+</Button>
                <Button variant="ghost" onClick={() => previewZoomApi?.fit()}>fit</Button>
              </Box>
              {activeTheme && (
                <PaletteToggle label={activeTheme.label} open={showPalette} onToggle={() => setShowPalette((v) => !v)} />
              )}
            </Box>
            {/* Palette strip (#2834): the theme's semantic swatches — the raw palette beside the applied
                result. HIDDEN by default (#3706); the top-bar PaletteToggle reveals it on demand. */}
            {activeTheme && showPalette && <PaletteStrip theme={activeTheme} />}
            {/* Crisp pan/zoom (#3190): the host is just the FRAME. It measures this canvas and places the
                design viewport (previewW×previewH) at a fixed downscale-only fit (never upscales → the
                iframe texture stays 1:1-or-smaller → sharp). ALL pan/zoom happens INSIDE the iframe as a
                DOM transform on `#root` (the browser re-rasterizes crisply at any scale, unlike a
                CSS-scaled iframe). Drag pans anywhere (a click still interacts); the wheel scrolls/pans the
                content, ⌘/ctrl+wheel zooms; the +/−/fit buttons post commands to the engine. */}
            {/* eslint-disable-next-line no-restricted-syntax -- callback ref: a ResizeObserver reads this canvas's px size to size the fluid fit (#3190/#3551) */}
            <div
              ref={mountPreviewCanvas}
              style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: "var(--bg-canvas, var(--bg))" }}
            >
              {/* #3551: in fluid mode the frame IS the canvas (scale 1), so it mounts DIRECTLY — no placer
                  wrapper, one fewer same-size box in the stack. A fixed breakpoint keeps the placer, which
                  centers + downscale-fits its frame into the canvas via the transform. #3251: no
                  `user-select:none` here — the drag's selection guard lives in the engine's own srcdoc CSS
                  (CSS does not cross the iframe document boundary). */}
              {vp === "auto" ? expandedPreviewFrame : (
                <Box style={{ position: "absolute", left: 0, top: 0, width: previewW, height: previewH, pointerEvents: "auto", transform: `translate(${previewFit.tx}px,${previewFit.ty}px) scale(${previewFit.scale})`, transformOrigin: "0 0" }}>
                  {expandedPreviewFrame}
                </Box>
              )}
            </div>
          </Box>
        ) : legend}
      >
        {/* #3620: skip the 154-node world render while the Studio is HIDDEN (kept-mounted) — it was
            re-rendering at 20-32ms every few seconds in the background (a frequently-changing store
            subscription re-runs this whole subtree even at display:none). The DesignerTerminal dock (a
            prop above) stays mounted, so the always-on designer session survives; viewport + selection
            state live in DesignsWorkbench, so nothing is lost when the Studio is shown again. */}
        {scanVisible && (<>
        <svg width={world.w} height={world.h} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}>
          {/* Semantic swimlanes (#2964): Pages (top) · Composables (middle) · Fundamentals (base) — shifted
              below the library band (#3116) when the kit reaches into the library. */}
          {graph.lanes.map((lane, i) => (
            <g key={lane.tier} className={`ds-lane ds-lane-${lane.tier}`}>
              <rect x={0} y={lane.y0 + bandShift} width={world.w} height={lane.y1 - lane.y0} className="ds-lane-bg" />
              {i > 0 && <line x1={0} y1={lane.y0 + bandShift} x2={world.w} y2={lane.y0 + bandShift} className="ds-lane-divider" />}
              <text x={16} y={lane.y0 + bandShift + 20} className="ds-lane-label">{lane.label}</text>
            </g>
          ))}
          {/* The library band's fence (#3116/#3117) — library nodes sit ABOVE it, the composition below. */}
          {libComp.nodes.length > 0 && (
            <g className="ds-band">
              <text x={16} y={BAND_TOP - 12} className="ds-lane-label">Library</text>
              <line x1={0} y1={band.dividerY} x2={world.w} y2={band.dividerY} className="ds-band-fence" />
            </g>
          )}
          {orderedEdges.map((e) => {
            const a = graph.pos.get(e.from), b = graph.pos.get(e.to);
            if (!a || !b) return null;
            // The shared graph line-type (#2222) with PERIMETER-ANCHOR routing — the composition graph
            // is a layered TOP-DOWN DAG (#2455); the anchor router leaves each card facing the other.
            const g = graphEdge({ x: a.x, y: a.y + bandShift, w: NODE_W, h: NODE_H }, { x: b.x, y: b.y + bandShift, w: NODE_W, h: NODE_H });
            const on = incidentEdges.has(e.id); // incident to the selection → accent + thicker (#2523)
            const color = on ? EDGE_HL : EDGE_COLOR;
            return (
              <g key={e.id} className={on ? "ds-edge on" : "ds-edge"}>
                <path d={g.d} stroke={color} strokeWidth={on ? 2.25 : 1.5} fill="none" />
                <path d={g.arrow} fill={color} />
              </g>
            );
          })}
          {/* Dashed `requires` edges into the band (#3116/#3117): from a component UP to the library node it imports. */}
          {libComp.edges.map((e) => {
            const from = parseNodeUrn(e.fromUrn);
            const compPos = from ? graph.pos.get(from.id) : undefined;
            const libPos = bandPosByUrn.get(e.toUrn);
            if (!compPos || !libPos) return null;
            const g = graphEdge(
              { x: compPos.x, y: compPos.y + bandShift, w: NODE_W, h: NODE_H },
              { x: libPos.x, y: libPos.y, w: NODE_W, h: NODE_H },
            );
            return (
              <g key={e.id} className="ds-req-edge">
                <path d={g.d} stroke="var(--info)" strokeWidth={1.5} strokeDasharray="5 4" fill="none" />
                <path d={g.arrow} fill="var(--info)" />
              </g>
            );
          })}
        </svg>
        {/* Library band cards (#3116 algorithms, #3117 sounds) — the referenced library nodes, above the
            fence. Not selectable in this slice (they belong to another pillar's graph); the tooltip names the
            source. The card is graph-aware: an algorithm vendors its real code, a sound a generated player. */}
        {libComp.nodes.map((n) => {
          const pos = bandPosByUrn.get(n.urn); if (!pos) return null;
          const vendored = n.graph === "sound" ? "a generated player module" : "its real code";
          return (
            <Box key={n.urn} className="ds-algonode" style={{ left: pos.x, top: pos.y, width: NODE_W }} title={`${n.label} — @bsc/${LIBRARY_SEGMENT[n.graph]} (library ${n.kind}); the preview vendors ${vendored}`}>
              <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <StatusDot color="var(--info)" size={8} /><Text weight={600} size={13}>{n.label}</Text>
              </Box>
              <Text size={10} tone="dim">{n.kind} · {n.kit}</Text>
            </Box>
          );
        })}
        {kitComps.map((c) => {
          const pos = graph.pos.get(c.id); if (!pos) return null;
          // Full ring for the selection, softer ring for its related nodes (#2523); .on wins over .related.
          const state = c.id === selId ? " on" : relatedNodes.has(c.id) ? " related" : "";
          // AI live-focus (#2525): a DIFFERENT touched node pulses as `.working`; the user's `.on` wins if
          // it's the SAME node, so an active selection is never overridden.
          const working = c.id === (aiFocusedId ?? "") && c.id !== selId ? " working" : "";
          const badge = nodeHealth.get(c.id); // graph-health category (#2680), if any
          // Preview-error signal (#2838, #2908) — from the on-visit scan; ADDITIVE to the health badge
          // above (different corner, own class) so the concurrent graph-health work reconciles cleanly.
          // The scan reports a `build` failure (esbuild) OR a `runtime` throw (it now runs each build-clean
          // component in a hidden iframe, #2908) — the tooltip names which.
          const buildStatus = componentBuildStatus[c.id];
          const buildError = buildStatus?.state === "error"
            ? `Preview ${buildStatus.kind} error — ${buildStatus.message}`
            : null;
          // Empty-render signal (#2926) — built + mounted clean but produced no visible output.
          const emptyRender = buildStatus?.state === "empty" ? buildStatus.message : null;
          return (
            <Box key={c.id} data-node onClick={() => selectComp(c)} className={`ds-node${state}${working}${badge ? " unhealthy" : ""}`} style={{ left: pos.x, top: pos.y + bandShift, width: NODE_W }}>
              {badge && (
                <Text as="span" className={`ds-health ds-health-${badge}`} title={`${badge} — ${HEALTH_BADGE[badge].label}`}>{HEALTH_BADGE[badge].glyph}</Text>
              )}
              {buildError && (
                <Text as="span" className="ds-buildfail" title={buildError}>✖</Text>
              )}
              {emptyRender && (
                <Text as="span" className="ds-emptyrender" title={emptyRender}>▢</Text>
              )}
              <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, minWidth: 0 }}>
                {/* name truncates to ONE line (#3699) — a long name (GitHubCrossRepoActivity) must fit the
                    fixed-width node, not wrap + overflow. Full name on hover via `title`. */}
                <RoleDot role={c.role} /><Text weight={600} size={13} title={c.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</Text>
              </Box>
              <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minWidth: 0 }}>
                {/* group indicator (#3048) — the component's purpose partition, read inline on the
                    existing role line. Truncates to one line (#3699) — a long group (features/planner/fleet)
                    must not wrap; the ×used count is kept, never squeezed off. */}
                <Text size={10} tone="dim" title={c.folder ? `${c.role} · ${c.folder}` : c.role} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.role}{c.folder ? <Text as="span" tone="muted"> · {c.folder}</Text> : ""}</Text><Text mono size="xxs" tone="muted" style={{ flexShrink: 0, marginLeft: 6 }}>×{c.used}</Text>
              </Box>
            </Box>
          );
        })}
        </>)}
      </GraphCanvas>
    </>
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

// ── Inspector ────────────────────────────────────────────────────────────────
// The full per-component detail surface (#2453) — it absorbed the removed Library center view:
// identity header · live preview (variant/theme/viewport + error card) · Overview/Source/Usage tabs ·
// the generate-variants design bar.
interface InspProps {
  sel: ComponentRecord; kitName: string; tab: Tab; setTab: (t: Tab) => void;
  allVariants: string[]; activeVariant: string; setVariant: (v: string) => void;
  vp: Viewport; setVpKind: (v: Viewport) => void;
  previewState: PreviewState; setPreviewState: (s: PreviewState) => void;
  /** The preview's THEME axis (#2488/#2545): the hydrated theme collection + the applied selection.
   *  The selected theme drives both the retint (`vars`) and the sandbox surface (`base`). */
  kitTheme: string; setKitTheme: (id: string) => void; kitThemes: KitThemeRecord[];
  previewTheme: PreviewTheme;
  composes: ReturnType<typeof resolveComposes>; onSelect: (c: ComponentRecord) => void;
  /** Promote the thumbnail to the full-canvas theme try-on (#2834). */
  onExpand: () => void;
}
function Inspector(p: InspProps) {
  const sel = p.sel;
  // The small preview auto-cycles through the states this component supports (#3555), pausing on hover so
  // it can be inspected. Independent of the expanded try-on's manual `previewState`.
  const [hoverPreview, setHoverPreview] = useState(false);
  const cycleState = usePreviewStateCycle(sel, hoverPreview);
  const cyclesStates = previewCycleStates(sel).length > 1;
  // GraphCanvas owns the inspector column width now (#2766) — fill the wrapper it gives us; bring only
  // the left border + elevated surface (the old `.ds-col ds-insp` shell classes are gone). The Inspector
  // mounts ONLY with a focused component now (#3090), so there is no in-pane empty state.
  return (
    <Box data-testid="ds-inspector" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border)", background: "var(--bg-elev, var(--bg-soft))" }}>
      <Box className="ds-colhead">
        <Eyebrow size={9.5}>Inspector</Eyebrow>
        <Text size={10} tone="dim" style={{ display: "flex", alignItems: "center", gap: 5 }}><StatusDot color="var(--success)" size={6} />editable</Text>
      </Box>
      {/* identity — always visible above the preview */}
          <Box style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", flex: "none" }}>
            <RoleDot role={sel.role} size={9} glow={4} style={{ marginTop: 5 }} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text weight={600} size={16} style={{ letterSpacing: "-.01em" }}>{sel.name}</Text>
              <Text size={11.5} tone="muted" as="div" style={{ marginTop: 2 }}>{sel.role} · {p.kitName}</Text>
              {/* Folder breadcrumb (#3589) — WHERE this component lives in the kit's project tree. */}
              {sel.folder && (
                <Text mono size={10} tone="dim" as="div" title="folder" style={{ marginTop: 1 }}>{sel.folder}</Text>
              )}
            </Box>
            {/* THEME switcher (#2488/#2545) — a header-level control beside the component name (#3085):
                the ONE theme control (hydrated light/dark + designer-authored), driving both the surface
                (`base`) and the retint (`vars`). A compact select since the set grows via `bsc ui theme`. */}
            {/* eslint-disable-next-line no-restricted-syntax -- compact header select over a dynamic set (SelectField imposes a labelled field layout) */}
            <select
              className="sel"
              aria-label="Theme"
              title="Theme — surface + semantic-token palette applied to the specimen (bsc ui theme)"
              value={p.kitTheme}
              onChange={(e) => p.setKitTheme(e.target.value)}
              style={{ flex: "none", marginTop: 1 }}
            >
              {p.kitThemes.map((t) => (
                <option key={t.id} value={t.id}>◈ {t.label}</option>
              ))}
            </select>
            <Text mono size={10} tone="muted" style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "2px 7px", marginTop: 2 }}>v{sel.version}</Text>
          </Box>

          {/* live preview — folded in from the removed Library center view (#2453). #3190: the inspector's
              lead surface — no card, no control bar (the "Live preview" title + the data-state buttons were
              removed), so the preview sits right under the identity header. It's sized a touch below the
              detail tabs (see .ds-preview) rather than dominating the pane.
              Live preview (#2824): the component is BUILT (esbuild-wasm) from its real source and rendered in
              a sandboxed iframe — its own build/error state inside — filling the surface (fluid width, full
              height) so it reads at real size. */}
          <Box className="ds-preview" onMouseEnter={() => setHoverPreview(true)} onMouseLeave={() => setHoverPreview(false)}>
            <Box className="ds-surface">
              <Box className="ds-frame">
                <ComponentPreviewFrame
                  shotTarget
                  comp={sel}
                  theme={p.previewTheme}
                  themeId={p.kitTheme}
                  themeVars={p.kitThemes.find((t) => t.id === p.kitTheme)?.vars ?? {}}
                  width="100%"
                  height="100%"
                  onExpand={p.onExpand}
                  previewState={cycleState}
                />
              </Box>
              {/* A subtle marker of the auto-cycling state (#3555) — only when the component actually cycles.
                  Dims while hovered (cycling is paused, so it's less of a distraction). */}
              {cyclesStates && (
                <Box style={{ position: "absolute", left: 8, bottom: 8, zIndex: 2, pointerEvents: "none", padding: "1px 7px", borderRadius: 999, background: "color-mix(in srgb, var(--bg) 72%, transparent)", border: "1px solid var(--border-soft)", opacity: hoverPreview ? 0.5 : 0.9, transition: "opacity .2s" }}>
                  <Text mono size="xxs" tone="muted">{cycleState}</Text>
                </Box>
              )}
            </Box>
          </Box>

          {/* detail tabs */}
          <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Box className="ds-tabs">
              {(["overview", "source", "tests", "usage", "history"] as Tab[]).map((t) => (
                <Box as="button" key={t} role="tab" aria-selected={p.tab === t} className={`ds-tab${p.tab === t ? " on" : ""}`} onClick={() => p.setTab(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                  {/* The COUNT rides the Tests label (#3884) — the one tab whose emptiness is a finding, so
                      "how many" is worth seeing without opening it. Absent when there are none: a bare "0"
                      reads as a broken badge, and the empty panel says it better. */}
                  {t === "tests" && !!sel.tests?.length && <Text mono size={10} tone="dim" style={{ marginLeft: 4 }}>{sel.tests.length}</Text>}
                </Box>
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
              {p.tab === "tests" && <InspectorTests sel={sel} />}
              {p.tab === "usage" && (
                <Box style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  <GuideCard tone="success" title="✓ When to use" items={sel.whenUse} glyph="→" />
                  <GuideCard tone="danger" title="✗ When NOT to use" items={sel.whenNot} glyph="✕" />
                </Box>
              )}
              {p.tab === "history" && <InspectorHistory sel={sel} />}
            </Box>
          </Box>
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

/** The History tab body (#3568) — the component's change log, newest-first: one row per write with its
 *  rev, writer, when, optional note, and the fields that changed. The Rust stamp boundary records these on
 *  every `bsc ui` write (`bsc ui log <id>` reads the same log), so a session can review a component's past
 *  before editing it. Legacy records (never written since #3568) fall back to the single provenance stamp. */
/** The Tests tab body (#3884) — the node's `tests` manifest (#3878), each entry name + source.
 *
 *  The empty state is the DOCTOR'S verdict, not generic prose: an interactive node (one with an action
 *  prop) with no tests is exactly what `no-tests` flags, and a display-only node is expected to have none.
 *  It reads `isActionProp` from `graphHealth` rather than re-deriving "interactive", so the tab can never
 *  tell the user something the check disagrees with. */
function InspectorTests({ sel }: { sel: ComponentRecord }) {
  const tests = sel.tests ?? [];
  const interactive = sel.props.some(isActionProp);
  return (
    <Box style={{ padding: "14px 14px 16px" }} data-testid="ds-tests">
      <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>
        Tests{tests.length ? ` · ${tests.length}` : ""}
      </Text>
      {tests.length ? (
        <Box style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tests.map((t, i) => (
            <Box key={`${t.name}-${i}`}>
              <Text size={11.5} weight={600} as="div" style={{ marginBottom: 5 }}>{t.name}</Text>
              <Code maxHeight={9999} wrap={false}>{t.src}</Code>
            </Box>
          ))}
        </Box>
      ) : (
        <Box className="ds-inspbox">
          <Box className="ds-insprow">
            <Text size={11.5} tone={interactive ? "danger" : "dim"} as="div" style={{ lineHeight: 1.5 }}>
              {interactive
                ? `No tests. ${sel.name} is interactive — it exposes ${sel.props.filter(isActionProp).map((p) => p.name).join(", ")} — so bsc ui doctor reports it as no-tests.`
                : "No tests. This component exposes no action props, so the no-tests check stays silent for it — pin a non-trivial render anyway if it has one."}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function InspectorHistory({ sel }: { sel: ComponentRecord }) {
  // Stored oldest-first; the log reads newest-first (mirrors record::log_value).
  const entries: ChangeEntry[] = useMemo(() => [...(sel.history ?? [])].reverse(), [sel.history]);
  return (
    <Box style={{ padding: "14px 14px 16px" }}>
      <Text mono size="xxs" tone="dim" as="div" style={{ letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>
        Change history{entries.length ? ` · ${entries.length}` : ""}
      </Text>
      {entries.length ? (
        <Box style={{ display: "flex", flexDirection: "column", gap: 0, borderLeft: "1px dashed var(--border)", paddingLeft: 14 }}>
          {entries.map((e, i) => (
            <Box key={`${e.rev}-${i}`} style={{ position: "relative", paddingBottom: i === entries.length - 1 ? 0 : 16 }}>
              {/* timeline dot */}
              <Box style={{ position: "absolute", left: -20, top: 3, width: 8, height: 8, borderRadius: "50%", background: i === 0 ? "var(--accent)" : "var(--fg-muted)", border: "2px solid var(--bg-canvas)" }} />
              <Box style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: e.note ? 5 : 6 }}>
                <Text mono size={10.5} tone="accent" style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 5, padding: "1px 6px" }}>rev {e.rev}</Text>
                <Text size={11.5} weight={600}>{e.by || "unknown"}</Text>
                {e.at && <Text size={11} tone="dim" title={e.at}>{timeAgo(e.at) || e.at}</Text>}
              </Box>
              {e.note && <Text size={11.5} tone="muted" as="div" style={{ lineHeight: 1.45, marginBottom: 6 }}>{e.note}</Text>}
              <Box style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {e.changed.map((f) => (
                  <Text key={f} mono size={10.5} tone={f === "created" ? "accent" : "muted"} style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 5, padding: "1px 6px" }}>{f}</Text>
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      ) : (
        <Box className="ds-inspbox">
          <Box className="ds-insprow">
            <Text size={11.5} tone="dim">
              {sel.updatedBy
                ? `No detailed history — last written by ${sel.updatedBy}${sel.updatedAt ? ` ${timeAgo(sel.updatedAt) || ""}` : ""} (rev ${sel.rev ?? 0}).`
                : "No change history yet — it accrues one entry per edit as the component is authored."}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
