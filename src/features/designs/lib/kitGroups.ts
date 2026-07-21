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
//
// THE `group` AXIS UNDER A KIT (#3048) — a kit's components carry an ORTHOGONAL `group` (their purpose
// partition: `data-viz` / `pages` / `forms` …). `groupComponentsByGroup` partitions ONE kit's
// components into that level (group → its components), reusing the same first-appearance ordering +
// forced-last "ungrouped" bucket as the kit `bucket()`. It returns `null` when NO component carries a
// `group`, so the rail renders the flat list exactly as before (zero regression for group-less kits).
import type { Kit, ComponentRecord } from "./model";

/** The bucket kits without a `tech`/`style` value — and components without a `group` — group under
 *  (always ordered last). */
export const OTHER_BUCKET = "other";

/** The header label shown for the trailing bucket of components that carry no `group` (#3048). */
export const UNGROUPED_LABEL = "ungrouped";

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
const groupOf = (c: ComponentRecord): string => (c.group ?? "").trim() || OTHER_BUCKET;

/** Bucket items by a key in first-appearance order, the missing-field OTHER bucket forced last.
 *  Generic over kits (the tech/style axes) and components (the #3048 `group` axis). */
function bucket<T>(items: readonly T[], keyOf: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const key = keyOf(x);
    const arr = m.get(key);
    if (arr) arr.push(x);
    else m.set(key, [x]);
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

/** One `group`-axis bucket under a kit (#3048): the components sharing a `group`, or the trailing
 *  "ungrouped" bucket (`ungrouped === true`). */
export interface ComponentGroup {
  /** The group value, or `OTHER_BUCKET` for the trailing ungrouped bucket (its stable key). */
  key: string;
  /** Header label — the group value, or `UNGROUPED_LABEL` for the ungrouped bucket. */
  label: string;
  /** Whether this is the forced-last bucket of components that carry no `group`. */
  ungrouped: boolean;
  components: ComponentRecord[];
}

/**
 * Partition ONE kit's components by their orthogonal `group` axis (#3048) — group → its components,
 * in first-appearance order with the "ungrouped" bucket (components with no `group`) forced LAST
 * (mirroring the kit `bucket()` OTHER-last rule). `composes` is unaffected: it resolves across the
 * whole kit, so components in different groups still compose freely — this level is organizational.
 *
 * Returns `null` when NO component carries a `group`, so the rail renders the flat component list
 * EXACTLY as before (zero regression for group-less kits). The passed order is preserved within each
 * bucket, so the caller controls sort (e.g. `byTier`) and search-filtering upstream.
 */
export function groupComponentsByGroup(comps: readonly ComponentRecord[]): ComponentGroup[] | null {
  if (!comps.some((c) => (c.group ?? "").trim())) return null;
  return [...bucket(comps, groupOf)].map(([key, components]) => ({
    key,
    label: key === OTHER_BUCKET ? UNGROUPED_LABEL : key,
    ungrouped: key === OTHER_BUCKET,
    components,
  }));
}
