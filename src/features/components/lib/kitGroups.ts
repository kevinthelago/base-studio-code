// Hierarchical kit navigation (#2487) — the PURE grouping model behind the Design Studio rail.
// The full hierarchy is technology → visual language → kit → components: `tech` (lowercase slug)
// is the top grouping axis, `style` (the visual language — a STRUCTURALLY different component set,
// i.e. a different kit; the palette/THEME axis restyles one kit via tokens and never appears here)
// is the second. React/Tauri-free so the rail render and the tests share one model.
//
// AUTO-FLATTEN — a level materializes only when it genuinely partitions the kits under it. A level
// collapses out when its partition is TRIVIAL:
//   - ONE bucket   — every kit shares the value (today: both packaged kits are `react`), or
//   - ALL SINGLETON buckets — one kit per value (today: `studio` + `demo` each hold one kit), so a
//     header per kit would just restate the kit rows beneath it.
// With the packaged library (2 react kits, one kit per style) BOTH levels are trivial and the rail
// renders exactly as flat as the pre-#2487 kit list; the hierarchy appears only as the library
// grows genuinely multi-tech / multi-style. Levels render uniformly — a non-trivial level shows a
// header over EVERY bucket (a `vue` group keeps its header even with one kit when `react` beside it
// has two), never a mix of headers and bare kit rows.
//
// MISSING FIELDS — kits without `tech`/`style` (user-authored, imported, pre-#2487) group into the
// trailing "other" bucket; when everything lacks the fields the single bucket is trivial and the
// rail stays flat. Never a crash.
import type { Kit } from "./model";

/** The bucket kits without a `tech`/`style` value group under (always ordered last). */
export const OTHER_BUCKET = "other";

/** A kit row in the rail tree. */
export interface KitLeaf {
  kind: "kit";
  kit: Kit;
}

/** A collapsible group header in the rail tree (a tech or visual-language level). */
export interface KitGroup {
  kind: "group";
  level: "tech" | "style";
  /** Stable expand-state key (`tech:react`, `style:react/studio`). */
  key: string;
  label: string;
  /** Kits under this group (transitively). */
  count: number;
  children: KitTreeNode[];
}

export type KitTreeNode = KitGroup | KitLeaf;

const techOf = (k: Kit): string => (k.tech ?? "").trim().toLowerCase() || OTHER_BUCKET;
const styleOf = (k: Kit): string => (k.style ?? "").trim() || OTHER_BUCKET;

/** Bucket kits by an axis in first-appearance order, the missing-field OTHER bucket forced last. */
function bucket(kits: Kit[], keyOf: (k: Kit) => string): Map<string, Kit[]> {
  const m = new Map<string, Kit[]>();
  for (const k of kits) {
    const key = keyOf(k);
    const arr = m.get(key);
    if (arr) arr.push(k);
    else m.set(key, [k]);
  }
  const other = m.get(OTHER_BUCKET);
  if (other && m.size > 1) {
    m.delete(OTHER_BUCKET);
    m.set(OTHER_BUCKET, other);
  }
  return m;
}

/** The axis's partition of `kits`, or `null` when it is trivial (see the module doc) — collapse it. */
function partition(kits: Kit[], keyOf: (k: Kit) => string): Map<string, Kit[]> | null {
  const m = bucket(kits, keyOf);
  return m.size <= 1 || m.size === kits.length ? null : m;
}

const leaves = (kits: Kit[]): KitTreeNode[] => kits.map((kit) => ({ kind: "kit", kit }));

/** The visual-language level under one tech group (or under the root when the tech level collapsed). */
function styleLevel(kits: Kit[], keyPrefix: string): KitTreeNode[] {
  const byStyle = partition(kits, styleOf);
  if (!byStyle) return leaves(kits);
  return [...byStyle].map(([style, inStyle]) => ({
    kind: "group" as const,
    level: "style" as const,
    key: `style:${keyPrefix}${style}`,
    label: style,
    count: inStyle.length,
    children: leaves(inStyle),
  }));
}

/**
 * Group the kit library into the rail tree: tech groups → style groups → kit leaves, with each
 * trivial level auto-flattened out (see the module doc). Kits keep their library order within a
 * bucket; buckets order by first appearance, the "other" bucket last.
 */
export function groupKits(kits: Kit[]): KitTreeNode[] {
  const byTech = partition(kits, techOf);
  if (!byTech) return styleLevel(kits, "");
  return [...byTech].map(([tech, inTech]) => ({
    kind: "group" as const,
    level: "tech" as const,
    key: `tech:${tech}`,
    label: tech,
    count: inTech.length,
    children: styleLevel(inTech, `${tech}/`),
  }));
}
