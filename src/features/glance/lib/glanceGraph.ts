// Glance — the workspace project-network graph model (#2206, epic #2205). Pure (no React/Tauri): turns
// a raw {nodes, edges} project graph into a laid-out, cycle-aware model the canvas renders. Ported from
// the user's "Relationship graph interaction spec" (Glance Network) buildModel — generalized to take
// the graph as input (the real project list feeds it via glanceData.ts) instead of hardcoded data.
//
// The graph is a DEPENDENCY DAG: `from depends on to`. Layers flow left→right by dependency depth
// (a foundational project with no deps sits at layer 0). Mutual pairs (a↔b) are CYCLES — surfaced as
// coordination hazards. This is the DAG/graph layout in the "layout follows data structure" sense
// (#2204): the same layered algorithm the Org designer uses, on a different domain.
import { neighborSpotlight } from "@/shared/lib/graph/spotlight";
import { mutualPairs } from "@/shared/lib/graph/cycles";
import { layerDag } from "@/shared/lib/graph/layers";
import { orderLayers } from "@/shared/lib/graph/order";
import { graphEdge } from "@/shared/lib/graph/edgePath";
import { layoutBand } from "@/shared/lib/graph/crossGraph";
import type { NodeGraph } from "@/shared/lib/graph/nodeUrn";

export type GRole = "infra" | "service" | "data" | "client";
/** A project's LIFECYCLE category (#2583) — what KIND of work it is, the app's real project vocabulary
 *  (mirrors `BlueprintCategory`). Drives a project (L0) node's accent colour + chip, REPLACING the
 *  microservices-tier `role` (which was hash-assigned per id and collided with the health palette). A
 *  fleet-drill (L1) node has no category and keeps its function-group `role` colouring. */
export type GCategory = "greenfield" | "transform" | "harden" | "maintain" | "data" | "script";
/** Axis 1 — HEALTH (#2541): the top-left dot colour + the attention/propagation signal. An escalation
 *  ladder that rolls UP the dependency chain (a node shows the worst of itself + everything it depends
 *  on). `idle`/`healthy` never propagate — only `warning`/`error` do. Sourced from the worst unresolved
 *  `bsc errors` FaultLevel; this REPLACES the old separate fault badge. `off` (#3239) is the one MANUAL
 *  value — the user has deactivated the node from its details pane; it renders greyed, wins over the live
 *  status ("if it's not idle then it should be off"), and — being rank 0 — never propagates and never
 *  inherits a downstream error (see {@link rollUpHealth}). */
export type GHealth = "idle" | "healthy" | "warning" | "error" | "off";
/** Axis 2 — ACTIVITY (#2541): the bottom-right lifecycle word — what the project is doing right now.
 *  `idle` is the RESTING default (#2551): a triaged project with nothing running reads idle, NOT
 *  building — `building` means agents are ACTUALLY running (derived from live sessions, never a
 *  fallback). `planning` surfaces ONLY when the user has re-opened the planner on an already-triaged
 *  project (a re-edit state). `waiting` = an EXPECTED blocked state (an agent parked for the user,
 *  `bsc-wait`) — calm, not alarming; it lives here, not on the health axis. */
export type GActivity = "idle" | "planning" | "building" | "waiting" | "review" | "live";
/** A Glance edge's kind. The project-network contracts (`api`/`data`/`events`) plus the CROSS-GRAPH
 *  LIBRARY edges: `uses-kit` (a project consumes a `bsc ui` kit, #2571) and the generalized `requires`
 *  (#3119, epic #3114) — a project/page pulls in an ALGORITHM or a SOUND library node. Both library kinds
 *  ({@link isLibraryEdge}) route vertically into the fenced band; the project contracts flow left→right. */
export type GEdgeKind = "api" | "data" | "events" | "uses-kit" | "requires";
/** A Glance node's KIND (#2571 → generalized #3119). A PROJECT (the default), a UI-KIT node (`kit`, the
 *  `ui` library graph — kept as-is so existing fixtures + persisted ids are unaffected), or a generalized
 *  cross-graph `library` node (an algorithm / sound, carrying {@link GRawNode.library}). ABSENT ⇒
 *  `"project"`. A library node's id is namespaced (`kit:` / `algo:` / `sound:`, see {@link libraryNodeId})
 *  so it can never collide with a project key (a `[a-z0-9-]` slug — no colon). */
export type GNodeKind = "project" | "kit" | "library";

/** The cross-graph LIBRARY dimensions a band node can belong to (#3119) — reuses A's {@link NodeGraph}
 *  (algorithms · UI kits · sounds). A `kit` node is the `ui` case (kept for back-compat); a generalized
 *  `library` node names its graph via {@link GRawNode.library}. */
export type GLibraryGraph = NodeGraph; // "algo" | "ui" | "sound"

/** UI-KIT node/edge accent (#2571) — a distinct cyan that stands apart from the lifecycle-category
 *  palette (teal/indigo/bronze/slate/magenta/gold), the health dots, and the iteration-loop violet, so a
 *  kit node + its `uses-kit` edges read as a separate relationship dimension. */
export const KIT_COLOR = "#22d3ee";
/** Algorithm-library accent (#3119) — violet. */
export const ALGO_COLOR = "#a78bfa";
/** Sound-library accent (#3119) — pink. */
export const SOUND_COLOR = "#f472b6";

/** Per-library-graph presentation (#3119) — the accent colour, the node glyph + kind word, the band
 *  header, the inspector panel title, the consumer-edge label, and the inspector blurb. The `ui` row is
 *  EXACTLY the pre-#3119 kit treatment (cyan · ◆ · "kit" · "UI KITS" · "UI KIT" · "uses kit"), so a
 *  kit-only graph stays byte-identical. */
export const LIBRARY_META: Record<GLibraryGraph, {
  color: string; marker: string; kindLabel: string; bandLabel: string; panelTitle: string; edgeLabel: string; blurb: string;
}> = {
  ui: {
    color: KIT_COLOR, marker: "◆", kindLabel: "kit", bandLabel: "UI KITS", panelTitle: "UI KIT", edgeLabel: "uses kit",
    blurb: "A shared `bsc ui` kit. Every project below consumes it — a design-system dependency, so a breaking kit change fans out to them all.",
  },
  algo: {
    color: ALGO_COLOR, marker: "∑", kindLabel: "algorithm", bandLabel: "ALGORITHMS", panelTitle: "ALGORITHM", edgeLabel: "requires",
    blurb: "A shared algorithm from the algorithms graph. Every project above requires it — a cross-graph library dependency, so the reference implementation is reused, not re-coded.",
  },
  sound: {
    color: SOUND_COLOR, marker: "♪", kindLabel: "sound", bandLabel: "SOUNDS", panelTitle: "SOUND", edgeLabel: "requires",
    blurb: "A shared sound cue from the sounds graph. Every project above requires it — a cross-graph library dependency.",
  },
};

/** Namespace prefix for a KIT node id (#2571). */
export const KIT_NODE_PREFIX = "kit:";
/** graph → the namespace prefix for a library node id (#3119). `ui` stays `kit:` so {@link kitNodeId}
 *  and every persisted `kit:<id>` node id are unchanged; algo/sound get their own namespaces. */
export const LIBRARY_NODE_PREFIX: Record<GLibraryGraph, string> = { ui: KIT_NODE_PREFIX, algo: "algo:", sound: "sound:" };
/** The stable, collision-proof id of a library node in `graph` (#3119). `libraryNodeId("ui", x)` is
 *  exactly {@link kitNodeId}`(x)`. */
export const libraryNodeId = (graph: GLibraryGraph, libId: string): string => `${LIBRARY_NODE_PREFIX[graph]}${libId}`;
/** The stable, collision-proof id of the graph node for a `bsc ui` kit (#2571). */
export const kitNodeId = (kitId: string): string => `${KIT_NODE_PREFIX}${kitId}`;
/** The kit id behind a `kit:<kitId>` node id (identity for anything already bare). */
export const kitIdOfNode = (nodeId: string): string =>
  nodeId.startsWith(KIT_NODE_PREFIX) ? nodeId.slice(KIT_NODE_PREFIX.length) : nodeId;
/** The in-graph library id behind a library node id (#3119), stripping whichever graph prefix matches. */
export const libIdOfNode = (nodeId: string): string => {
  for (const p of Object.values(LIBRARY_NODE_PREFIX)) if (nodeId.startsWith(p)) return nodeId.slice(p.length);
  return nodeId;
};
/** Stable id for a project→kit `uses-kit` edge (#2571) — prefixed so it can never collide with a
 *  {@link projectLinkId} (`from>to:kind`). */
export const usesKitEdgeId = (projectKey: string, kitId: string): string => `usekit:${projectKey}>${kitId}`;
/** Stable id for a project→library `requires` edge (#3119) — prefixed so it never collides with a
 *  {@link projectLinkId} or a {@link usesKitEdgeId}. `toNodeId` is the target library node id. */
export const requiresEdgeId = (fromKey: string, toNodeId: string): string => `req:${fromKey}>${toNodeId}`;

/** Is `n` a cross-graph LIBRARY node (#3119) — a lifted band node, not a project? True for a legacy `kit`
 *  node (the `ui` graph) or a generalized `library` node (algo/sound/ui). */
export const isLibraryNode = (n: { kind?: GNodeKind }): boolean => n.kind === "kit" || n.kind === "library";
/** The library graph a node belongs to (#3119): `kit` ⇒ `"ui"` (back-compat), a `library` node ⇒ its
 *  `library` field (defaulting to `"ui"`), else undefined (a project). */
export const libraryGraphOf = (n: { kind?: GNodeKind; library?: GLibraryGraph }): GLibraryGraph | undefined =>
  n.kind === "kit" ? "ui" : n.kind === "library" ? (n.library ?? "ui") : undefined;
/** Is `kind` a cross-graph LIBRARY edge (#3119) — a `uses-kit` (ui) or generalized `requires` edge? These
 *  route VERTICALLY into the fenced band and are excluded from the project-network layout. */
export const isLibraryEdge = (kind: GEdgeKind): boolean => kind === "uses-kit" || kind === "requires";

/** One communication form on a fleet node's comms surface (#2563) — a typed interaction + its `bsc-*`
 *  runtime transport, pared from the Org model so the glance node model stays decoupled from it. */
export interface GNodeCommForm { label: string; transport?: string }
/** A fleet node's communication surface with ONE counterpart (#2563), derived from the fleet-as-Org
 *  projection: the archetype, the other agent, and the forms this node SENDS / RECEIVES across it. */
export interface GNodeComm { withName: string; archetypeLabel: string; hue: number; sends: GNodeCommForm[]; receives: GNodeCommForm[] }

/** The agent identity behind a fleet node (#2561) — the persona surfaced on the drill node + inspector,
 *  so the user sees WHO is at that terminal (name · role · model · skills · charter), not just a role. */
export interface GNodePersona {
  name: string;
  role: string;
  model?: string;
  skills: string[];
  responsibilities: string[];
  /** The agent's communication surface (#2563) — who it talks to and how, one entry per relationship,
   *  derived from the fleet-as-Org projection. Absent until computed (fleet drill only). */
  comms?: GNodeComm[];
}

/** Severity rank for the health rollup — only `warning`/`error` (rank ≥ 1) propagate up dependency
 *  edges; `idle` and `healthy` are both "no problem" (rank 0) and stay put. */
export const HEALTH_RANK: Record<GHealth, number> = { idle: 0, healthy: 0, warning: 1, error: 2, off: 0 };

/** A project node as supplied by the data adapter (before layout). */
export interface GRawNode {
  id: string;
  /** Display name (defaults to id). */
  slug?: string;
  role: GRole;
  /** Lifecycle category (#2583) — set for PROJECT (L0) nodes; drives the accent colour + chip in place
   *  of `role`. Absent for fleet-drill (L1) nodes, which keep their function-group `role` colouring. */
  category?: GCategory;
  /** Axis 1 — the node's OWN health (before the dependency rollup). #2541. */
  health: GHealth;
  /** Axis 2 — the lifecycle word shown bottom-right. #2541. */
  activity: GActivity;
  /** When health is `warning`/`error`, the short reason (the `Fault.title` that set it) shown in place
   *  of the activity word, so the user sees WHY the dot changed. #2541. */
  reason?: string;
  /** Optional director id (for the node badge / inspector). */
  director?: string;
  /** Display label for the role when the mapped `role` category isn't the real thing — e.g. a fleet
   *  agent's actual session role ("worker" / "reviewer" / "director"), from its persona. The `role`
   *  category still drives the colour; this is the text shown on the card + inspector. */
  roleLabel?: string;
  /** Unresolved runtime-fault count for the project (#2265), from `bsc errors` — surfaced in the
   *  inspector. The count's worst LEVEL drives `health` (#2541); absent/0 ⇒ healthy/idle. */
  faults?: number;
  /** The agent identity at this node (#2561) — set for fleet-drill (L1) nodes, absent for project (L0)
   *  nodes. The inspector renders it as the persona card. */
  persona?: GNodePersona;
  /** The PREVIEW node (#2623) — not an agent: the surface that renders the finished application in the
   *  graph when the project is complete. Clicking it morphs open the app preview (`GlancePreviewMorph`)
   *  the way an agent node morphs open its terminal. The canvas renders it distinctly (▷). */
  preview?: boolean;
  /** The node KIND (#2571 → generalized #3119) — `"kit"` for a UI-kit node, `"library"` for a generalized
   *  cross-graph library node (algorithm / sound), else a PROJECT node. ABSENT ⇒ `"project"` so existing
   *  nodes/tests are unaffected; the canvas + inspector render a library node distinctly (its graph glyph
   *  · kind word · consumer count). */
  kind?: GNodeKind;
  /** The library graph this node belongs to (#3119) — set on a generalized `library` node to say which
   *  cross-graph dimension it is (`algo`/`sound`/`ui`). A legacy `kit` node leaves this ABSENT (it is
   *  implicitly `ui`). Absent on a project. */
  library?: GLibraryGraph;
}
/** A dependency edge: `from` depends on `to`, over a contract of `kind`. Optional stable `id` (a
 *  user-drawn project link carries its own; sample/derived edges fall back to a positional id).
 *  `archetype` (#2561) is the Org relationship archetype id for a fleet-drill (L1) edge — Manages /
 *  Oversees / Peers / … — which drives the edge colour + the communication forms shown in the inspector;
 *  absent for project (L0) edges, which keep the `kind` vocabulary. */
export interface GRawEdge { from: string; to: string; kind: GEdgeKind; id?: string; archetype?: string }

export interface GNode extends GRawNode {
  slug: string; layer: number; x: number; y: number;
  /** Health after the up-the-chain rollup (#2541): the worst of this node's own `health` and every node
   *  it (transitively) depends on. This is what the top-left dot renders. */
  rollupHealth: GHealth;
  /** True when `rollupHealth` is worse than the node's OWN `health` — i.e. the node is only lit because
   *  of a downstream dependency. Renders as a MUTED dot (the origin keeps the full/pulsing treatment). */
  healthInherited: boolean;
}
export interface GEdge {
  id: string; from: string; to: string; kind: GEdgeKind;
  /** A hard dependency (api/data) blocks the consumer on a breaking change; events are soft. */
  hard: boolean;
  isCycle: boolean;
  /** Org relationship archetype id for a fleet-drill (L1) edge (#2561) — drives colour + the inspector's
   *  communication forms. Absent for project (L0) edges. */
  archetype?: string;
  /** SVG path + arrowhead in world coordinates. */
  d: string; arrow: string;
}

export interface GraphModel {
  nodes: GNode[];
  edges: GEdge[];
  /** Mutual-dependency pairs (a↔b) — the coordination hazards. */
  cyclePairs: [string, string][];
  cycleNodeIds: Set<string>;
  worldW: number;
  worldH: number;
  /** The fenced LIBRARY band across the top (#3007, generalized #3119) — the vertical zone [`y0`, `y1`]
   *  the lifted library nodes occupy (UI kits AND/OR algorithms/sounds), with `y1` the fence divider below
   *  them. ABSENT when the graph has no library nodes, so a project-only graph is unchanged. The canvas
   *  draws a tinted backdrop + divider + a header label (the graph's name for a single-dimension band —
   *  "UI KITS"/"ALGORITHMS"/"SOUNDS" — else "LIBRARIES"). The field name stays `kitBand` for persist/test
   *  stability. */
  kitBand?: { y0: number; y1: number };
}

/** Role → accent colour (drives the node left-border + role chip + legend). */
export const ROLE_COLOR: Record<GRole, string> = {
  infra: "var(--graph-kind-infra)", service: "var(--graph-kind-service)", data: "var(--graph-kind-data)", client: "var(--graph-kind-client)",
};
/** Lifecycle category → accent colour + label (#2583) — drives a PROJECT (L0) node's border + chip +
 *  legend. A palette DELIBERATELY distinct from the health colours (blue/green/orange/red) so the
 *  category channel and the health dot never blur. */
export const CATEGORY_META: Record<GCategory, { label: string; color: string }> = {
  greenfield: { label: "greenfield", color: "var(--graph-category-greenfield)" }, // teal — creating from a pitch
  transform:  { label: "transform",  color: "var(--graph-category-transform)" }, // indigo — restructuring existing repos
  harden:     { label: "harden",     color: "var(--graph-category-harden)" }, // bronze — improving/securing in place
  maintain:   { label: "maintain",   color: "var(--graph-category-maintain)" }, // slate — keeping it running
  data:       { label: "data",       color: "var(--graph-category-data)" }, // magenta — a data migration
  script:     { label: "script",     color: "var(--graph-category-script)" }, // gold — a single-purpose invocable function (#2596)
};
/** Axis 1 — HEALTH → the top-left dot colour + whether it pulses (#2541). Blue = at rest, green =
 *  active & fine, orange = warning, red = error/fatal (pulses; the node to look at). */
export const HEALTH_META: Record<GHealth, { label: string; color: string; pulse: boolean }> = {
  idle: { label: "idle", color: "var(--graph-health-idle)", pulse: false },
  healthy: { label: "healthy", color: "var(--graph-health-healthy)", pulse: false },
  warning: { label: "warning", color: "var(--graph-health-warning)", pulse: false },
  error: { label: "error", color: "var(--graph-health-error)", pulse: true },
  // #3239 — the user-deactivated node: a muted grey dot, never pulsing. The manual "turned off" state.
  off: { label: "off", color: "var(--graph-health-off)", pulse: false },
};
/** Axis 2 — ACTIVITY → the bottom-right lifecycle word (#2541). Colour is the health axis's job; this
 *  is just the label + whether it animates (a live app / building fleet reads as active). */
export const ACTIVITY_META: Record<GActivity, { label: string; pulse: boolean }> = {
  idle: { label: "idle", pulse: false },
  planning: { label: "planning", pulse: false },
  building: { label: "building", pulse: true },
  waiting: { label: "waiting", pulse: false },
  review: { label: "in review", pulse: false },
  live: { label: "live", pulse: true },
};
/** Project-network (L0) edge kind → label · colour · dash · line width · the relationship "surface"
 *  blurb (#2561 relabel). The relationships a user draws between PROJECTS — a build/runtime **dependency**,
 *  a **data flow** (one project consumes another's data — connectors/pipelines/migration), or an async
 *  **event stream** — NOT the microservice "API contract" framing this replaced. (The internal key `api`
 *  is kept for data/persist stability; only the user-facing label reads "depends on".) Fleet-drill (L1)
 *  edges speak the Org archetype grammar instead — see `glanceFleet`. */
export const EDGE_META: Record<GEdgeKind, { label: string; color: string; dash: string; w: number; surface: string }> = {
  api: { label: "depends on", color: "var(--graph-edge-api)", dash: "", w: 1.8, surface: "build & runtime dependency" },
  data: { label: "data flow", color: "var(--graph-edge-data)", dash: "", w: 1.8, surface: "consumes a data feed · schema-locked" },
  events: { label: "event stream", color: "var(--graph-edge-events)", dash: "6 5", w: 1.7, surface: "async messages · at-least-once" },
  // The kit-consumer dimension (#2571): a project CONSUMES a shared `bsc ui` kit — a design-system
  // dependency drawn to the shared kit node. Dashed cyan so it reads apart from the project edges.
  "uses-kit": { label: "uses kit", color: KIT_COLOR, dash: "4 4", w: 1.6, surface: "consumes a shared bsc ui kit · design-system dependency" },
  // The generalized cross-graph LIBRARY dimension (#3119, epic #3114): a project/page REQUIRES a node in
  // ANOTHER graph — an algorithm or a sound cue. Dashed like `uses-kit` so it reads as a library
  // dependency; the canvas tints each edge by the TARGET node's graph colour (LIBRARY_META), so this
  // static `color` is only a neutral fallback (e.g. the legend swatch).
  requires: { label: "requires", color: "var(--fg-muted)", dash: "4 4", w: 1.6, surface: "requires a shared library node (algorithm / sound) · cross-graph dependency" },
};

// Node box + spacing in world (design) coordinates.
export const NW = 186, NH = 66;
const COLGAP = 252, ROWGAP = 102;

// The fenced LIBRARY band across the top (#3007, generalized #3119). Library nodes (UI kits + algorithms +
// sounds) are LIFTED out of the project dependency DAG into a single row here, so they read as a separate
// library dimension instead of an intermixed project column (mirrors the Design Studio composition
// swimlanes). The band math is A's shared `layoutBand`; these tune its top pad + fence clearance.
const KIT_TOP_PAD = 40;   // y of the library cards' top edge inside the band
const KIT_BAND_GAP = 34;  // clearance from the library cards' bottom down to the fence divider

/** Bezier path + arrowhead between two node boxes (F depends on T). Cycle back-edges bow to separate the
 *  two directions. Ported from the spec's edgeGeom. `kind` picks the router (#3007, generalized #3119): a
 *  LIBRARY edge (`uses-kit`/`requires`) runs VERTICALLY (a project below → its library node in the top
 *  band), so it uses the DEFAULT perimeter-anchor router; every project edge keeps the layered side-port
 *  routing. */
export function edgeGeom(F: { x: number; y: number; id: string }, T: { x: number; y: number; id: string }, isCycle: boolean, kind?: GEdgeKind): { d: string; arrow: string } {
  // The shared graph line-type (#2222) with SIDE-PORT routing (#2226) — Glance's PROJECT network is a
  // layered left→right DAG, so edges leave the right edge / enter the left at the vertical middle for a
  // clean columnar flow (the perimeter-anchor router read messy here). Cycle back-edges bow apart
  // (deterministic sign by id order) so the two directions of a↔b don't overlap. A LIBRARY edge is
  // vertical (the band sits above the network), so side ports would meet the wrong faces — route it with
  // the perimeter-anchor DEFAULT (omit `routing: "ports"`) so each card faces the other.
  const bow = isCycle ? (F.id < T.id ? -46 : 46) : 0;
  const opts = kind && isLibraryEdge(kind) ? { bow } : { bow, routing: "ports" as const };
  const { d, arrow } = graphEdge({ x: F.x, y: F.y, w: NW, h: NH }, { x: T.x, y: T.y, w: NW, h: NH }, opts);
  return { d, arrow };
}

/** The nodes + edges to KEEP lit when something is focused (hovered/selected), so the rest dims. Null
 *  means "nothing focused — everything lit." A node lights itself + its neighbors + connecting edges;
 *  an edge lights its two endpoints; `showCycle` lights every cycle edge + its nodes. Pure. */
export function focusSets(
  model: GraphModel,
  activeNodeId: string | null,
  activeEdgeId: string | null,
  showCycle: boolean,
): { nodes: Set<string>; edges: Set<string> } | null {
  if (activeNodeId) {
    const sp = neighborSpotlight(model.edges, activeNodeId);
    return { nodes: sp.litNodes, edges: sp.litEdges };
  }
  if (activeEdgeId) {
    const e = model.edges.find((x) => x.id === activeEdgeId);
    return e ? { nodes: new Set([e.from, e.to]), edges: new Set([e.id]) } : null;
  }
  if (showCycle) {
    const nodes = new Set<string>(), edges = new Set<string>();
    for (const e of model.edges) if (e.isCycle) { edges.add(e.id); nodes.add(e.from); nodes.add(e.to); }
    return { nodes, edges };
  }
  return null;
}

/**
 * Roll HEALTH up the dependency chain (#2541): each node's effective health is the WORST of its own
 * health and every node it (transitively) depends on — so a foundational service's error surfaces on
 * everything downstream that depends on it. Only `warning`/`error` (rank ≥ 1) propagate; `idle`/`healthy`
 * never override the dependent's own resting state. Cycle-safe (a per-start visited set). Pure.
 *
 * Returns, per node id, the rolled-up `health` and whether it is `inherited` (worse than the node's own
 * health — i.e. lit only because of a dependency, so the dot renders muted, not as the origin).
 */
export function rollUpHealth(
  nodes: { id: string; health: GHealth }[],
  edges: { from: string; to: string }[],
): Map<string, { health: GHealth; inherited: boolean }> {
  const own = new Map(nodes.map((n) => [n.id, n.health]));
  const deps = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) deps.get(e.from)?.push(e.to); // `from depends on to`
  const worstFrom = (start: string): GHealth => {
    // A user-deactivated node stays `off` (#3239): the deliberate mute wins over any downstream error,
    // so an off node never lights up because of a dependency. (`off` is rank 0, so it also never
    // propagates OUT — a node depending on an off node is unaffected.)
    if (own.get(start) === "off") return "off";
    let worst = own.get(start) ?? "idle";
    const seen = new Set<string>([start]);
    const stack = [...(deps.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const h = own.get(id) ?? "idle";
      if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
      for (const d of deps.get(id) ?? []) stack.push(d);
    }
    return worst;
  };
  const out = new Map<string, { health: GHealth; inherited: boolean }>();
  for (const n of nodes) {
    const eff = worstFrom(n.id);
    out.set(n.id, { health: eff, inherited: HEALTH_RANK[eff] > HEALTH_RANK[own.get(n.id) ?? "idle"] });
  }
  return out;
}

/** Lay out the PROJECT network (kits excluded, #3007) with the layered left→right DAG engine — a plain
 *  GRID when there are no project dependency edges, else longest-path layering + barycenter ordering.
 *  Mutates each project node's `layer`/`x`/`y` in place. `byId` indexes ALL nodes; `cycleEdge` is the set
 *  of mutual-pair edge ids to exclude from layering. This is the pre-#3007 `buildGraph` body verbatim,
 *  scoped to `projNodes`/`projEdges` (so a project-only graph is byte-identical to before). */
function layoutProjectNetwork(projNodes: GNode[], projEdges: GEdge[], byId: Record<string, GNode>, cycleEdge: ReadonlySet<string>): void {
  // No dependency edges (real projects before a cross-project relationship model exists): a plain GRID so
  // the cards read as a network of peers instead of stacking in one column. Skip the layering.
  if (projEdges.length === 0) {
    const cols = Math.max(1, Math.round(Math.sqrt(projNodes.length)));
    projNodes.forEach((n, i) => { n.layer = 0; n.x = 70 + (i % cols) * COLGAP; n.y = 70 + Math.floor(i / cols) * ROWGAP; });
    return;
  }

  // Longest-path layering via the shared layerer (#2214). Glance is a DEPENDS-ON DAG (from depends on
  // to → the dependency `to` must sit at a LOWER layer), so we hand `layerDag` the edges REVERSED — its
  // "from → deeper" convention then puts each dependency below its dependent. Cycle (mutual-pair) edges
  // are excluded so the loop can't diverge.
  const reversed = projEdges.map((e) => ({ id: e.id, from: e.to, to: e.from }));
  const layer = layerDag(projNodes.map((n) => n.id), reversed, cycleEdge);
  projNodes.forEach((n) => (n.layer = layer[n.id]));

  // Crossing reduction via the shared barycenter orderer (#2418) with glance's tunables: every edge
  // endpoint pulls (both directions, cycle edges included), 6 snapshot sweeps.
  const nb = new Map<string, string[]>(projNodes.map((n) => [n.id, []]));
  projEdges.forEach((e) => { nb.get(e.from)!.push(e.to); nb.get(e.to)!.push(e.from); });
  const order = orderLayers(projNodes.map((n) => n.id), (id) => layer[id], (id) => nb.get(id)!, { passes: 6, sweep: "snapshot" });

  const maxCount = Math.max(1, ...[...order.values()].map((a) => a.length));
  const Cy = 70 + (maxCount - 1) * ROWGAP / 2;
  for (const [L, arr] of order) {
    arr.forEach((id, i) => {
      byId[id].x = 70 + L * COLGAP;
      byId[id].y = Cy + (i - (arr.length - 1) / 2) * ROWGAP;
    });
  }
}

/** Build the laid-out, cycle-aware graph model from raw nodes + edges. Deterministic. */
export function buildGraph(rawNodes: GRawNode[], rawEdges: GRawEdge[]): GraphModel {
  const nodes: GNode[] = rawNodes.map((n) => ({ ...n, slug: n.slug ?? n.id, layer: 0, x: 0, y: 0, rollupHealth: n.health, healthInherited: false }));
  const byId: Record<string, GNode> = {};
  nodes.forEach((n) => (byId[n.id] = n));

  const edges: GEdge[] = rawEdges
    .filter((e) => byId[e.from] && byId[e.to] && e.from !== e.to)
    .map((e, i) => ({ id: e.id ?? "e" + i, from: e.from, to: e.to, kind: e.kind, archetype: e.archetype, hard: e.kind !== "events", isCycle: false, d: "", arrow: "" }));

  // Cycle detection: mutual pairs (a→b AND b→a) — the shared graph-core primitive (#2217).
  const { pairs: cyclePairs, edgeIds: cycleEdge, nodeIds: cycleNodeIds } = mutualPairs(edges);
  edges.forEach((e) => { if (cycleEdge.has(e.id)) e.isCycle = true; });

  // Roll health up the dependency edges (#2541) — every node now carries its effective (rolled) health.
  // Library nodes (kits/algorithms/sounds) are always `idle` and never propagate, so the `uses-kit` /
  // `requires` edges have no effect here (#3007/#3119).
  const rolled = rollUpHealth(nodes, edges);
  nodes.forEach((n) => { const r = rolled.get(n.id)!; n.rollupHealth = r.health; n.healthInherited = r.inherited; });

  // #3007 (generalized #3119) — LIFT the cross-graph LIBRARY nodes (UI kits AND/OR algorithms/sounds) out
  // of the dependency DAG into their own fenced band across the top, so they read as a separate library
  // dimension, not an intermixed project column. The PROJECT network lays out with ONLY the project nodes
  // + project edges (the existing engine, unchanged); the library nodes then sit in a single row above it
  // and every project node shifts down to clear the band.
  const bandNodes = nodes.filter(isLibraryNode);
  const projNodes = nodes.filter((n) => !isLibraryNode(n));
  const projEdges = edges.filter((e) => !isLibraryEdge(e.kind));

  layoutProjectNetwork(projNodes, projEdges, byId, cycleEdge);

  let kitBand: { y0: number; y1: number } | undefined;
  if (bandNodes.length > 0) {
    // A single library row across the TOP, laid out by A's shared band helper (#3119) — evenly spaced and
    // centred over the project span [70, projMaxX], the step capped at one column gap so a couple of nodes
    // cluster in the middle instead of stretching the full width. `layer = -1` marks them as band nodes
    // (outside the project layering). This is behaviour-preserving for the kit-only case (#3007).
    const projMaxX = projNodes.length ? Math.max(...projNodes.map((n) => n.x)) : 70;
    const band = layoutBand(bandNodes.length, { spanX0: 70, spanX1: projMaxX, topPad: KIT_TOP_PAD, nodeH: NH, gap: KIT_BAND_GAP, maxStep: COLGAP });
    bandNodes.forEach((k, i) => { k.layer = -1; k.x = band.positions[i].x; k.y = band.positions[i].y; });

    // The fence sits a gap below the library cards' bottom; the project network shifts down by that much
    // so the layout's own 70px top pad becomes the clean gap between the divider and the first project row.
    kitBand = { y0: band.y0, y1: band.y1 };
    projNodes.forEach((n) => (n.y += band.dividerY));
  }

  let maxX = 0, maxY = 0;
  nodes.forEach((n) => { maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const worldW = maxX + NW + 80, worldH = maxY + NH + 90;

  // Edge geometry LAST — after both the project layout and the library-band shift — so every endpoint is
  // final. `e.kind` routes LIBRARY edges (`uses-kit`/`requires`) vertically (perimeter-anchor); project
  // edges keep side ports.
  edges.forEach((e) => Object.assign(e, edgeGeom(byId[e.from], byId[e.to], e.isCycle, e.kind)));

  return { nodes, edges, cyclePairs, cycleNodeIds, worldW, worldH, kitBand };
}
