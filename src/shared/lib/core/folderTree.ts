// The rail FOLDER TREE (#4128) — the ONE nested-folder model both library rails render.
//
// Components (`RailTree`) and Algorithms (`AlgorithmsRail`) each browse a library organized like a
// completed project's folders: a `/`-delimited path per record (derived from its source by the shared
// `bsc_util::folder_from_src`, so a component and an algorithm harvested from the same tree land in the
// same place) split into nested folders. Until #4128 each feature owned its own builder — components'
// `groupComponentsByFolder` (#3048/#3582) and algorithms' `folderTree` (#4107) — which had silently
// diverged on the two decisions that are actually visible in the rail:
//
//   * an item with NO folder: components bucketed it into a trailing "ungrouped" folder, algorithms
//     spilled it flat beside the tree;
//   * folder order: components kept first-appearance order (of already-sorted rows), algorithms re-sorted
//     alphabetically and ignored the caller's ordering.
//
// Two implementations of "the same structure" cannot stay the same by agreement, so this is the single
// one. Generic over the record type — it only ever asks for a record's folder path — so neither feature's
// model leaks into `shared/`.
//
// Pure and React-free: the tree shape is testable without a render, and both rails' tests exercise the
// same code the app does.

/** Header label of the trailing bucket holding the records that carry no folder. */
export const UNGROUPED_LABEL = "ungrouped";

/** The stable expand-state key of the trailing {@link UNGROUPED_LABEL} folder. A sentinel, so it can
 *  never collide with a real single-segment folder path (a source folder is never literally named this). */
export const UNGROUPED_KEY = "__ungrouped__";

/**
 * One folder of a library's tree — a folder that mirrors a segment of its records' folder paths
 * (`shared` › `ui` › `controls`).
 *
 * A folder holds BOTH sub-`folders` (deeper path segments) AND direct `items` (records whose path ends
 * exactly here — a component grouped `shared/ui` sits directly under the `ui` folder alongside its
 * `controls`/`data` subfolders).
 */
export interface FolderNode<T> {
  /** Stable expand-state key — the folder's FULL path (`shared/ui/controls`), or {@link UNGROUPED_KEY}
   *  for the trailing bucket. Unique within one tree. */
  key: string;
  /** Header label — the LAST path segment (`controls`), or {@link UNGROUPED_LABEL} for the bucket. */
  label: string;
  /** Whether this is the forced-last bucket of records carrying no folder. */
  ungrouped: boolean;
  /** Child folders (deeper path segments), in first-appearance order. */
  folders: FolderNode<T>[];
  /** Records whose folder path ENDS at this folder (its direct members). */
  items: T[];
}

/** Total records under a folder, transitively (its own + every descendant's) — the header count. A
 *  collapsed folder still has to say how much is inside it, or a deep tree gives no sense of where the
 *  work lives. */
export function folderItemCount<T>(f: FolderNode<T>): number {
  return f.items.length + f.folders.reduce((n, sub) => n + folderItemCount(sub), 0);
}

/**
 * Partition records into a nested FOLDER TREE by their folder path — split each path on `/` and nest
 * (`shared/ui/controls` → `shared` › `ui` › `controls`), so a library browses like a project's folders.
 * A record sits at the LEAF of its path.
 *
 * Order is the CALLER's: folders appear in the first-appearance order of the passed (already-sorted)
 * records, and a folder's own records keep their relative order — so a rail that sorts pages first, or
 * primitives before algorithms, keeps that reading inside every folder. The "ungrouped" bucket is forced
 * LAST at the root.
 *
 * Returns `null` when NO record carries a folder, so a caller renders its flat list exactly as it would
 * without folders at all — a library that has not been foldered yet must not collapse under one blank
 * node. A depth-1 path (`forms`) yields a single root folder with no subfolders: the flat case is just
 * the shallow case of this tree.
 *
 * @param items    the records to organize, in the order they should read
 * @param folderOf a record's `/`-delimited folder path; blank/absent ⇒ the ungrouped bucket
 */
export function buildFolderTree<T>(
  items: readonly T[],
  folderOf: (item: T) => string | undefined,
): FolderNode<T>[] | null {
  if (!items.some((it) => (folderOf(it) ?? "").trim())) return null;

  // Mutable builder: `children` is a Map so it preserves first-appearance insertion order.
  interface Build {
    key: string;
    label: string;
    ungrouped: boolean;
    children: Map<string, Build>;
    items: T[];
  }
  const mk = (key: string, label: string, ungrouped = false): Build => ({
    key,
    label,
    ungrouped,
    children: new Map(),
    items: [],
  });

  const roots = new Map<string, Build>();
  let ungrouped: Build | null = null;

  for (const it of items) {
    const path = (folderOf(it) ?? "").trim();
    if (!path) {
      ungrouped ??= mk(UNGROUPED_KEY, UNGROUPED_LABEL, true);
      ungrouped.items.push(it);
      continue;
    }
    const segs = path.split("/").map((s) => s.trim()).filter(Boolean);
    // A path of only separators/blanks (`"/"`, `"  /  "`) has no usable segment — treat it as unfoldered
    // rather than manufacturing a `""` node the rail would render as a nameless folder.
    if (segs.length === 0) {
      ungrouped ??= mk(UNGROUPED_KEY, UNGROUPED_LABEL, true);
      ungrouped.items.push(it);
      continue;
    }
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
    // `node` is non-null: a non-empty `segs` yields at least one iteration.
    node!.items.push(it);
  }

  const freeze = (b: Build): FolderNode<T> => ({
    key: b.key,
    label: b.label,
    ungrouped: b.ungrouped,
    folders: [...b.children.values()].map(freeze),
    items: b.items,
  });

  const out = [...roots.values()].map(freeze);
  if (ungrouped) out.push(freeze(ungrouped)); // forced last
  return out;
}
