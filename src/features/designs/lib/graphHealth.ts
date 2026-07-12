// Design-graph health — the pure TS mirror of the `bsc ui doctor` analyzer (Rust `bsc-component`
// crate, #2678/#2679), used to badge dead/duplicated nodes in the Designs composition graph (#2680,
// epic #2677). Same taxonomy, same rules; operates on ONE kit's components (the Design Studio already
// scopes `kitComps` to the active kit, and `composes` edges only resolve within a kit).
//
// Findings, most-severe first: cycle (a `composes` loop) · dangling-branch (an unused root that still
// pulls in dependencies) · duplicate (same `wraps` intrinsic, or identical source) · no-implementation
// (a component the preview can't build — a spec, not code) · unresolvable-import (a user module imports a
// bare package the preview can't resolve — throws at preview time, #2934) · orphan (isolated, never-
// referenced primitive/composite) · unwired-prop (declares props its own source never references — a
// declared interface that does nothing, #2924) · slot-shell (INFORMATIONAL — a composite whose composed
// children arrive via ReactNode content slots, so a standalone preview renders a demo placeholder, #2921).
// "Unused" = no composer AND used === 0; a page/layout with used > 0 is a legit entry point, never flagged.
//
// The no-implementation check reuses the EXACT preview logic (`componentPreviewFiles`, #2824/#2828):
// the store strips a built-in's artifact `source` (#2794), so a built-in still builds from the packaged
// artifact — only a node in NEITHER the artifact NOR carrying its own module/`source` is flagged.
import reactUiArtifact from "@data/components/react-ui.json";
import previewImportmap from "@data/ui/preview-importmap.json";
import { buildComposesEdges } from "./compositionLayout";
import { componentPreviewFiles, looksBuildableModule, type KitArtifact } from "./componentPreview";
import type { ComponentRecord, PropSpec } from "./model";

/** The specifiers the preview iframe can resolve — the exact keys of the preview import-map (react/three/
 *  d3/lucide-react/…). A bare import not in this set throws "Failed to resolve module specifier" at
 *  preview time (#2934). Kept in lockstep with the Rust twin (which embeds the SAME json). */
const RESOLVABLE_SPECIFIERS = new Set(Object.keys(previewImportmap));

/** Is `p` a CONTENT-SLOT prop — a non-`children` prop typed as a React node? Matches how the preview
 *  samples props (`samplePropValue` treats any `reactnode`/`node`-typed prop as a slot), so a component
 *  with one renders a placeholder standalone. `children` is universal and excluded (#2921). */
function isNodeSlotProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return p.name !== "children" && (t.includes("reactnode") || t.includes("node"));
}

/** The component's OWN module source (a user-authored module) — its record `source`, else a `srcText`
 *  that {@link looksBuildableModule} — or `null` when the source isn't in the record: a built-in (its
 *  artifact `source` is stripped from the store, #2794) or a spec (no buildable module). Only these have
 *  a source we can scan for prop references. Mirrors `componentPreviewFiles`'s user-authored source pick. */
function ownModuleSource(c: ComponentRecord): string | null {
  if (c.source && c.source.trim()) return c.source;
  if (looksBuildableModule(c.srcText)) return c.srcText;
  return null;
}

/** Does `source` reference `name` as a whole identifier (not a substring of a longer name)? The TS twin of
 *  the Rust `contains_word` — word chars are `[A-Za-z0-9_]`, kept in lockstep (#2924). */
function referencesIdentifier(source: string, name: string): boolean {
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  let from = 0;
  for (;;) {
    const at = source.indexOf(name, from);
    if (at < 0) return false;
    const beforeOk = at === 0 || !isWord(source[at - 1]);
    const afterIdx = at + name.length;
    const afterOk = afterIdx >= source.length || !isWord(source[afterIdx]);
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

/** Every module specifier imported/exported-from in `source` (`import … from "X"`, `export … from "X"`,
 *  `import "X"`, `import("X")`), deduped. A loose regex scan — over-inclusion is harmless (the caller only
 *  flags BARE unresolved ones). The Rust twin (`import_specifiers`) is a hand scanner but the same intent. */
function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  const fromRe = /\bfrom\s*["']([^"']+)["']/g; // import … from "x"; export … from "x"
  const importRe = /\bimport\s*\(?\s*["']([^"']+)["']/g; // import "x"; import("x")
  while ((m = fromRe.exec(source))) specs.add(m[1]);
  while ((m = importRe.exec(source))) specs.add(m[1]);
  return [...specs];
}

/** Is `spec` a BARE package specifier — not a relative (`.`/`..`), absolute (`/`), or first-party
 *  (`@/`) import? Only bare specifiers resolve through the preview import-map. */
function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@/");
}

// The packaged kit artifact (each built-in's verbatim `source` + the `runtime` @/ closure) — the SAME
// raw import ComponentPreviewFrame builds against. A built-in's `src` resolves here, so it's buildable
// even though the store strips its `source` (#2794).
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

export type HealthCategory =
  | "cycle" | "dangling-branch" | "duplicate" | "no-implementation" | "unresolvable-import"
  | "orphan" | "unwired-prop" | "slot-shell";

/** Category → severity (higher = worse); drives ranking + which badge wins on a multi-flagged node.
 *  `unresolvable-import` (3) is a real defect — the component throws at preview time (a bare import the
 *  preview can't resolve). `unwired-prop` (2) is a real but mild signal — a declared interface a
 *  component never implements. `slot-shell` is INFORMATIONAL (1, below every defect) — it never overrides
 *  a real defect badge, it just explains why a composite previews as a demo placeholder (#2921). */
export const HEALTH_SEVERITY: Record<HealthCategory, number> = {
  cycle: 4,
  "dangling-branch": 3,
  duplicate: 3,
  "no-implementation": 3,
  "unresolvable-import": 3,
  orphan: 2,
  "unwired-prop": 2,
  "slot-shell": 1,
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

  // unresolvable-import — a user-authored component whose OWN module imports a bare package the preview
  // CAN'T resolve: not in the preview import-map, so the iframe throws "Failed to resolve module
  // specifier" at preview time (#2934). This is the class `bsc ui doctor` was blind to — the graph looked
  // clean while the component was broken. Only own-source (user) components — a `looksBuildableModule`
  // srcText imports ONLY bare libraries (no `@/` closure), so its bare imports ARE exactly what the
  // preview must resolve. Built-ins resolve via the artifact + the map, so they're not scanned here.
  for (const c of comps) {
    const src = ownModuleSource(c);
    if (!src) continue;
    const unresolved = importSpecifiers(src).filter((s) => isBareSpecifier(s) && !RESOLVABLE_SPECIFIERS.has(s));
    if (unresolved.length === 0) continue;
    findings.push({ category: "unresolvable-import", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} imports ${unresolved.map((s) => `\`${s}\``).join(", ")} — not resolvable in the preview (no import-map entry), so it throws "Failed to resolve module specifier" when previewed` });
  }

  // unwired-prop — a component that declares props its own source never references (a declared interface
  // that does nothing, #2924). Only for a node with its OWN module source (user-authored); a built-in
  // (source in the artifact) or a spec (no buildable module) is skipped. Guard: require ≥1 prop REFERENCED
  // (so it clearly uses NAMED props — not a `{...props}` spreader) before flagging the unreferenced ones.
  for (const c of comps) {
    const src = ownModuleSource(c);
    if (!src || c.props.length === 0) continue;
    const used = new Map(c.props.map((p) => [p.name, referencesIdentifier(src, p.name)]));
    if (![...used.values()].some(Boolean)) continue; // no named-prop usage confirmed → conservative skip
    const unwired = c.props.map((p) => p.name).filter((n) => !used.get(n));
    if (unwired.length === 0) continue;
    findings.push({ category: "unwired-prop", severity: 2, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} declares prop${unwired.length === 1 ? "" : "s"} its source never uses: ${unwired.join(", ")} — a declared interface that does nothing` });
  }

  // slot-shell (informational) — a composite whose composed children arrive via ReactNode CONTENT SLOTS.
  // Standalone (no slots passed) it renders a demo/placeholder fallback, not its assembled function, so a
  // preview looks non-functional even though it isn't (#2921). Explains e.g. GraphExplorerPage /
  // AnalyticsPage. Detect: it `composes` ≥1 child AND exposes ≥1 non-`children` ReactNode slot prop.
  for (const c of comps) {
    if (c.composes.length === 0) continue;
    const slots = c.props.filter((p) => isNodeSlotProp(p)).map((p) => p.name);
    if (slots.length === 0) continue;
    findings.push({ category: "slot-shell", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} is a slot-driven composite — its composed children (${c.composes.join(", ")}) arrive via content slots (${slots.join(", ")}), so a standalone preview renders a demo placeholder, not its assembled function; fill the slots to see it` });
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
