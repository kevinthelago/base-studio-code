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

/** The stable expand-state key of the trailing "ungrouped" folder (#3582). A sentinel, so it can never
 *  collide with a real single-segment folder path (a src folder is never literally named this). */
export const UNGROUPED_KEY = "__ungrouped__";

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

/** One node of a kit's FOLDER TREE (#3582) — a folder that mirrors a segment of the components' `group`
 *  path (`shared` → `ui` → `controls`). A folder can hold BOTH sub-`folders` (deeper path segments) AND
 *  direct `components` (those whose `group` path ends exactly here — e.g. a component grouped `shared/ui`
 *  sits directly under the `ui` folder alongside its `controls`/`data` subfolders). The trailing
 *  ungrouped bucket (`ungrouped === true`) is a flat folder of the components carrying no `group`. */
export interface ComponentFolder {
  /** Stable expand-state key — the folder's FULL path (`shared/ui/controls`), or {@link UNGROUPED_KEY}
   *  for the ungrouped bucket. Unique within a kit. */
  key: string;
  /** Header label — the LAST path segment (`controls`), or {@link UNGROUPED_LABEL} for the ungrouped bucket. */
  label: string;
  /** Whether this is the forced-last bucket of components that carry no `group`. */
  ungrouped: boolean;
  /** Child folders (deeper path segments), in first-appearance order. */
  folders: ComponentFolder[];
  /** Components whose `group` path ENDS at this folder (its direct members). */
  components: ComponentRecord[];
}

/** Total components under a folder, transitively (its own + every descendant's) — the header count. */
export function folderComponentCount(f: ComponentFolder): number {
  return f.components.length + f.folders.reduce((n, sub) => n + folderComponentCount(sub), 0);
}

/**
 * Partition ONE kit's components into a nested FOLDER TREE by their `group` path (#3048/#3582) — split
 * each `group` on `/` and nest (`shared/ui/controls` → `shared` › `ui` › `controls`), so a kit browses
 * like a completed project's folders. A component sits at the LEAF of its path; a folder can hold both
 * subfolders and direct components. Folders keep first-appearance order (of the passed, already-sorted
 * rows); the "ungrouped" bucket (components with no `group`) is forced LAST at the root, mirroring the
 * kit `bucket()` OTHER-last rule. `composes` is unaffected — it resolves across the whole kit, so
 * components in different folders still compose freely; this tree is organizational only.
 *
 * Returns `null` when NO component carries a `folder`, so the rail renders the flat component list EXACTLY
 * as before (zero regression for folderless kits). A depth-1 path (`forms`) yields a single root folder
 * with no subfolders — i.e. the old flat behavior is the shallow case of this tree.
 */
export function groupComponentsByFolder(comps: readonly ComponentRecord[]): ComponentFolder[] | null {
  if (!comps.some((c) => (c.folder ?? "").trim())) return null;

  // Mutable builder: `children` is a Map so it preserves first-appearance insertion order.
  interface Build {
    key: string;
    label: string;
    ungrouped: boolean;
    children: Map<string, Build>;
    components: ComponentRecord[];
  }
  const mk = (key: string, label: string, ungrouped = false): Build => ({
    key,
    label,
    ungrouped,
    children: new Map(),
    components: [],
  });

  const roots = new Map<string, Build>();
  let ungrouped: Build | null = null;

  for (const c of comps) {
    const path = (c.folder ?? "").trim();
    if (!path) {
      ungrouped ??= mk(UNGROUPED_KEY, UNGROUPED_LABEL, true);
      ungrouped.components.push(c);
      continue;
    }
    const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
    let level = roots;
    let node: Build | null = null;
    let acc = "";
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = level.get(seg);
      if (!child) {
        child = mk(acc, seg);
        level.set(seg, child);
      }
      node = child;
      level = child.children;
    }
    // `node` is non-null: a non-empty `path` yields at least one segment.
    node!.components.push(c);
  }

  const freeze = (b: Build): ComponentFolder => ({
    key: b.key,
    label: b.label,
    ungrouped: b.ungrouped,
    folders: [...b.children.values()].map(freeze),
    components: b.components,
  });

  const out = [...roots.values()].map(freeze);
  if (ungrouped) out.push(freeze(ungrouped)); // forced last (mirrors the OTHER-last rule)
  return out;
}
