// Pure model for the Component Library (#2269) — the technology-scoped "kits" of proven components the
// planner's `test_ui` stage browses. React/Tauri-free so non-UI code (and tests) can use it directly.
//
// The library is a GLOBAL store reached through the `bsc ui` CLI (see componentBridge.ts); this
// module owns only the shapes + pure derivations (search, compose/used-by resolution, role colors).

import type { KitAnimation, AnimationDef } from "@/shared/ui/kit/animations";

/** A component's architectural role — drives its accent color + grouping. */
export type Role = "primitive" | "composite" | "layout" | "page" | "service";

export const ROLES: Role[] = ["primitive", "composite", "layout", "page", "service"];

/** The data-shape vocabulary (#2475) — the six canonical shapes a feature's data can take. The
 *  planner derives its data's shape, then asks the kit for the ideal rendering
 *  (`bsc ui shapes <shape>` / `bsc ui list --shape <shape>`). */
export type DataShape = "list" | "linked-list" | "tree" | "graph" | "table" | "key-value";

export const DATA_SHAPES: DataShape[] = ["list", "linked-list", "tree", "graph", "table", "key-value"];

/** One public prop / API member of a component. */
export interface PropSpec {
  name: string;
  type: string;
  /** Required (rendered with a `*`). */
  req: boolean;
  desc: string;
}

/** A technology-scoped namespace of components (e.g. `react-ui`, `spring-kotlin`). */
export interface Kit {
  id: string;
  name: string;
  /** The technology axis (#2487) — a lowercase slug (`react`, `vue`, `kotlin`, …), the top level of
   *  the Design Studio rail hierarchy (tech → visual language → kit → components). Absent ⇒ a
   *  user-authored/imported kit that never declared one; it groups into the trailing "other" bucket
   *  (`kitGroups.ts`), never crashes the rail. OPTIONAL rather than defaulted-to-`""` on purpose: a
   *  pre-#2487 store copy must keep hashing to its recorded `seedHash` (absent fields drop out of
   *  `stableStringify`), so the #2483 reconcile sees it as pristine and auto-refreshes it when the
   *  packaged seed gains these fields. */
  tech?: string;
  /** The visual-language axis (#2487) — the label of the kit's visual language (`studio`, `demo`,
   *  `material`, …), the second rail level. A visual language is a STRUCTURALLY different component
   *  set — different DOM/composition/CSS architecture, i.e. a DIFFERENT KIT — which is why it lives
   *  on the kit. The palette is the separate THEME axis: a theme restyles ONE kit via its semantic
   *  tokens and deliberately never appears in this hierarchy. Absent ⇒ "other" bucket (see `tech`). */
  style?: string;
  /** Short stack label — display text only (e.g. "React · TypeScript"); the structured grouping
   *  axes are `tech` + `style`. */
  stack: string;
  /** The kit's dot color (a CSS color; the seed uses app tokens). */
  dot: string;
  /** The kit's MOTION library (#2942) — named animations as DATA, the motion sibling of themes. A
   *  component plays one by referencing its name in `ComponentRecord.animations`; the render engine
   *  (`@/shared/ui/kit` `kitAnimations` → `compileAnimationsCss`) compiles each to
   *  `@keyframes bsc-<kit>-<name>` + a `prefers-reduced-motion`-guarded rule on `.<kit>-anim-<name>`.
   *  Per-kit (not global): a structurally-different kit (3D/non-DOM) carries its own motion. Absent ⇒
   *  no motion. See {@link KitAnimation}. */
  animations?: KitAnimation[];
  /** A packaged built-in (re-seeded into the store on hydrate). Absent ⇒ user-authored. */
  builtin?: boolean;
  /** Content hash of the seed copy this record came from (#2483, `seedRefresh.ts`) — stamped at
   *  seed-assembly time; lets hydrate tell a pristine built-in (refreshable) from a user-edited one
   *  (kept). Absent ⇒ user-authored or a legacy pre-#2483 copy. */
  seedHash?: string;
}

/** A config-level lint rule a kit ships (#2279) — each maps to a stock eslint rule (NO custom AST
 *  plugin), so a kit's enforcement is authorable as data and the generated app just extends the emitted
 *  preset. Custom AST-rule plugins + non-eslint linters are a follow-up. */
export type KitRuleKind =
  /** → `no-restricted-syntax`: forbid a raw JSX intrinsic (`button`), point to the kit component. */
  | "forbid-element"
  /** → `no-restricted-imports`: forbid a module specifier, point to the kit component. */
  | "forbid-import";

export interface KitRule {
  id: string;
  kind: KitRuleKind;
  /** What's forbidden: the JSX element name (`"button"`) or the module specifier (`"@mui/material"`). */
  target: string;
  /** The kit component to use instead (`"Button"`). */
  use: string;
  /** Override the default message; the default already names `use` + the escape hatch. */
  message?: string;
  /** The component this rule protects (drives the pane's Rules tab). */
  componentId?: string;
  /** Auto-derived from the kit vs author-declared. */
  derived?: boolean;
}

/** One proven component in a kit — the record the library stores and the pane renders. */
export interface ComponentRecord {
  id: string;
  name: string;
  kitId: string;
  role: Role;
  version: string;
  /** Times this component is used across the codebase (a reuse signal). */
  used: number;
  tags: string[];
  /** Named visual/behavioral variants (the preview + generate loop cycle these). */
  variants: string[];
  /** Names of the components this one composes (its dependencies). */
  composes: string[];
  props: PropSpec[];
  whenUse: string[];
  whenNot: string[];
  /** Source file path (shown above the source). */
  src: string;
  /** Representative source text — a short USAGE snippet (`import { Card } … <Card>…</Card>`), NOT the
   *  implementation. For the emittable implementation see {@link source}. */
  srcText: string;
  /** The component's verbatim implementation source (#2794) — the actual `.tsx` file contents, bundled
   *  into the packaged kit ARTIFACT at generation time so `bsc ui … emit` (the vendored-source
   *  distribution, epic #2793) has real code to write. Distinct from the usage-snippet {@link srcText}.
   *  Present only in the packaged/released kit artifact, NOT in the mutable component store (the seed +
   *  `bsc ui set` write-through deliberately omit it — the store is a contract catalog); absent ⇒ a
   *  component with no standalone source file (a pure stub). */
  source?: string;
  /** A packaged built-in (re-seeded into the store on hydrate). Absent ⇒ user-authored. */
  builtin?: boolean;
  /** The raw intrinsic this component REPLACES (`"button"`, `"input"`) — the authoring hint that
   *  derives the flagship anti-duplication lint rule ("use <Name> not a raw <wraps>"). Absent ⇒ none. */
  wraps?: string;
  /** Author-declared lint rules this component contributes to its kit's preset (in addition to the
   *  ones derived from `wraps`). Absent ⇒ none. */
  rules?: KitRule[];
  /** The data shapes this component is an IDEAL rendering for (#2475) — the axis `bsc ui shapes` /
   *  `bsc ui list --shape` picks layouts by. Meaningful on layout-role components and the
   *  data-rendering composites (rows, feeds, property lists); absent ⇒ not shape-indexed (chrome,
   *  controls, chrome-level layouts that host arbitrary panes rather than render a data collection). */
  shapes?: DataShape[];
  /** Content hash of the seed copy this record came from (#2483) — see {@link Kit.seedHash}. */
  seedHash?: string;
  /** MOTION binding (#2942) — the names of the owning {@link Kit}'s animations this component plays.
   *  The kit owns the keyframes/timing/trigger ({@link Kit.animations}); a component just references
   *  them by name, so the same motion is reused across a kit's components. Absent ⇒ no motion. */
  animations?: string[];
}

/** The shared zero-state title — Design Studio and the Planner Components pane must say the same
 *  thing about the same empty library (#2420). */
export const NO_COMPONENTS_TITLE = "No components yet";

/** Role → accent color, mapped to app design tokens (not the prototype's raw palette). */
export const ROLE_COLOR: Record<Role, string> = {
  primitive: "var(--info)",
  composite: "var(--accent)",
  layout: "var(--violet)",
  page: "var(--success)",
  service: "var(--state-wait)",
};

/** Does a component match a free-text query (name / role / tag, case-insensitive)? Empty query → all. */
export function matchesQuery(c: ComponentRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.role.includes(q) ||
    c.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** The components `c` composes, each paired with its resolved record (or `undefined` if not in the kit). */
export function resolveComposes(
  c: ComponentRecord,
  all: ComponentRecord[],
): { name: string; comp?: ComponentRecord }[] {
  return c.composes.map((name) => ({ name, comp: all.find((x) => x.name === name) }));
}

/** The components that compose `c` (its "used by" set). */
export function resolveUsedBy(c: ComponentRecord, all: ComponentRecord[]): ComponentRecord[] {
  return all.filter((x) => x.composes.includes(c.name));
}

/** Resolve a component's MOTION bindings (#2942) into the flat, kit-scoped {@link AnimationDef}s the
 *  render engine compiles: look each bound name up in the owning kit's `animations` library, dropping
 *  any that don't resolve. Empty when the component binds nothing or its kit has no matching motion. */
export function resolveComponentAnimations(comp: ComponentRecord, kits: Kit[]): AnimationDef[] {
  const names = comp.animations ?? [];
  if (!names.length) return [];
  const kit = kits.find((k) => k.id === comp.kitId);
  if (!kit?.animations?.length) return [];
  const byName = new Map(kit.animations.map((a) => [a.name, a]));
  return names
    .map((n) => byName.get(n))
    .filter((a): a is KitAnimation => !!a)
    .map((a) => ({ ...a, kit: kit.id }));
}
