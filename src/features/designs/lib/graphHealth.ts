// Design-graph health — the pure TS mirror of the `bsc ui doctor` analyzer (Rust `bsc-component`
// crate, #2678/#2679), used to badge dead/duplicated nodes in the Designs composition graph (#2680,
// epic #2677). Same taxonomy, same rules; operates on ONE kit's components (the Design Studio already
// scopes `kitComps` to the active kit, and `composes` edges only resolve within a kit).
//
// Findings, most-severe first: cycle (a `composes` loop) · dangling-branch (an unused root that still
// pulls in dependencies) · duplicate (same `wraps` intrinsic, or identical source) · no-implementation
// (a component the preview can't build — a spec, not code) · orphan (isolated, never-referenced
// primitive/composite). "Unused" = no composer AND used === 0; a page/layout with used > 0 is a legit
// entry point, never flagged.
//
// The no-implementation check reuses the EXACT preview logic (`componentPreviewFiles`, #2824/#2828):
// the store strips a built-in's artifact `source` (#2794), so a built-in still builds from the packaged
// artifact — only a node in NEITHER the artifact NOR carrying its own module/`source` is flagged.
import reactUiArtifact from "@data/components/react-ui.json";
import { buildComposesEdges } from "./compositionLayout";
import { componentPreviewFiles, type KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

// The packaged kit artifact (each built-in's verbatim `source` + the `runtime` @/ closure) — the SAME
// raw import ComponentPreviewFrame builds against. A built-in's `src` resolves here, so it's buildable
// even though the store strips its `source` (#2794).
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

export type HealthCategory = "cycle" | "dangling-branch" | "duplicate" | "no-implementation" | "orphan";

/** Category → severity (higher = worse); drives ranking + which badge wins on a multi-flagged node. */
export const HEALTH_SEVERITY: Record<HealthCategory, number> = {
  cycle: 4,
  "dangling-branch": 3,
  duplicate: 3,
  "no-implementation": 3,
  orphan: 2,
};

export interface HealthFinding {
  category: HealthCategory;
  severity: number;
  nodeIds: string[];
  nodeNames: string[];
  why: string;
}

/** The nodes reachable from `start` along `out` (DFS, cycle-safe). Excludes `start`. */
function reachable(start: string, out: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const d of out.get(id) ?? []) if (!seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(start);
  seen.delete(start);
  return seen;
}

/** Node ids that sit on a `composes` cycle (any node whose DFS reaches itself). */
function cycleNodes(ids: string[], out: Map<string, string[]>): Set<string> {
  const onCycle = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=on-stack 2=done
  const stack: string[] = [];
  const dfs = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of out.get(id) ?? []) {
      const c = color.get(d) ?? 0;
      if (c === 1) {
        // back edge → everything from d up the stack is on a cycle.
        for (let i = stack.length - 1; i >= 0; i--) { onCycle.add(stack[i]); if (stack[i] === d) break; }
      } else if (c === 0) dfs(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of ids) if ((color.get(id) ?? 0) === 0) dfs(id);
  return onCycle;
}

/**
 * Analyze one kit's components for graph-health findings, ranked most-severe first. Pure — mirrors
 * `graph_health::analyze`. Same input always yields the same order (stable name tiebreak).
 */
export function analyzeGraphHealth(comps: ComponentRecord[]): HealthFinding[] {
  const nameById = new Map(comps.map((c) => [c.id, c.name]));
  const edges = buildComposesEdges(comps);

  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>(comps.map((c) => [c.id, 0]));
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const nameOf = (id: string) => nameById.get(id) ?? id;

  const findings: HealthFinding[] = [];

  // cycles
  const onCycle = cycleNodes(comps.map((c) => c.id), out);
  if (onCycle.size) {
    const ids = [...onCycle];
    const names = ids.map(nameOf);
    findings.push({ category: "cycle", severity: 4, nodeIds: ids, nodeNames: names,
      why: `these components form a composes cycle: ${names.join(" → ")}` });
  }

  // dead roots → orphan or dangling-branch
  for (const c of comps) {
    if ((inDeg.get(c.id) ?? 0) !== 0 || c.used !== 0) continue;
    const outN = (out.get(c.id) ?? []).length;
    if (outN === 0) {
      if (c.role === "primitive" || c.role === "composite") {
        findings.push({ category: "orphan", severity: 2, nodeIds: [c.id], nodeNames: [c.name],
          why: `${c.name} is isolated (nothing composes it) and unused (used = 0)` });
      }
    } else {
      const reach = reachable(c.id, out);
      findings.push({ category: "dangling-branch", severity: 3,
        nodeIds: [c.id, ...reach], nodeNames: [c.name, ...[...reach].map(nameOf)],
        why: `${c.name} is an unused root that pulls in ${reach.size} dependenc${reach.size === 1 ? "y" : "ies"}` });
    }
  }

  // duplicates — same wraps, or identical source
  const group = <K>(key: (c: ComponentRecord) => K | undefined) => {
    const m = new Map<K, ComponentRecord[]>();
    for (const c of comps) { const k = key(c); if (k !== undefined) (m.get(k) ?? m.set(k, []).get(k)!).push(c); }
    return [...m.values()].filter((g) => g.length >= 2);
  };
  for (const g of group((c) => c.wraps)) {
    const names = g.map((c) => c.name);
    findings.push({ category: "duplicate", severity: 3, nodeIds: g.map((c) => c.id), nodeNames: names,
      why: `${g.length} components all wrap the raw <${g[0].wraps}>: ${names.join(", ")}` });
  }
  for (const g of group((c) => (c.srcText.trim() ? c.srcText : undefined))) {
    const names = g.map((c) => c.name);
    findings.push({ category: "duplicate", severity: 3, nodeIds: g.map((c) => c.id), nodeNames: names,
      why: `${g.length} components have identical source: ${names.join(", ")}` });
  }

  // no-implementation — a component the Design Studio preview can't build (`componentPreviewFiles` →
  // null): it's a spec, not code. Reuses the EXACT preview logic so the badge and the live preview
  // agree. A built-in resolves via the artifact roster (its source lives there even though the store
  // strips it, #2794); only a node in neither the artifact nor carrying its own module/`source` is
  // flagged (a user-authored spec, e.g. a `page` like GraphExplorerPage). Independent of used/role.
  for (const c of comps) {
    if (componentPreviewFiles(c, ARTIFACT) === null) {
      findings.push({ category: "no-implementation", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} has no buildable implementation — the preview can't render it (a spec, not code)` });
    }
  }

  return findings.sort((a, b) => b.severity - a.severity || (a.nodeNames[0] ?? "").localeCompare(b.nodeNames[0] ?? ""));
}

/** Node id → its MOST-SEVERE health category — what the graph badges each node with (#2680). */
export function nodeHealth(comps: ComponentRecord[]): Map<string, HealthCategory> {
  const map = new Map<string, HealthCategory>();
  for (const f of analyzeGraphHealth(comps)) {
    for (const id of f.nodeIds) {
      const cur = map.get(id);
      if (!cur || HEALTH_SEVERITY[f.category] > HEALTH_SEVERITY[cur]) map.set(id, f.category);
    }
  }
  return map;
}
