// Pure model for the Component Library (#2269) — the technology-scoped "kits" of proven components the
// planner's `test_ui` stage browses. React/Tauri-free so non-UI code (and tests) can use it directly.
//
// The library is a GLOBAL store reached through the `bsc component` CLI (see componentBridge.ts); this
// module owns only the shapes + pure derivations (search, compose/used-by resolution, role colors).

/** A component's architectural role — drives its accent color + grouping. */
export type Role = "primitive" | "composite" | "layout" | "page" | "service";

export const ROLES: Role[] = ["primitive", "composite", "layout", "page", "service"];

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
  /** Short stack label (e.g. "React · TypeScript"). */
  stack: string;
  /** The kit's dot color (a CSS color; the seed uses app tokens). */
  dot: string;
  /** A packaged built-in (re-seeded into the store on hydrate). Absent ⇒ user-authored. */
  builtin?: boolean;
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
  /** Representative source text. */
  srcText: string;
  /** A packaged built-in (re-seeded into the store on hydrate). Absent ⇒ user-authored. */
  builtin?: boolean;
  /** The raw intrinsic this component REPLACES (`"button"`, `"input"`) — the authoring hint that
   *  derives the flagship anti-duplication lint rule ("use <Name> not a raw <wraps>"). Absent ⇒ none. */
  wraps?: string;
  /** Author-declared lint rules this component contributes to its kit's preset (in addition to the
   *  ones derived from `wraps`). Absent ⇒ none. */
  rules?: KitRule[];
}

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
