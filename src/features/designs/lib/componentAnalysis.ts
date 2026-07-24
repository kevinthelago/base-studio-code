// Component analysis (#3667, epic #3604) — derive a graph component's CATEGORIZATION metadata from its
// source, so an extracted component lands in the right composition-graph swimlane with real dependency edges
// instead of as a metadata shell. Pure + React-free (a type-only `model` import, erased at runtime), so it's
// reusable by the app, the backfill script, and future extraction generators, and unit-testable.
//
// Derives the two categorization signals that drive the Design Studio's composition graph:
//   • `composes` — the EDGE set: the NAMES of the graph components this one imports (a `@/components/<id>`
//     sibling, or a `@/shared/ui/*` primitive a graph component PROVIDES). Name-keyed + resolved within-kit,
//     matching the store convention. Plain-code imports (an unextracted shared/ui module, a lib) are NOT
//     edges — they're not graph nodes.
//   • `role` — the TIER (`primitive | composite | layout | page | service`): the swimlane band. A page stays
//     a page; a structural container is a layout; anything that ASSEMBLES (composes a sibling, or renders
//     several imported components) is a composite; a leaf atom is a primitive.
import type { ComponentRecord, Role } from "./model";

/** Resolve an import specifier → the composed graph component's NAME, or null if it's not a graph node. */
export type NameResolver = (specifier: string) => string | null;

/** Structural-container primitives — a `layout`-tier component (renders `children` as a box), by NAME. */
const LAYOUT_NAMES = new Set([
  "Box", "Stack", "Row", "Grid", "Spacer", "Screen", "MasterDetail", "SectionHeader", "SectionLabel",
  "GraphRail", "GraphCanvas", "RailRow", "RailSection", "Pane", "TabBar", "Divider",
  "ModalScrim", "ModalCard", "Dialog", "GraphLegend", "RailGroupHeader", "PaneGrid", "SessionDock", "SplitView",
]);

/** Content-atom FUNDAMENTALS — always `primitive`, even if they compose a utility (a Skeleton loading
 *  shim doesn't make an atom a composite). Mirrors compositionLayout's exemplars (Button/Text/Chip …). A
 *  composes-count alone can't separate `Text` (atom, composes Skeleton) from `Card` (composite, composes
 *  Skeleton), so the well-known atoms are curated. */
const PRIMITIVE_NAMES = new Set([
  "Text", "Chip", "Button", "IconButton", "Badge", "StatusDot", "ColorSwatch", "Avatar", "IconBox",
  "FillBar", "StatTile", "Kbd", "Skeleton", "Spinner", "Dot", "Tag",
  // form controls are fundamentals (even Field, which composes a Skeleton loading state)
  "Field", "TextField", "SelectField", "TextArea", "SearchField", "SegmentedControl", "Toggle", "Checkbox",
]);

/** The graph components a source composes → their NAMES (deduped, sorted). An import of a `@/components/<id>`
 *  sibling or a `@/shared/ui/*` specifier a component provides is an edge; everything else (plain code) isn't. */
export function deriveComposes(srcText: string, resolveName: NameResolver): string[] {
  const names = new Set<string>();
  const re = /\bfrom\s+"([^"]+)"/g; // every `… from "specifier"` (named/namespace/default imports)
  let m: RegExpExecArray | null;
  while ((m = re.exec(srcText)) !== null) {
    const name = resolveName(m[1]);
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Count DISTINCT imported components used as JSX tags (`<Foo …>`) — a proxy for "assembles components". */
export function renderedComponentCount(srcText: string): number {
  const tags = new Set<string>();
  const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(srcText)) !== null) tags.add(m[1]);
  return tags.size;
}

/** The architectural TIER, from the source's shape. A `page` record keeps its tier (a page is a page by
 *  definition); otherwise: structural container → `layout`; assembles (composes a sibling OR renders ≥3
 *  imported components) → `composite`; a leaf atom → `primitive`. */
export function deriveRole(name: string, existingRole: string | undefined, composes: string[], rendered: number): Role {
  if (existingRole === "page") return "page";
  if (LAYOUT_NAMES.has(name)) return "layout";
  if (PRIMITIVE_NAMES.has(name)) return "primitive"; // a curated content atom stays a fundamental
  if (composes.length >= 1 || rendered >= 3) return "composite";
  return "primitive";
}

/** The categorization metadata derived for one record — `composes` (edges) + `role` (tier). */
export interface DerivedMeta {
  composes: string[];
  role: Role;
}

/** Analyze a record: derive its `composes` edges + `role` tier from its `srcText`. `role` is typed loosely
 *  (string) on purpose — the whole point is to REPLACE an absent or INVALID existing role (e.g. our extracted
 *  records' non-tier `"component"`), so it must accept one. */
export function analyzeComponent(
  record: { name: string; role?: string; srcText: string },
  resolveName: NameResolver,
): DerivedMeta {
  const composes = deriveComposes(record.srcText, resolveName);
  const role = deriveRole(record.name, record.role, composes, renderedComponentCount(record.srcText));
  return { composes, role };
}

/** Build a `NameResolver` from a component set: `@/components/<id>` → the record's name; a `@/shared/ui/*`
 *  specifier a record PROVIDES → that record's name. Same-kit only (composes never crosses kits). */
export function buildNameResolver(records: Pick<ComponentRecord, "id" | "name" | "provides" | "kitId">[], kitId: string): NameResolver {
  const inKit = records.filter((r) => r.kitId === kitId);
  const byId = new Map(inKit.map((r) => [r.id, r.name] as const));
  const byProvides = new Map(inKit.filter((r) => r.provides).map((r) => [r.provides as string, r.name] as const));
  return (specifier) => {
    if (specifier.startsWith("@/components/")) return byId.get(specifier.slice("@/components/".length)) ?? null;
    return byProvides.get(specifier) ?? null;
  };
}
