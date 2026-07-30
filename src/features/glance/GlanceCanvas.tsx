// Glance canvas (#2206) — the transform-based project-network graph: SVG dependency edges + project
// node cards. Renders the WORLD-LAYER content (grid + edges + nodes); the pan/zoom viewport frame is
// owned by the shared GraphCanvas template + useGraphViewport in the parent (#2208). Node = project;
// edge = dependency contract. The fixed hint/legend overlays are GlanceOverlays (drawn over, untransformed).
import { useCallback, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { GlanceStreamMorph } from "./GlanceStreamMorph";
import { GlancePreviewMorph } from "./GlancePreviewMorph";
import type { PreviewSource } from "@/shared/lib/preview/previewSource";
import type { PreviewReview } from "./usePreviewReview";
import { ROLE_COLOR, CATEGORY_META, HEALTH_META, ACTIVITY_META, EDGE_META, LIBRARY_META, MCP_META, SERVICE_META, isBandNode, bandNodeMeta, nodeStateWord, showsBuildingPulse, libraryGraphOf, isLibraryEdge, NW, NH, edgeGeom, type GraphModel, type GHealth, type GCategory, type GLibraryGraph } from "./lib/glanceGraph";
import { partAroundPanel, type MorphRect } from "./lib/glancePush";
import { unionRects } from "./lib/morphGrid";
import { archetypeById, hueColor } from "@/features/teams";

const ERR = "var(--graph-health-error)";
const HEALTH_ROWS: GHealth[] = ["idle", "healthy", "warning", "error", "off"];

// The neighbour-parting motion is driven off the SAME easing + duration as the panel's grow (the
// `.glance-card` transition in glance.css) — keep these in sync — so the panel growing and the graph
// parting read as one coordinated motion instead of two clocks racing (the old .2s vs .4s mismatch).
const MORPH_EASE = ".4s cubic-bezier(.22, .61, .36, 1)";

const REST_N = 0.14, REST_E = 0.06;
// Project-network (L0) legend rows. The accent buckets are the LIFECYCLE categories (#2583 — what KIND
// of work each project is), NOT the old microservices tiers; EDGE labels come from EDGE_META so the
// legend + connect picker stay in sync (#2561).
const CATEGORY_ORDER: GCategory[] = ["greenfield", "transform", "harden", "maintain", "data", "script"];
const ROLE_ROWS_L0: [string, string][] = CATEGORY_ORDER.map((c) => [CATEGORY_META[c].label, CATEGORY_META[c].color]);
const EDGE_ROWS_L0: [string, string, string][] = [
  [EDGE_META.api.label, EDGE_META.api.color, EDGE_META.api.dash],
  [EDGE_META.data.label, EDGE_META.data.color, EDGE_META.data.dash],
  [EDGE_META.events.label, EDGE_META.events.color, EDGE_META.events.dash],
  [EDGE_META["uses-kit"].label, EDGE_META["uses-kit"].color, EDGE_META["uses-kit"].dash], // #2571 kit-consumer edge
  [EDGE_META.requires.label, EDGE_META.requires.color, EDGE_META.requires.dash],           // #3119 cross-graph library edge
  [EDGE_META["uses-mcp"].label, EDGE_META["uses-mcp"].color, EDGE_META["uses-mcp"].dash], // #3786 external mcp-contract edge
  ["cycle", "var(--graph-health-error)", "7 6"],
];
// The fenced-band node dimensions (#3119 + #3786) — the library flavours (kit/algorithm/sound) + the
// external contracts (mcp + service), each its own accent + glyph. Shown as a distinct legend column at
// L0 (not while drilled into a fleet). The `uses-mcp`/`uses-service` edges share the "contracts with"
// label, so they get ONE edge legend row (uses-mcp above); the node dimensions distinguish them here.
const LIBRARY_GRAPHS: GLibraryGraph[] = ["ui", "algo", "sound"];
const LIBRARY_ROWS: [string, string, string][] = [
  ...LIBRARY_GRAPHS.map((g): [string, string, string] => [LIBRARY_META[g].kindLabel, LIBRARY_META[g].color, LIBRARY_META[g].marker]),
  [MCP_META.kindLabel, MCP_META.color, MCP_META.marker],         // #3786 external mcp-contract node
  [SERVICE_META.kindLabel, SERVICE_META.color, SERVICE_META.marker], // #3786 Phase 2 external service-contract node
];
// Fleet-drill (L1) legend: the role colour buckets read as agent FUNCTION groups; the edge rows are the
// Org relationship archetypes actually present in the drilled fleet (#2561).
const ROLE_ROWS_L1: [string, string][] = [["orchestrate", ROLE_COLOR.infra], ["build", ROLE_COLOR.service], ["verify", ROLE_COLOR.data], ["flow", ROLE_COLOR.client]];
const ARCH_DASH: Record<string, string> = { solid: "", dashed: "6 5", dotted: "2 4", gated: "", resource: "4 4" };

interface CanvasProps {
  model: GraphModel;
  /** True during a pan-drag — suppresses the click that ends it (from the shared viewport). */
  dragMoved: React.MutableRefObject<boolean>;
  focus: { nodes: Set<string>; edges: Set<string> } | null;
  selNodeId: string | null;
  selEdgeId: string | null;
  /** True while DRILLED INTO A FLEET (L1) — the graph is showing worker/director agents rather than
   *  the project network. Only the fleet's own nodes carry a live session, so it gates the
   *  building pulse (#4015): a PROJECT node on L0 must never animate.
   *
   *  An explicit prop rather than inferring from `n.category`: a project whose lifecycle was never
   *  classified has no category either, so the inference would quietly animate exactly the L0 nodes
   *  it was meant to exclude. */
  fleet?: boolean;
  onHoverNode: (id: string | null) => void;
  onHoverEdge: (id: string | null) => void;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  /** The graph's current zoom (`vp.view.scale`) — threaded to the terminal morph so its corner-resize
   *  converts a screen-pixel drag into world units. */
  zoom?: number;
  /** The live agents whose terminals are morphed open IN the graph (#2534 → MULTI, #3361) — each an
   *  oversized node grown into its GRID SLOT. Empty = none open. `slot` is computed by the workspace
   *  from the grid anchored on the FIRST opened node, so two morphs can never overlap. */
  chats?: { nodeId: string; paneId: string; name: string; role?: string; slot: MorphRect }[];
  /** Collapse ONE morph back into its node (keeps its PTY alive). */
  onCloseChat?: (nodeId: string) => void;
  /** END one open session (#3049) — kill its PTY + drop the cell from the live set, so a soft-locked
   *  agent is fully torn down and triage can be relaunched. */
  onEndChat?: (nodeId: string) => void;
  /** A resize drag on any morph — resizes the grid's SHARED cell, so every open morph moves as one. */
  onResizeCell?: (w: number, h: number) => void;
  /** The PREVIEW node morphed open (#2623) — the finished app rendered IN the graph, at its node's
   *  world coords. `source` is null until the verify-build produces one. Null = none open. */
  preview?: { nodeId: string; name: string; source: PreviewSource | null; building?: boolean; onBuild?: () => void; review?: PreviewReview } | null;
  onClosePreview?: () => void;
}

/** The world-layer content — placed inside GraphCanvas's transformed world box. */
export function GlanceCanvas(p: CanvasProps) {
  const { model, focus } = p;
  // The node whose terminal is morphed open (#2534) — resolved from the live model so its world coords
  // (and thus the card's position) always track the current graph.
  // The open morphs, resolved against the live model so each card's return box tracks its node (#3361).
  const chats = p.chats ?? [];
  const openChats = chats.flatMap((c) => {
    const node = model.nodes.find((n) => n.id === c.nodeId);
    return node ? [{ ...c, node }] : [];
  });
  const openChatIds = useMemo(() => new Set(openChats.map((c) => c.nodeId)), [openChats]);
  // The PREVIEW node morphed open (#2623) — resolved from the live model so its card tracks the graph.
  const previewNode = p.preview ? model.nodes.find((n) => n.id === p.preview!.nodeId) ?? null : null;
  // A node/edge click: suppressed after a pan-drag, and stopPropagation so it doesn't bubble to the
  // backdrop deselect (Glance nodes aren't [data-node]) (#2232).
  const click = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (!p.dragMoved.current) fn(); };

  // The open terminal panel's world box (#2662, reported by the morph) — the graph PARTS around it in
  // four rigid curtains (#2671): every neighbour clears the panel by construction (no clipping) and each
  // curtain keeps its spacing (no node-into-node clipping). Edges of shifted nodes follow.
  // #3361: each open morph reports its own world box; the graph parts around their UNION — one region,
  // so the four-curtain model is unchanged whether one morph is open or six. Keyed by paneId so a
  // morph's report replaces its own previous one; it reports null the instant it starts collapsing, so
  // the neighbours part back in step with the shrink rather than a full exit animation later.
  const [morphRects, setMorphRects] = useState<Record<string, MorphRect | null>>({});
  const reportRect = useCallback((paneId: string) => (rect: MorphRect | null) => {
    setMorphRects((prev) => (prev[paneId] === rect ? prev : { ...prev, [paneId]: rect }));
  }, []);
  const morphRect = useMemo(
    () => unionRects(Object.values(morphRects).filter((r): r is MorphRect => !!r)),
    [morphRects],
  );
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model.nodes]);
  const pushMap = useMemo(() => {
    if (!morphRect) return new Map<string, { dx: number; dy: number }>();
    return partAroundPanel(model.nodes, morphRect, openChatIds);
  }, [morphRect, model.nodes, openChatIds]);

  // The dimension(s) present in the fenced band (#3119 + #3786) — library graphs (kit/algo/sound) AND/OR
  // the external MCP contract — drive its accent + header. A single-dimension band reads in that
  // dimension's colour + name (kit-only stays cyan "UI KITS", byte-identical to #3007; mcp-only reads
  // amber "MCP SERVERS"); a mixed band is neutral "LIBRARIES".
  const bandDims = useMemo(() => {
    const s = new Set<string>();
    for (const n of model.nodes) {
      const g = libraryGraphOf(n);
      if (g) s.add(g);
      else if (n.kind === "mcp") s.add("mcp");
      else if (n.kind === "service") s.add("service");
    }
    return [...s];
  }, [model.nodes]);
  const soleDim = bandDims.length === 1 ? bandDims[0] : null;
  const bandMeta = soleDim === "mcp" ? MCP_META : soleDim === "service" ? SERVICE_META : soleDim ? LIBRARY_META[soleDim as GLibraryGraph] : null;
  const bandColor = bandMeta ? bandMeta.color : "var(--fg-muted)";
  const bandLabel = bandMeta ? bandMeta.bandLabel : "LIBRARIES";

  return (
    <>
      {/* The dotted graph-paper backdrop is owned by the shared GraphCanvas (an infinite viewport
          grid, `grid gridSize={28}` in GlanceWorkspace) — #2418, same as the org designer (#2389). */}

      {/* edges */}
      <svg width={model.worldW} height={model.worldH} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        {/* The fenced LIBRARY band (#3007, generalized #3119) — drawn FIRST so it sits behind the edges +
            nodes. A faint wash, a dashed divider at the fence, and a small header label, mirroring the
            Design Studio composition swimlanes so the lifted library nodes read as a distinct top zone.
            Colour + label follow the dimension(s) present (kit-only ⇒ cyan "UI KITS", unchanged). */}
        {model.kitBand && (
          <g className="glance-kit-band" style={{ pointerEvents: "none" }}>
            <rect x={0} y={model.kitBand.y0} width={model.worldW} height={model.kitBand.y1 - model.kitBand.y0} className="glance-kit-band-bg" style={{ fill: bandColor }} />
            <line x1={0} y1={model.kitBand.y1} x2={model.worldW} y2={model.kitBand.y1} className="glance-kit-band-divider" style={{ stroke: bandColor }} />
            <text x={16} y={model.kitBand.y0 + 22} className="glance-kit-band-label" style={{ fill: bandColor }}>{bandLabel}</text>
          </g>
        )}
        {model.edges.map((e) => {
          const meta = EDGE_META[e.kind];
          // A fleet-drill (L1) edge is fully styled by its Org relationship archetype (#2561/#2565) —
          // colour by hue, dash by the archetype's style — so `kind` is vestigial at L1; a project (L0)
          // edge keeps the kind colour + dash.
          const arch = e.archetype ? archetypeById(e.archetype) : undefined;
          const inFocus = focus ? focus.edges.has(e.id) : true;
          // A cyclical archetype (iterates, #2578) is a DELIBERATE loop — keep the archetype's hue (not
          // the red hazard tint) but the animated cycle dash, so it reads as an intentional iteration loop.
          const loop = e.isCycle && !!arch?.cyclical;
          // A LIBRARY edge (#3119) is tinted by its TARGET node's graph accent — uses-kit→ui cyan,
          // requires→algo violet / →sound pink — so a mixed band's edges read per-dimension. For a
          // `uses-kit` edge the target is a kit node ⇒ ui ⇒ KIT_COLOR == meta.color (byte-identical).
          const libGraph = isLibraryEdge(e.kind) ? libraryGraphOf(nodeById.get(e.to) ?? {}) : undefined;
          const libColor = libGraph ? LIBRARY_META[libGraph].color : undefined;
          const color = loop ? hueColor(arch!.hue) : e.isCycle ? "var(--graph-health-error)" : arch ? hueColor(arch.hue) : (libColor ?? meta.color);
          const width = (e.isCycle ? 2.3 : arch ? 1.8 : meta.w) + (inFocus && focus ? 0.7 : 0);
          const dash = e.isCycle ? "7 6" : arch ? (ARCH_DASH[arch.style] ?? "") : meta.dash;
          const opacity = e.isCycle ? (focus ? (inFocus ? 1 : 0.4) : 0.95) : (focus ? (inFocus ? 1 : REST_E) : 0.82);
          // When either endpoint is pushed aside by the open panel (#2662), re-route the edge to the
          // displaced node boxes so it stays attached; else use the model's precomputed path.
          const dF = pushMap.get(e.from), dT = pushMap.get(e.to);
          let d = e.d, arrow = e.arrow;
          if (morphRect && (dF || dT)) {
            const F = nodeById.get(e.from), T = nodeById.get(e.to);
            if (F && T) {
              const g = edgeGeom({ x: F.x + (dF?.dx ?? 0), y: F.y + (dF?.dy ?? 0), id: e.from },
                                 { x: T.x + (dT?.dx ?? 0), y: T.y + (dT?.dy ?? 0), id: e.to }, e.isCycle, e.kind);
              d = g.d; arrow = g.arrow;
            }
          }
          // Ease the path only while a panel is open (WebView2/Chromium animates `d`); off otherwise so
          // normal graph updates (drill/layout) don't animate. Matched to the panel's grow (MORPH_EASE)
          // so a re-routed edge tracks its parting endpoints in lockstep with the panel (#2671).
          const pathTween = morphRect ? `d ${MORPH_EASE}` : undefined;
          return (
            <g key={e.id} opacity={opacity} onMouseEnter={() => p.onHoverEdge(e.id)} onMouseLeave={() => p.onHoverEdge(null)} onClick={click(() => p.onSelectEdge(e.id))} style={{ cursor: "pointer", transition: "opacity .18s" }}>
              <path d={d} stroke="transparent" strokeWidth={16} fill="none" />
              {/* stroke/fill via `style` (not the SVG attribute) so the `var(--graph-*)` token RESOLVES —
                  CSS custom properties don't resolve in SVG presentation attributes (#2618). */}
              <path d={d} strokeWidth={width} strokeDasharray={dash} fill="none" strokeLinecap="round"
                style={{ stroke: color, transition: pathTween, ...(e.isCycle ? { animation: "glance-dashmove .75s linear infinite" } : {}) }} />
              <path d={arrow} style={{ fill: color, transition: pathTween }} />
            </g>
          );
        })}
      </svg>

      {/* nodes */}
      {model.nodes.map((n) => {
        // A shared-RESOURCE node (#3322) — a library a session stewards, NOT an agent. A distinct dashed
        // card (⬡ + "resource") in a muted tone, so it never reads as a worker/agent node.
        if (n.resource) {
          const selected = p.selNodeId === n.id;
          const inFocus = focus ? focus.nodes.has(n.id) : true;
          const push = pushMap.get(n.id);
          const accent = "var(--fg-muted)";
          const border = selected ? "var(--accent)" : focus && inFocus ? accent : "var(--border-soft)";
          return (
            <Box key={n.id} data-glance-node={n.id} onMouseEnter={() => p.onHoverNode(n.id)} onMouseLeave={() => p.onHoverNode(null)} onClick={click(() => p.onSelectNode(n.id))}
              style={{ position: "absolute", left: n.x, top: n.y, width: NW, height: NH, cursor: "pointer",
                transform: push ? `translate(${push.dx}px, ${push.dy}px)` : undefined,
                zIndex: selected ? 6 : inFocus ? 3 : 1, opacity: focus ? (inFocus ? 1 : REST_N) : 1, transition: `opacity .18s ease, transform ${MORPH_EASE}` }}>
              <Box style={{ width: "100%", height: "100%", background: "var(--bg-soft)", border: `1.5px dashed ${border}`,
                borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
                boxShadow: selected ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)" : "0 2px 8px rgba(0,0,0,.35)" }}>
                <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Text as="span" style={{ color: accent, flex: "none", fontSize: 12, lineHeight: 1 }}>⬡</Text>
                  <Text as="span" mono size={13} weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
                </Box>
                <Text as="span" mono size={10} style={{ marginTop: 9, textTransform: "uppercase", letterSpacing: ".5px", color: accent }}>resource</Text>
              </Box>
            </Box>
          );
        }
        // A fenced-BAND node reads distinctly — a dashed card in its dimension's accent, with the glyph
        // (◆/∑/♪ for a cross-graph LIBRARY node #2571/#3119; ⇄ for an external MCP-CONTRACT node #3786), the
        // kind word (kit/algorithm/sound/mcp), and the count of consuming projects (the edges INTO it) — so
        // it never looks like a project node. The `ui` case is byte-identical to the pre-#3119 kit card
        // (cyan · ◆ · "kit"). An mcp node additionally shows its `appType` (api/serverless).
        if (isBandNode(n)) {
          const lib = bandNodeMeta(n);
          const consumers = model.edges.reduce((acc, e) => acc + (e.to === n.id ? 1 : 0), 0);
          const selected = p.selNodeId === n.id;
          const inFocus = focus ? focus.nodes.has(n.id) : true;
          const push = pushMap.get(n.id);
          const border = selected ? "var(--accent)" : (focus && inFocus ? lib.color : `color-mix(in oklch, ${lib.color} 45%, transparent)`);
          return (
            <Box key={n.id} data-glance-node={n.id} onMouseEnter={() => p.onHoverNode(n.id)} onMouseLeave={() => p.onHoverNode(null)} onClick={click(() => p.onSelectNode(n.id))}
              style={{ position: "absolute", left: n.x, top: n.y, width: NW, height: NH, cursor: "pointer",
                transform: push ? `translate(${push.dx}px, ${push.dy}px)` : undefined,
                zIndex: selected ? 6 : inFocus ? 3 : 1, opacity: focus ? (inFocus ? 1 : REST_N) : 1, transition: `opacity .18s ease, transform ${MORPH_EASE}` }}>
              <Box style={{ width: "100%", height: "100%", background: "var(--bg-elev)", border: `1.5px dashed ${border}`,
                borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
                boxShadow: selected ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)" : "0 2px 8px rgba(0,0,0,.45)", transition: "border-color .15s, box-shadow .15s" }}>
                <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Text as="span" style={{ color: lib.color, flex: "none", fontSize: 11, lineHeight: 1 }}>{lib.marker}</Text>
                  <Text as="span" mono size={13} weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
                </Box>
                <Box style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
                  {/* The kind word — and for an external CONTRACT node (mcp/service) its appType
                      (api/serverless/…), the contract endpoint type (#3786). Library/kit nodes carry no
                      appType, so they read just the kind word. */}
                  <Text as="span" mono size={10} style={{ textTransform: "uppercase", letterSpacing: ".5px", color: lib.color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {n.appType ? `${lib.kindLabel} · ${n.appType}` : lib.kindLabel}
                  </Text>
                  <Box style={{ flex: 1 }} />
                  <Text as="span" mono size={10} weight={500} tone="dim" style={{ flex: "none" }}>{consumers} app{consumers === 1 ? "" : "s"}</Text>
                </Box>
              </Box>
            </Box>
          );
        }
        // A PROJECT (L0) node is accented by its LIFECYCLE category (#2583); a fleet-drill (L1) node has
        // no category and keeps its function-group `role` colour.
        const cat = n.category ? CATEGORY_META[n.category] : undefined;
        const role = cat ? cat.color : ROLE_COLOR[n.role];
        // Axis 1 — HEALTH (#2541): the top-left dot renders the ROLLED-UP health (worst of self + deps).
        const health = HEALTH_META[n.rollupHealth];
        const inherited = n.healthInherited;                 // lit only by a downstream dep → muted, no pulse
        const isError = n.rollupHealth === "error";
        const degraded = isError || n.rollupHealth === "warning";
        // The user-deactivated node (#3239): render it greyed + calm — the OFF health wins over the live
        // status word (a building/live node still reads "off") and mutes every activity pulse.
        const isOff = n.rollupHealth === "off";
        // Axis 2 — ACTIVITY (#2541): the bottom-right word. A degraded node swaps in its HEALTH word
        // (#3957) — `warning`/`error` — not its reason. This slot is one word wide (108px, nowrap,
        // ellipsis), so a reason never overflowed; it TRUNCATED, and
        // "waiting on 2 upstreams to land (domain-model…" rendered as "waiting on 2 upstre…", which
        // reads as garbage rather than a status. Substituting the reason made sense when reasons were
        // short fault titles, but `applyStallHealth` appends a duration and #3931's `heldReason` names
        // every unlanded upstream. Nothing is lost: the dot carries the colour, the `title` below
        // carries the full reason on hover, and GlanceInspector renders it in a REASON tile.
        const ownDegraded = n.health === "warning" || n.health === "error";
        const bottomText = nodeStateWord(n);
        const bottomColor = isOff || degraded ? health.color : "var(--fg-muted)";
        const bottomPulse = !isOff && !degraded && ACTIVITY_META[n.activity].pulse;

        const selected = p.selNodeId === n.id;
        const inFocus = focus ? focus.nodes.has(n.id) : true;
        const isCycle = model.cycleNodeIds.has(n.id);
        // A node in a mutual-dependency HAZARD cycle tints red; a node in an intentional iteration LOOP
        // (all its cycle edges cyclical, #2578) tints with the loop archetype's hue instead — not a fault.
        const hazardCycle = isCycle && model.edges.some((e) => e.isCycle && (e.from === n.id || e.to === n.id) && !archetypeById(e.archetype ?? "")?.cyclical);
        const loopHue = isCycle && !hazardCycle
          ? hueColor(archetypeById(model.edges.find((e) => e.isCycle && (e.from === n.id || e.to === n.id) && archetypeById(e.archetype ?? "")?.cyclical)?.archetype ?? "")?.hue ?? 300)
          : undefined;
        // ERROR highlights the whole node red (#2541) — the origin (own error) full-strength, an inherited
        // (downstream) error softer, so the eye lands on the source. Beats the cycle tint; selection wins.
        const border = selected ? "var(--accent)"
          : n.preview ? "var(--accent)"  // the ▷ preview node (#2623) — the finished-app surface, accented
          : isOff ? "var(--border-soft)"  // #3239: a deactivated node reads calm — a muted, neutral border
          : isError ? (inherited ? `color-mix(in oklch, ${ERR} 42%, transparent)` : ERR)
          : hazardCycle ? `color-mix(in oklch, ${ERR} 55%, transparent)`
          : loopHue ? `color-mix(in oklch, ${loopHue} 55%, transparent)`
          : (focus && inFocus ? "var(--border)" : "var(--border-soft)");
        // #4015 — the BUILDING pulse, gated to fleet (L1) nodes. Suppressed on a deactivated node
        // (which is meant to read calm) and on an errored one (its own error pulse is the thing to
        // look at; two competing animations on one node read as noise).
        const pulseBuilding = showsBuildingPulse(n, { fleet: !!p.fleet, isOff, isError });
        const boxShadow = selected ? "0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent)"
          : isError && !inherited ? `0 0 0 3px color-mix(in oklch, ${ERR} 22%, transparent), 0 2px 8px rgba(0,0,0,.45)`
          : "0 2px 8px rgba(0,0,0,.45)";
        // Pushed clear of the open terminal panel, if it overlaps (#2662) — the panel makes room.
        const push = pushMap.get(n.id);
        // A deactivated node (#3239) is dimmed in place — muted, but a touch more visible while selected so
        // its open details pane (where it's turned back on) still reads as the focus.
        const offOpacity = isOff ? (selected ? 0.72 : 0.42) : 1;
        return (
          <Box key={n.id} data-glance-node={n.id} onMouseEnter={() => p.onHoverNode(n.id)} onMouseLeave={() => p.onHoverNode(null)} onClick={click(() => p.onSelectNode(n.id))}
            style={{ position: "absolute", left: n.x, top: n.y, width: NW, height: NH, cursor: "pointer",
              transform: push ? `translate(${push.dx}px, ${push.dy}px)` : undefined,
              // Part in lockstep with the panel's grow (MORPH_EASE), so the two are one motion (#2671).
              zIndex: selected ? 6 : isError && !inherited ? 5 : inFocus ? 3 : 1, opacity: focus ? (inFocus ? offOpacity : REST_N) : offOpacity, transition: `opacity .18s ease, transform ${MORPH_EASE}` }}>
            <Box style={{ width: "100%", height: "100%", background: "var(--bg-elev)", border: `1px solid ${border}`,
              borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
              boxShadow, transition: "border-color .15s, box-shadow .15s",
              // #4015 — a WORKER that is actively building breathes; one parked in maintenance sits
              // still. That is the whole distinction, and an animation carries it without inventing a
              // health state (a colour would have to compete with the health axis, which already means
              // something else) and without touching the node's static appearance at all.
              //
              // Fleet-only: an L0 project node never animates, however busy the project is.
              animation: pulseBuilding ? "glance-buildpulse 1.8s ease-in-out infinite" : undefined }}>
              <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* Axis-1 health dot. Error pulses at the ORIGIN; an inherited dot is dimmed (no pulse). */}
                <Box title={`${n.rollupHealth}${inherited ? " (downstream)" : ""}`}
                  style={{ width: 8, height: 8, borderRadius: "50%", background: health.color, flex: "none", opacity: inherited ? 0.5 : 1,
                    boxShadow: health.pulse && !inherited ? `0 0 8px ${health.color}` : "none", animation: health.pulse && !inherited ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }} />
                <Text as="span" mono size={13} weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
                {/* The APP-TYPE discriminator (#3786/#3802) — a subtle mono micro-label on the title line: what
                    KIND of app this endpoint is (api/serverless/cli/…). Gated on a non-default classification,
                    so an unclassified project (appType absent, or "application") renders byte-identical. */}
                {n.appType && n.appType !== "application" && (
                  <Text as="span" mono size={8.5} title={`app type: ${n.appType}`}
                    style={{ flex: "none", textTransform: "uppercase", letterSpacing: ".4px", color: "var(--fg-muted)", opacity: 0.7,
                      border: "1px solid var(--border-soft)", borderRadius: 4, padding: "1px 4px", lineHeight: 1.3 }}>{n.appType}</Text>
                )}
              </Box>
              <Box style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
                <Text as="span" mono size={10} style={{ textTransform: "uppercase", letterSpacing: ".5px", color: role }}>{cat ? cat.label : (n.roleLabel ?? n.role)}</Text>
                <Box style={{ flex: 1 }} />
                {/* Axis-2 activity word, or the fault reason when degraded. */}
                <Text as="span" mono size={10} weight={500} title={ownDegraded && n.reason ? n.reason : undefined}
                  style={{ color: bottomColor, maxWidth: 108, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    animation: bottomPulse ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }}>{bottomText}</Text>
              </Box>
            </Box>
          </Box>
        );
      })}

      {/* A live agent's terminal, morphed open IN the graph (#2534): an oversized node grown at the
          clicked node's world coords, so it pans/zooms/scales with the canvas. No portal, no scrim. */}
      {p.onCloseChat && openChats.map((c) => (
        // Keyed by paneId (#3049/#3361): a morph's identity is its session, so opening or closing a
        // SIBLING never remounts it — its terminal keeps its TerminalHost claim and its pending exit
        // timer is only ever cancelled by its own unmount.
        <GlanceStreamMorph
          key={c.paneId}
          node={c.node} slot={c.slot} paneId={c.paneId} name={c.name} role={c.role} zoom={p.zoom}
          onRect={reportRect(c.paneId)}
          onResizeCell={p.onResizeCell}
          onClose={() => p.onCloseChat!(c.nodeId)}
          onEnd={p.onEndChat ? () => p.onEndChat!(c.nodeId) : undefined}
        />
      ))}

      {/* The PREVIEW node, morphed open into the finished application IN the graph (#2623). */}
      {previewNode && p.preview && p.onClosePreview && (
        <GlancePreviewMorph node={previewNode} source={p.preview.source} name={p.preview.name} building={p.preview.building} onBuild={p.preview.onBuild} review={p.preview.review} onClose={p.onClosePreview} />
      )}
    </>
  );
}

/** The fixed hint + legend overlays — drawn over the canvas, not transformed. Drill-aware (#2561): the
 *  ROLE + EDGE columns speak the fleet's Org grammar (agent FUNCTION groups + relationship archetypes)
 *  when a project is drilled, and the project-network vocabulary at the root. `archetypes` are the
 *  distinct archetype ids present in the drilled fleet. */
export function GlanceOverlays({ drill = false, archetypes = [] }: { drill?: boolean; archetypes?: string[] } = {}) {
  const roleRows = drill ? ROLE_ROWS_L1 : ROLE_ROWS_L0;
  const edgeRows: [string, string, string][] = drill
    ? [
        ...archetypes.map((a): [string, string, string] => {
          const ar = archetypeById(a);
          return ar ? [ar.label, hueColor(ar.hue), ARCH_DASH[ar.style] ?? ""] : [a, "var(--fg-muted)", ""];
        }),
        ["cycle", "var(--graph-health-error)", "7 6"],
      ]
    : EDGE_ROWS_L0;
  return (
    <>
      {/* hint */}
      <Box style={{ position: "absolute", left: 16, bottom: 16, pointerEvents: "none" }}>
        <Text as="div" mono size={10.5} tone="dim" style={{ lineHeight: 1.7 }}>drag to pan · scroll to zoom<br />click node → {drill ? "open agent" : "enter"} · click edge → {drill ? "relationship" : "contract"}</Text>
      </Box>

      {/* legend */}
      <Box style={{ position: "absolute", right: 16, bottom: 16, background: "color-mix(in oklch, var(--bg-elev) 85%, transparent)", backdropFilter: "blur(8px)",
        border: "1px solid var(--border)", borderRadius: 9, padding: "12px 14px", pointerEvents: "none", display: "flex", gap: 22 }}>
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>HEALTH</Text>
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {HEALTH_ROWS.map((h) => (
              <Box key={h} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Box style={{ width: 8, height: 8, borderRadius: "50%", background: HEALTH_META[h].color, flex: "none" }} />
                <Text as="span" mono size={10} tone="muted">{HEALTH_META[h].label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>{drill ? "FUNCTION" : "LIFECYCLE"}</Text>
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {roleRows.map(([label, color]) => (
              <Box key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <Box style={{ width: 9, height: 3, borderRadius: 2, background: color }} />
                <Text as="span" mono size={10} tone="muted">{label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        <Box>
          <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>{drill ? "RELATIONSHIP" : "EDGE"}</Text>
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {edgeRows.map(([label, color, dash]) => (
              <Box key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <svg width={14} height={2} style={{ flex: "none", overflow: "visible" }}><line x1={0} y1={1} x2={14} y2={1} strokeWidth={2} strokeDasharray={dash} style={{ stroke: color }} /></svg>
                <Text as="span" mono size={10} style={{ color: label === "cycle" ? "var(--cycle)" : "var(--fg-muted)" }}>{label}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        {/* The cross-graph LIBRARY node dimensions (#3119) — the fenced-band flavours (kit/algorithm/sound),
            each its own accent + glyph. L0 only (a drilled fleet has no library band). */}
        {!drill && (
          <Box>
            <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", marginBottom: 8 }}>LIBRARY</Text>
            <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {LIBRARY_ROWS.map(([label, color, marker]) => (
                <Box key={label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Text as="span" style={{ color, flex: "none", width: 9, textAlign: "center", fontSize: 9, lineHeight: 1 }}>{marker}</Text>
                  <Text as="span" mono size={10} tone="muted">{label}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </>
  );
}
