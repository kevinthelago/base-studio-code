// RelationshipGraphView — the SWIMLANE visualization of the agent-relationship graph:
// one lane per stream (ordered by build phase), phase columns advancing left→right, the
// stream's "station" node at its phase, artifact tokens (diamonds) on the producer lane
// flowing to consumers, and typed/hardness-styled connectors. At rest only handoff/
// blocking read bold; hover or click a stream to spotlight just its relationships (the
// rest dim). Pure presentational — focus + hover are lifted to the caller. Ported from
// design/bsc · Agent Relationships - Swimlanes · lanes().

import {
  EDGE_KIND_META, ARTIFACT_COLOR, ROLE_COLOR, hardStyle, restOpacity, computeSpotlight,
  type RelationshipGraph, type RelFocus, type RelStream,
} from "./relationshipGraph";

const PAD = 16, LH = 58, TOP = 30, NH = 30;
const LABEL_X = 14;   // left inset of the label text
const LABEL_PAD = 14; // gap between the longest label and the divider / first node
const MIN_GUTTER = 96;
const ID_FONT = '600 11px "JetBrains Mono", ui-monospace, monospace';
const REPO_FONT = '400 7.5px "JetBrains Mono", ui-monospace, monospace';
// Station-node sizing — the rect is measured to fit its id so the text never overflows it.
const NODE_FONT = '600 10.5px "JetBrains Mono", ui-monospace, monospace';
const NODE_TEXT_X = 22;   // id text inset (after the role dot)
const NODE_PAD_R = 13;    // right padding inside the node rect
const MIN_NODE_W = 72;
const COL_GAP = 46;       // gap after a node before the next phase column (fits artifact tokens)
const MIN_COL = 124;

// Measure rendered text width. Uses a shared canvas (accurate for the real font); falls back
// to a monospace estimate when canvas isn't available (jsdom / SSR), which is exact enough for
// the mono font. Memoizes the 2d context so we probe getContext at most once.
let _ctx: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string): number {
  if (_ctx === undefined) {
    try { _ctx = document.createElement("canvas").getContext("2d"); }
    catch { _ctx = null; }
  }
  if (_ctx) { _ctx.font = font; return _ctx.measureText(text).width; }
  const px = parseFloat(font) || 11;
  return text.length * px * 0.6; // monospace advance ≈ 0.6em
}

/** Width the left gutter must be to fit the widest "id + ⎇ repo" label across all streams. */
function measureGutter(streams: RelStream[]): number {
  let w = 0;
  for (const s of streams) {
    const idW = measureText(s.id, ID_FONT);
    const repoW = s.repo ? measureText(`⎇ ${s.repo}`, REPO_FONT) : 0;
    w = Math.max(w, idW, repoW);
  }
  return Math.max(MIN_GUTTER, Math.ceil(LABEL_X + w + LABEL_PAD));
}

/** Width the station-node rect must be to fit the widest stream id (role dot + id + padding). */
function measureNodeWidth(streams: RelStream[]): number {
  let w = 0;
  for (const s of streams) w = Math.max(w, measureText(s.id, NODE_FONT));
  return Math.max(MIN_NODE_W, Math.ceil(NODE_TEXT_X + w + NODE_PAD_R));
}

function Arrow({ x, y, ang, c, op }: { x: number; y: number; ang: number; c: string; op: number }) {
  const s = 5.2;
  const p = (a: number) => `${(x + s * Math.cos(ang + a)).toFixed(1)},${(y + s * Math.sin(ang + a)).toFixed(1)}`;
  return <polygon points={`${x.toFixed(1)},${y.toFixed(1)} ${p(Math.PI - 0.42)} ${p(Math.PI + 0.42)}`} fill={c} opacity={op} />;
}

export function RelationshipGraphView({ graph, focus, hover, onFocusAgent, onInspectEdge, onInspectArtifact, onHover }: {
  graph: RelationshipGraph;
  /** Pinned focus (a click). */
  focus: RelFocus;
  /** Transient hover (takes precedence over the pin for the spotlight). */
  hover: string | null;
  onFocusAgent: (id: string) => void;
  onInspectEdge: (id: string) => void;
  onInspectArtifact: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const { streams, artifacts, edges, sids, layerOf, cycleEdgeIds } = graph;
  // Size the left label gutter to the widest measured "id + ⎇ repo" so the phase track (and
  // the station-node rects) always start clear of the labels — nothing overlaps the text.
  const LW = measureGutter(streams);
  // Size the node rect to the widest id, and space the phase columns to fit a node + its
  // artifact token, so the text never overflows its rect nor the next column.
  const NW = measureNodeWidth(streams);
  const COL = Math.max(MIN_COL, NW + COL_GAP);
  const order = [...streams].sort((a, b) => (layerOf[a.id] - layerOf[b.id]) || a.id.localeCompare(b.id));
  // Lane vertical center = the band's center (the band is LH-8 tall starting at TOP+i*LH), so
  // the station-node rect, its edges, and the labels all align to the middle of the row.
  const laneY: Record<string, number> = {};
  order.forEach((s, i) => { laneY[s.id] = TOP + i * LH + (LH - 8) / 2; });
  const maxL = Math.max(0, ...sids.map((id) => layerOf[id] ?? 0));
  const nodeX = (id: string) => LW + PAD + (layerOf[id] ?? 0) * COL;
  const colX = (l: number) => LW + PAD + l * COL;
  const W = LW + PAD + maxL * COL + NW + 110;
  const H = TOP + order.length * LH + 12;

  const sp = computeSpotlight(graph, hover ? { type: "agent", id: hover } : focus);
  const laneOp = (id: string) => (sp.active ? (sp.brightStreams.has(id) ? 1 : 0.16) : 1);
  const edgeOp = (e: typeof edges[number]) => (sp.active ? (sp.litEdges.has(e.id) ? 1 : 0.05) : restOpacity(e.kind));

  const els: React.ReactNode[] = [];

  // phase column guides
  for (let l = 0; l <= maxL; l++) {
    const x = colX(l);
    els.push(<text key={`pl${l}`} x={x + NW / 2} y={16} textAnchor="middle" fontFamily="var(--mono)" fontSize={8} fill="var(--fg-dim)">phase {l}</text>);
    els.push(<line key={`pg${l}`} x1={x + NW / 2} y1={22} x2={x + NW / 2} y2={H - 6} stroke="var(--border-soft)" strokeWidth={1} strokeDasharray="2 5" opacity={0.5} />);
  }
  // divider between the stream-label gutter and the phase track
  els.push(<line key="gutter-div" x1={LW + 4} y1={TOP - 4} x2={LW + 4} y2={H - 6} stroke="var(--border-soft)" strokeWidth={1} opacity={0.7} />);

  // lane bands + labels (hover/click targets)
  order.forEach((s, i) => {
    const y = TOP + i * LH;
    const rc = ROLE_COLOR[s.role ?? ""] ?? "var(--fg-dim)";
    const isFocus = sp.active && sp.focusType === "agent" && sp.focusId === s.id;
    els.push(
      <g key={`lane${s.id}`} onMouseEnter={() => onHover(s.id)} onMouseLeave={() => onHover(null)} onClick={() => onFocusAgent(s.id)} style={{ cursor: "pointer" }} opacity={laneOp(s.id)}>
        <rect x={2} y={y} width={W - 4} height={LH - 8} rx={7} fill={i % 2 ? "color-mix(in oklch, var(--bg-canvas), transparent 25%)" : "var(--bg-canvas)"} stroke={isFocus ? rc : "var(--border-soft)"} strokeWidth={isFocus ? 1.4 : 1} />
        <rect x={2} y={y} width={3.5} height={LH - 8} rx={2} fill={rc} />
        <text x={LABEL_X} y={y + (LH - 8) / 2 - 2} fontFamily="var(--mono)" fontSize={11} fontWeight={600} fill="var(--fg)">{s.id}</text>
        {s.repo && <text x={LABEL_X} y={y + (LH - 8) / 2 + 11} fontFamily="var(--mono)" fontSize={7.5} fill="var(--fg-dim)">⎇ {s.repo}</text>}
      </g>,
    );
  });

  // non-handoff edges (lane-to-lane connectors)
  for (const e of edges) {
    if (e.kind === "handoff" && e.artifact) continue;
    const fy = laneY[e.from], ty = laneY[e.to];
    if (fy == null || ty == null) continue;
    const fx = nodeX(e.from) + NW, tx = nodeX(e.to);
    const km = EDGE_KIND_META[e.kind], hs = hardStyle(e.hardness), cyc = cycleEdgeIds.has(e.id), on = sp.active && sp.litEdges.has(e.id);
    const stroke = cyc ? "var(--danger)" : km.color;
    const w = (cyc ? 2.4 : hs.w) + (on ? 0.8 : 0);
    const op = cyc ? Math.max(edgeOp(e), 0.85) : edgeOp(e);
    const sx = tx >= fx ? fx : nodeX(e.from), ex2 = tx >= fx ? tx : nodeX(e.to) + NW, dir = tx >= fx ? 1 : -1;
    els.push(<path key={`le${e.id}`} d={`M${sx},${fy} C${sx + 40 * dir},${fy} ${ex2 - 40 * dir},${ty} ${ex2},${ty}`} stroke={stroke} strokeWidth={w} strokeDasharray={cyc ? "" : hs.dash} fill="none" opacity={op} onClick={() => onInspectEdge(e.id)} style={{ cursor: "pointer" }} />);
    els.push(<Arrow key={`laa${e.id}`} x={ex2} y={ty} ang={dir > 0 ? 0 : Math.PI} c={stroke} op={op} />);
  }

  // handoffs via artifact tokens
  for (const a of artifacts) {
    const py = laneY[a.producer]; if (py == null) continue;
    const px = nodeX(a.producer) + NW + 26;
    const ac = ARTIFACT_COLOR[a.kind] ?? "var(--accent)", rdy = a.status === "ready";
    const on = sp.active && sp.litArtifacts.has(a.id);
    const aop = sp.active ? (on ? 1 : 0.07) : 0.95;
    els.push(<line key={`pt${a.id}`} x1={nodeX(a.producer) + NW} y1={py} x2={px - 10} y2={py} stroke="var(--accent)" strokeWidth={2} opacity={aop} />);
    a.consumers.forEach((c, ci) => {
      const cy2 = laneY[c]; if (cy2 == null) return;
      const cxn = nodeX(c);
      const eid = edges.find((e) => e.from === a.producer && e.to === c && e.kind === "handoff")?.id;
      els.push(<path key={`ht${a.id}${ci}`} d={`M${px},${py} C${px + 26},${py} ${cxn - 28},${cy2} ${cxn},${cy2}`} stroke="var(--accent)" strokeWidth={on ? 2.8 : 2} fill="none" opacity={aop} onClick={eid ? () => onInspectEdge(eid) : undefined} style={eid ? { cursor: "pointer" } : undefined} />);
      els.push(<Arrow key={`hta${a.id}${ci}`} x={cxn} y={cy2} ang={0} c="var(--accent)" op={aop} />);
    });
    const r = on ? 9.5 : 8;
    els.push(<polygon key={`ldia${a.id}`} points={`${px},${py - r} ${px + r},${py} ${px},${py + r} ${px - r},${py}`} fill={rdy ? "color-mix(in oklch, var(--success), transparent 50%)" : "var(--bg-elev)"} stroke={on ? "var(--accent)" : ac} strokeWidth={on ? 2 : 1.6} opacity={aop} onClick={() => onInspectArtifact(a.id)} style={{ cursor: "pointer" }} />);
    els.push(<text key={`ldt${a.id}`} x={px} y={py - 12} textAnchor="middle" fontFamily="var(--mono)" fontSize={8} fill={on ? "var(--accent)" : "var(--fg-muted)"} opacity={sp.active ? (on ? 1 : 0.2) : 0.95} style={{ pointerEvents: "none" }}>{a.name}</text>);
  }

  // lane "station" nodes
  for (const s of order) {
    const rc = ROLE_COLOR[s.role ?? ""] ?? "var(--fg-dim)", x = nodeX(s.id), y = laneY[s.id] - NH / 2;
    const isFocus = sp.active && sp.focusType === "agent" && sp.focusId === s.id;
    els.push(
      <g key={`node${s.id}`} onMouseEnter={() => onHover(s.id)} onMouseLeave={() => onHover(null)} onClick={() => onFocusAgent(s.id)} style={{ cursor: "pointer" }} opacity={laneOp(s.id)}>
        <rect x={x} y={y} width={NW} height={NH} rx={6} fill={isFocus ? "color-mix(in oklch, var(--accent), transparent 82%)" : "var(--bg-elev)"} stroke={isFocus ? "var(--accent)" : "var(--border)"} strokeWidth={isFocus ? 1.8 : 1} />
        <circle cx={x + 12} cy={y + NH / 2} r={4} fill={rc} />
        <text x={x + 22} y={y + NH / 2 + 3.4} fontFamily="var(--mono)" fontSize={10.5} fontWeight={600} fill="var(--fg)">{s.id}</text>
      </g>,
    );
  }

  return (
    // eslint-disable-next-line no-restricted-syntax -- scroll container wrapping the measured SVG graph
    <div style={{ overflow: "auto", maxHeight: 440, border: "1px solid var(--border-soft)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <svg width={Math.max(W, 640)} height={H} style={{ display: "block" }} data-testid="relationship-graph-svg" onMouseLeave={() => onHover(null)}>
        {els}
      </svg>
    </div>
  );
}
