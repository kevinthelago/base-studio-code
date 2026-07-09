// Hierarchical kit navigation (#2487, policy fixed by #2506) — the PURE grouping model behind the
// Design Studio rail. The full hierarchy is technology → visual language → kit → components: `tech`
// (lowercase slug) is the top grouping axis, `style` (the visual language — a STRUCTURALLY different
// component set, i.e. a different kit; the palette/THEME axis restyles one kit via tokens and never
// appears here) is the second. React/Tauri-free so the rail render and the tests share one model.
//
// ALWAYS GROUPED (#2506) — the rail shows technology groups at the top level and style groups within
// each technology, ALWAYS. (#2487 originally auto-flattened a level whose partition was trivial; that
// heuristic is superseded by explicit user direction — the fixed two-level hierarchy is the point, so
// the packaged single-kit library reads React → Studio → components rather than a bare kit list.)
//
// THE SINGLE-KIT STYLE MERGE — a kit is a (tech, style) unit, so the normal case is a style bucket
// holding exactly ONE kit. Then the style header IS the kit: the group node carries `kit`, its
// components list directly under the style header, and no redundant kit row renders. Only when
// several kits share one (tech, style) pair does a kit level nest beneath the style group.
//
// MISSING FIELDS — kits without `tech`/`style` (user-authored, imported, pre-#2487) group into the
// trailing "other" bucket on that axis. Never a crash.
import type { Kit } from "./model";

/** The bucket kits without a `tech`/`style` value group under (always ordered last). */
export const OTHER_BUCKET = "other";

/** A kit row in the rail tree (only under a style that holds SEVERAL kits — see the module doc). */
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
  /** Style level only: when the style holds exactly ONE kit, the header IS that kit — components
   *  render directly beneath it and `children` is empty (#2506). */
  kit?: Kit;
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

/** The style level under one tech group: a style group per bucket; a single-kit style merges the kit
 *  into its header (see the module doc). */
function styleLevel(kits: Kit[], keyPrefix: string): KitTreeNode[] {
  return [...bucket(kits, styleOf)].map(([style, inStyle]) => ({
    kind: "group" as const,
    level: "style" as const,
    key: `style:${keyPrefix}${style}`,
    label: style,
    count: inStyle.length,
    ...(inStyle.length === 1
      ? { kit: inStyle[0], children: [] as KitTreeNode[] }
      : { children: inStyle.map((kit): KitTreeNode => ({ kind: "kit", kit })) }),
  }));
}

/**
 * Group the kit library into the rail tree: tech groups → style groups (→ kit leaves only when a
 * style holds several kits) — ALWAYS grouped, per the module doc (#2506). Kits keep their library
 * order within a bucket; buckets order by first appearance, the "other" bucket last.
 */
export function groupKits(kits: Kit[]): KitTreeNode[] {
  return [...bucket(kits, techOf)].map(([tech, inTech]) => ({
    kind: "group" as const,
    level: "tech" as const,
    key: `tech:${tech}`,
    label: tech,
    count: inTech.length,
    children: styleLevel(inTech, `${tech}/`),
  }));
}
