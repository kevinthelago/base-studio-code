// The Sounds composition graph (#3077, Phase 2) — turns a SoundKit into a node/edge graph laid out in
// tier COLUMNS, the same shape as the Algorithms kit graph (`layoutKitGraph`) and the Designs graph:
// Primitives at the base (left), Voices next, Cues last (right), wired by `composes` edges
// (Cue→Voice→Primitive). Pure + deterministic — the canvas/rail/inspector all read this.
import type { Cue, SoundCategory, SoundKit } from "./soundDescriptor";

export type SoundNodeKind = "primitive" | "voice" | "cue";

/** A graph node. `id` is namespaced by kind (`p:`/`v:`/`c:`) so a primitive + cue sharing a raw id never
 *  collide; `refId` is the original id for kit lookups + playback. */
export interface SoundNode {
  id: string;
  kind: SoundNodeKind;
  label: string;
  refId: string;
  /** Cues only — drives the node tint + rail grouping. */
  category?: SoundCategory;
}

/** A `composes` edge, from the composer to the composed (Cue→Voice, Voice→Primitive). */
export interface SoundEdge { id: string; from: string; to: string }

export interface SoundGraph { nodes: SoundNode[]; edges: SoundEdge[] }

export interface NodePos { x: number; y: number }
export interface SoundLayout {
  pos: Map<string, NodePos>;
  world: { w: number; h: number };
  bounds: { x: number; y: number; w: number; h: number };
}

/** Node box size (world px) — shared by the layout and the canvas card (matches the Algorithms graph). */
export const NODE_W = 172;
export const NODE_H = 58;
const COL_PITCH = NODE_W + 208;
const ROW_PITCH = NODE_H + 22;
const PAD = 48;

/** Namespaced node ids — kept in one place so build + edge wiring agree. */
export const primNodeId = (id: string) => `p:${id}`;
export const voiceNodeId = (id: string) => `v:${id}`;
export const cueNodeId = (id: string) => `c:${id}`;

/** Column tier: primitives are the base (0), voices 1, cues 2 — so the graph flows base→product, L→R. */
export function nodeTier(kind: SoundNodeKind): number {
  return kind === "primitive" ? 0 : kind === "voice" ? 1 : 2;
}

/** Build the composition graph for a kit — every primitive/voice/cue a node, every `composes` an edge. */
export function buildSoundGraph(kit: SoundKit): SoundGraph {
  const nodes: SoundNode[] = [
    ...kit.primitives.map((p): SoundNode => ({ id: primNodeId(p.id), kind: "primitive", label: p.name, refId: p.id })),
    ...kit.voices.map((v): SoundNode => ({ id: voiceNodeId(v.id), kind: "voice", label: v.name, refId: v.id })),
    ...kit.cues.map((c): SoundNode => ({ id: cueNodeId(c.id), kind: "cue", label: c.name, refId: c.id, category: c.category })),
  ];
  const edges: SoundEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const id = `${from}~${to}`;
    if (seen.has(id)) return; // a cue layering the same voice twice draws one edge
    seen.add(id);
    edges.push({ id, from, to });
  };
  for (const v of kit.voices) add(voiceNodeId(v.id), primNodeId(v.primitive));
  for (const c of kit.cues) for (const l of c.layers) add(cueNodeId(c.id), voiceNodeId(l.voice));
  return { nodes, edges };
}

/** Lay the graph out in tier columns (primitives→voices→cues, L→R), stacked in seed order within a
 *  column. Keyed by node id so the shared canvas/viewport draw it. Pure + deterministic. */
export function layoutSoundGraph(graph: SoundGraph): SoundLayout {
  const pos = new Map<string, NodePos>();
  const rowByCol = [0, 0, 0];
  for (const n of graph.nodes) {
    const col = nodeTier(n.kind);
    const row = rowByCol[col]++;
    pos.set(n.id, { x: PAD + col * COL_PITCH, y: PAD + row * ROW_PITCH });
  }
  const maxRows = Math.max(0, ...rowByCol);
  const world = {
    w: PAD * 2 + 2 * COL_PITCH + NODE_W,
    h: PAD * 2 + Math.max(maxRows - 1, 0) * ROW_PITCH + NODE_H,
  };
  const bounds = { x: PAD, y: PAD, w: world.w - PAD * 2, h: world.h - PAD * 2 };
  return { pos, world, bounds };
}

/**
 * The cue to PLAY for a node: a cue node plays its cue; a voice node plays an ephemeral single-layer cue
 * (hear the patch in isolation); a primitive has no envelope/pitch of its own, so it's not playable alone
 * (null). The ephemeral cue references only kit voices, so `compileCue` resolves it.
 */
export function playableCueForNode(node: SoundNode, kit: SoundKit): Cue | null {
  if (node.kind === "cue") return kit.cues.find((c) => c.id === node.refId) ?? null;
  if (node.kind === "voice") {
    const v = kit.voices.find((x) => x.id === node.refId);
    if (!v) return null;
    return { id: `_voice_${v.id}`, name: v.name, category: "ui", layers: [{ voice: v.id, at: 0 }] };
  }
  return null;
}
