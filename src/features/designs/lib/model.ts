// Pure model for the Component Library (#2269) — the technology-scoped "kits" of proven components the
// planner's `test_ui` stage browses. React/Tauri-free so non-UI code (and tests) can use it directly.
//
// The library is a GLOBAL store reached through the `bsc ui` CLI (see componentBridge.ts); this
// module owns only the shapes + pure derivations (search, compose/used-by resolution, role colors).

import type { KitAnimation, AnimationDef } from "@/shared/ui/kit/animations";
import { BASE_KIT_ID } from "@/shared/ui/kit/baseAnimations";
import type { GeneralNode } from "@/shared/ui/spec";

/** A component's architectural role — drives its accent color + grouping. */
export type Role = "primitive" | "composite" | "layout" | "page" | "service";

export const ROLES: Role[] = ["primitive", "composite", "layout", "page", "service"];

/** The data-shape vocabulary (#2475) — the seven canonical shapes a feature's data can take. The
 *  planner derives its data's shape, then asks the kit for the ideal rendering
 *  (`bsc ui shapes <shape>` / `bsc ui list --shape <shape>`). `series` (#3517) is an ordered label
 *  axis + one or more ALIGNED numeric value series — a time-series over an ordered domain (exactly the
 *  `{ labels, series }` shape `windowedTally` produces); distinct from `list` (homogeneous items, no
 *  axis) and `table` (heterogeneous columns per row). */
export type DataShape = "list" | "linked-list" | "tree" | "graph" | "table" | "key-value" | "series";

export const DATA_SHAPES: DataShape[] = ["list", "linked-list", "tree", "graph", "table", "key-value", "series"];

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
  /** A SUPPRESSION tombstone (#3725) — `true` marks this id as a PERMANENTLY removed packaged builtin, not
   *  a real kit. `reconcileSeed` skips re-seeding it (the tombstone occupies the id) and the library
   *  excludes it; `bsc ui kit suppress`/`unsuppress` write/clear it. Absent on every real record. */
  suppressed?: boolean;
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
/** One row of a component's change {@link ComponentRecord.history} (#3568) — appended by the Rust stamp
 *  boundary on every write so a session can review what changed, when, by whom, and why before editing. */
export interface ChangeEntry {
  /** The record `rev` this write produced (1 = the first write). */
  rev: number;
  /** ISO-8601 UTC timestamp of the write. */
  at: string;
  /** The writer tag — `bsc ui set --by …`, else the session's `$BSC_UI_WRITER`, else `"unknown"`. */
  by: string;
  /** Optional human summary of WHY the write happened (`bsc ui set --note …`). */
  note?: string;
  /** The top-level fields that changed on this write; `["created"]` on the very first write. */
  changed: string[];
}

/** One analytics event a component declares it emits (#3810, epic #3809) — DATA, not code. `event` is the
 *  event name (`click`, `item_selected`); `when` is an optional human note on the trigger; `props` are the
 *  event's payload fields. A shipped runtime (slice 2) reads these + emits; the component only DECLARES. */
export interface AnalyticsEvent {
  event: string;
  when?: string;
  props?: PropSpec[];
}

/** One test a component carries (#3878) — DATA, alongside the node, the same shape as an analytics event
 *  one field over. `name` is the test's description; `src` is its source.
 *
 *  Tests travel WITH the node because once a component's source is a store record compiled at runtime, a
 *  test file under `src/**` is no longer beside the thing it tests — and git stops being the record of what
 *  ships. #3833 is what that costs: the Skills record ran on a preview-grade transcription for days, and the
 *  page still looked right. */
export interface ComponentTest {
  name: string;
  src: string;
}

export interface ComponentRecord {
  id: string;
  name: string;
  kitId: string;
  role: Role;
  /** The component's FOLDER PATH within the kit (#3048/#3579) — a nested, `/`-delimited path
   *  (`shared/ui/controls`, `features/github`) that organizes the kit like a completed project's
   *  folders, DERIVED from `src` (`group_from_src` in `bsc-component`; the harvest seeds it and
   *  `bsc ui regroup` re-derives it for the whole store). ORTHOGONAL to {@link role} (the architectural
   *  tier that drives the composition swimlanes): `group` answers "where does this live in the project",
   *  `role` answers "what tier is it". ORGANIZATIONAL only — `composes` still resolves across the WHOLE
   *  kit, so components in DIFFERENT folders compose freely (kits never cross). Absent ⇒ the kit's
   *  trailing "ungrouped" bucket (`kitGroups.ts`). OPTIONAL and NEVER defaulted — like
   *  {@link Kit.tech}/`style`, an absent `group` must stay absent (never `""`) so a store copy keeps
   *  hashing to its recorded `seedHash` and the #2483 reconcile can refresh it. */
  group?: string;
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
  /** The component's analytics EVENTS manifest (#3810, epic #3809) — the events it emits, as DATA (not
   *  code): a Button declares `click`, a CollectionPage `item_selected`/`filter_changed`. The per-node
   *  instrumentation CONTRACT, sibling of the behavior/motion a node carries, so an app composed from
   *  these nodes is instrumented by construction. Absent/empty ⇒ uninstrumented — the `no-analytics` doctor
   *  finding flags an INTERACTIVE component that lacks one. A shipped runtime does the emitting (slice 2). */
  analytics?: AnalyticsEvent[];
  /** The component's TESTS (#3878) — carried as data on the node, like its analytics manifest. Absent/empty
   *  ⇒ untested, which the `no-tests` doctor finding flags for a node that HAS an implementation (a
   *  spec-only node is skipped: it already earns `no-implementation`, and one cause should not raise two
   *  findings). What EXECUTES a graph-held test is deliberately still open — vitest reads files, so either
   *  the graph emits them at test time or a runner compiles them the way the component loader does. */
  tests?: ComponentTest[];
  /** A SUPPRESSION tombstone (#3725) — `true` marks this id as a PERMANENTLY removed packaged builtin, not
   *  a real component. `reconcileSeed` skips re-seeding it (the tombstone occupies the id) and the library
   *  excludes it; the Rust doctor skips it; `bsc ui suppress`/`unsuppress` write/clear it. Absent on every
   *  real record. */
  suppressed?: boolean;
  /** LITE record (#4072) — hydrated from `bsc ui list --graph`, so it carries only what the graph
   *  renders: the node card + `composes`. Its `srcText`/`props`/`variants` are EMPTY DEFAULTS, not
   *  real values.
   *
   *  It exists so the Studio page can paint off a 33 KB read instead of blocking up to 8s on the
   *  1.72 MB `--full` one. The marker is load-bearing rather than cosmetic: without it an empty
   *  `srcText` is indistinguishable from a component that genuinely has none, so the preview would
   *  claim "no implementation source yet" and the build scan would silently skip every component.
   *  Cleared when the full read lands and replaces the record. */
  lite?: boolean;
  /** The raw intrinsic this component REPLACES (`"button"`, `"input"`) — the authoring hint that
   *  derives the flagship anti-duplication lint rule ("use <Name> not a raw <wraps>"). Absent ⇒ none. */
  wraps?: string;
  /** The registered PLATFORM module specifier this graph component OVERRIDES (#3660, epic #3604) — e.g.
   *  `@/shared/ui/layout/Spacer`. When present, the runtime loader vendors THIS component's `srcText` in
   *  place of the bundled module wherever a graph component imports that specifier, so a shared/ui
   *  primitive renders from the graph (DATA) rather than code. Absent ⇒ the component provides no platform
   *  override (a normal graph component, imported only as a `@/components/<id>` sibling). Graph-first with a
   *  code fallback: an unmatched specifier stays external (→ the registry), exactly as before. */
  provides?: string;
  /** Which THEME SYSTEM this component renders under (#3715). `"css"` (default, absent) — the component
   *  consumes the theme through the CSS cascade (`--card-*` etc. resolved by `:root` / `<ThemeScope>`), as
   *  every component does today. `"js"` — the component renders to a NON-CSS surface (canvas / WebGL / a
   *  non-web runtime) that can't see the cascade, so the runtime loader wraps it in a `<ThemeProvider>` and
   *  it reads the resolved token VALUES via `useResolvedTheme()`. Opt-in + inert like {@link provides}: an
   *  absent / `"css"` value is byte-identical to today, and (like `group`/`provides`) an absent value must
   *  stay absent — never defaulted to `"css"` — so a store copy keeps hashing to its `seedHash`. */
  themeSystem?: "css" | "js";
  /** Author-declared lint rules this component contributes to its kit's preset (in addition to the
   *  ones derived from `wraps`). Absent ⇒ none. */
  rules?: KitRule[];
  /** The data shapes this component is an IDEAL rendering for (#2475) — the axis `bsc ui shapes` /
   *  `bsc ui list --shape` picks layouts by. Meaningful on layout-role components and the
   *  data-rendering composites (rows, feeds, property lists); absent ⇒ not shape-indexed (chrome,
   *  controls, chrome-level layouts that host arbitrary panes rather than render a data collection). */
  shapes?: DataShape[];
  /** The renderable STRUCTURE of a `page`/`layout`-role component as a validated data tree (#3569),
   *  rendered by `KitRenderer`. This is what makes a page's skeleton editable IN THE GRAPH: the host
   *  (e.g. `Fleet.tsx`) renders the store node's `spec` — its hand-authored const is only the
   *  seed/fallback — so editing the node in the Design Studio reflects on the real page. Absent ⇒ the
   *  component has no data-tree layout (a leaf primitive, or a page not migrated to a spec yet). */
  spec?: GeneralNode;
  /** Content hash of the seed copy this record came from (#2483) — see {@link Kit.seedHash}. */
  seedHash?: string;
  /** MOTION binding (#2942/#3065) — each entry is EITHER a kit-animation NAME (resolved from the owning
   *  {@link Kit}'s `animations` library — SHARED/reusable motion the kit owns) OR an INLINE def (a full
   *  {@link KitAnimation} object used directly — COMPONENT-SPECIFIC one-off motion, e.g. a d3-chart
   *  draw-in or a component-scoped `selector` animation not worth lifting to the kit). Resolved by
   *  {@link resolveComponentAnimations}. Absent ⇒ no motion. */
  animations?: (string | KitAnimation)[];
  /** Provenance stamp (#3164) — the store bumps `rev` and records who/when on every write. Absent on a
   *  legacy record never written since the stamp landed (reads as rev 0). */
  rev?: number;
  updatedAt?: string;
  updatedBy?: string;
  /** Change history (#3568) — one capped entry per write, stored NEWEST-LAST. `bsc ui log <id>` reads
   *  them newest-first; the inspector's History tab renders them. Absent ⇒ never written since #3568. */
  history?: ChangeEntry[];
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

/** Does a component match a free-text query (name / role / folder / tag, case-insensitive)? The `group`
 *  folder path (#3579) matches too, so a query like `charts` or `features/github` filters the rail to a
 *  folder. Empty query → all. */
export function matchesQuery(c: ComponentRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.role.includes(q) ||
    (c.group ?? "").toLowerCase().includes(q) ||
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

/** Is `e` a valid INLINE animation def (#3065) — a full {@link KitAnimation} object carried directly on
 *  a component (component-specific one-off motion), as opposed to a NAME string that resolves from the
 *  kit's shared library? Requires a non-null object with a non-empty string `name` AND a non-null object
 *  `keyframes`, so a malformed object is DROPPED rather than compiled into junk CSS. */
function isInlineAnim(e: unknown): e is KitAnimation {
  const a = e as KitAnimation | null;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.name === "string" &&
    a.name.length > 0 &&
    typeof a.keyframes === "object" &&
    a.keyframes !== null
  );
}

/** Resolve EVERY animation a component binds (#2942/#3065) into the flat, kit-scoped {@link AnimationDef}s
 *  — the FULL set, with ALL {@link KitAnimation.group} variations kept (both the default and its
 *  alternatives). Each entry is EITHER a NAME — looked up in the owning kit's `animations` library
 *  (shared/reusable motion) — OR an INLINE def (a full {@link KitAnimation} object used directly, for
 *  component-specific one-off motion). Names that don't resolve, and malformed inline objects, are
 *  dropped. It does NOT bail when the kit's library is empty (an inline-only component must still
 *  resolve); every resolved def is stamped with the component's `kitId`, preserving first-appearance
 *  order. Empty when the component binds nothing. Pure (React-free). This is what the right-pane
 *  AnimationsMenu lists so the user can see + switch each slot's variations; the RENDER path
 *  ({@link resolveComponentAnimations}) narrows it to the one-per-group set that actually plays.
 *
 *  CROSS-KIT (#3451): a NAME the component's own kit doesn't define falls back to the shared `base`
 *  kit's library — the app's foundational motion (`lift`/`fade-in`/`pulse`) is owned there once and
 *  REFERENCED by every kit, so editing it propagates to all of them. A base-resolved def keeps
 *  `kit: BASE_KIT_ID` (it is NOT restamped to the consumer): that field names both the compiled
 *  `@keyframes bsc-base-<name>` and the `.base-anim-<name>` hook the preview stamps, so every consumer
 *  shares ONE keyframes block instead of duplicating it per kit. A kit's OWN def always wins, so a kit
 *  can still override a base motion by declaring the same name. */
export function resolveComponentAnimationDefs(comp: ComponentRecord, kits: Kit[]): AnimationDef[] {
  const entries = comp.animations ?? [];
  if (!entries.length) return [];
  const own = new Map((kits.find((k) => k.id === comp.kitId)?.animations ?? []).map((a) => [a.name, a] as const));
  const base =
    comp.kitId === BASE_KIT_ID
      ? null
      : new Map((kits.find((k) => k.id === BASE_KIT_ID)?.animations ?? []).map((a) => [a.name, a] as const));
  const out: AnimationDef[] = [];
  for (const e of entries) {
    if (typeof e === "string") {
      const mine = own.get(e);
      if (mine) { out.push({ ...mine, kit: comp.kitId }); continue; }
      const shared = base?.get(e);
      if (shared) out.push({ ...shared, kit: BASE_KIT_ID });
      continue;
    }
    if (isInlineAnim(e)) out.push({ ...e, kit: comp.kitId });
  }
  return out;
}

/** Resolve an animation by NAME to its playable def (#3071) — the SELECTED component's OWN animations
 *  first (inline defs + resolved kit refs, all variations), then the kit's generic shelf. This is what
 *  the preview's TRY-ON uses, so clicking a component animation replays it; a kit-only lookup misses the
 *  now-inline component animations (the kit library is empty after the component-owned migration) → no
 *  `extraAnimation` → no rebuild-key change → no replay. Returns `null` when nothing matches. Pure. */
export function resolveNamedAnimation(
  comp: ComponentRecord | null,
  kit: Kit | undefined,
  kits: Kit[],
  name: string,
): AnimationDef | null {
  if (!name) return null;
  const own = comp ? resolveComponentAnimationDefs(comp, kits) : [];
  const shelf = kit ? (kit.animations ?? []).map((a) => ({ ...a, kit: kit.id })) : [];
  // #3451: the shared `base` shelf is reachable from EVERY kit. react-ui's own library is empty now
  // (its base motions moved to `base`), so without this a base motion could not be tried on at all.
  const baseShelf =
    kit?.id === BASE_KIT_ID
      ? []
      : (kits.find((k) => k.id === BASE_KIT_ID)?.animations ?? []).map((a) => ({ ...a, kit: BASE_KIT_ID }));
  return [...own, ...shelf, ...baseShelf].find((x) => x.name === name) ?? null;
}

/** The animations the render-preview should COMPILE. A try-on ISOLATES the clicked animation — the
 *  preview plays ONLY it, so clicking each animation in the menu previews THAT one; with no try-on the
 *  component's full bound motion plays. (#3075: before, the try-on was APPENDED to the full bound set,
 *  so every click compiled the identical set and the preview never changed — "always the same one".)
 *  Pure (React-free). */
export function previewAnimDefs(boundDefs: AnimationDef[], tryOn: AnimationDef | null | undefined): AnimationDef[] {
  return tryOn ? [tryOn] : boundDefs;
}

/** Resolve a component's MOTION bindings into the flat, kit-scoped {@link AnimationDef}s that ACTUALLY
 *  PLAY (#2942/#3065/#3069) — the set the render engine compiles. Resolves every binding
 *  ({@link resolveComponentAnimationDefs}), then applies VARIATION selection (#3069): a def with NO
 *  {@link KitAnimation.group} always plays (unchanged); defs sharing a `group` are alternatives of ONE
 *  slot and only ONE plays — the one marked {@link KitAnimation.default}, else the FIRST in appearance
 *  order — occupying the group's first-appearance position (so switching the slot default never reorders
 *  the played set). First-appearance order is preserved. A component whose bindings carry NO `group`
 *  (today's data) resolves to exactly the same list as before — zero regression. Pure (React-free). */
export function resolveComponentAnimations(comp: ComponentRecord, kits: Kit[]): AnimationDef[] {
  const resolved = resolveComponentAnimationDefs(comp, kits);
  // The playing def per group: the one marked `default`, else the first seen (appearance order).
  const chosen = new Map<string, AnimationDef>();
  for (const d of resolved) {
    if (!d.group) continue;
    const cur = chosen.get(d.group);
    if (!cur || (d.default && !cur.default)) chosen.set(d.group, d);
  }
  // Emit in first-appearance order: an ungrouped def as-is; a group ONCE, at its first slot, holding its pick.
  const out: AnimationDef[] = [];
  const emitted = new Set<string>();
  for (const d of resolved) {
    if (!d.group) { out.push(d); continue; }
    if (emitted.has(d.group)) continue;
    emitted.add(d.group);
    out.push(chosen.get(d.group)!);
  }
  return out;
}

/** The ACTIVE animation defs of the siblings a component COMPOSES (#3130) — pair each rendered import
 *  with its motion. For every name in `comp.composes`, find that same-kit component in `comps` and take
 *  its {@link resolveComponentAnimations} (the one-per-group active set). Each composed def is NAMESPACED
 *  by its owning sibling (#3163, `AnimationDef.component = sib.name`) so two composed pieces that name an
 *  animation the same (`draw-in`) compile to DISTINCT keyframes instead of one clobbering the other; a
 *  genuinely SHARED animation (byte-identical content across siblings — a kit's chart primitives all using
 *  the same `fade-in`) still contributes exactly ONCE (deduped by content, not by name). The preview
 *  UNIONS these with the component's own motion — the composed pieces (a chart's ChartFrame / Axis) then
 *  animate in too, not just the top component's own marks. Composes nothing ⇒ `[]`. Pure (React-free). */
export function resolveComposedAnimations(
  comp: ComponentRecord,
  comps: ComponentRecord[],
  kits: Kit[],
): AnimationDef[] {
  const byName = new Map(comps.map((c) => [c.name, c] as const));
  const seen = new Set<string>();
  const out: AnimationDef[] = [];
  for (const name of comp.composes) {
    const sib = byName.get(name);
    if (!sib || sib.kitId !== comp.kitId) continue;
    for (const def of resolveComponentAnimations(sib, kits)) {
      // Dedup by CONTENT (the def sans-`component`), so a shared animation across siblings contributes
      // once — but keep two DIFFERENT animations that merely share a name (they'll be namespaced apart).
      const key = JSON.stringify(def);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...def, component: sib.name });
    }
  }
  return out;
}

/** The canonical motion PRESET group (#3083). A component's motion is presented as a pick-one list of
 *  PRESETS — each binding is a composed alternative and only the chosen one plays. Folding every inline
 *  binding into ONE group makes "the entire component's animation" a single selectable value. */
export const MOTION_PRESET_GROUP = "motion";

/** Rewrite a component's `animations` so `name` becomes the ACTIVE preset (#3083): every INLINE def joins
 *  {@link MOTION_PRESET_GROUP} and the def named `name` is its `default`, so it's the ONE that plays
 *  ({@link resolveComponentAnimations} emits one-per-group). NAME-ref entries (strings) are left as-is —
 *  a shared-motion binding carries no component-level default. Pure; the studio persists the result. */
export function selectAnimationPreset(
  animations: (string | KitAnimation)[],
  name: string,
): (string | KitAnimation)[] {
  return animations.map((e) =>
    typeof e === "string" ? e : { ...e, group: MOTION_PRESET_GROUP, default: e.name === name },
  );
}
