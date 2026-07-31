// componentPreview (#2824) — assemble the in-memory files + bootstrap entry for a component's
// build-and-iframe preview. Pure (no esbuild, no DOM) so it's unit-testable; the actual esbuild-wasm
// bundle + iframe live in the shared preview transport.
//
// Two source paths:
//   • BUILT-IN react-ui component → its verbatim `source` from the packaged kit artifact, PLUS the
//     artifact's whole component + `runtime` (@/ dependency-closure) set as in-memory files. esbuild
//     tree-shakes to just what the entry imports; the mem plugin resolves `@/…` to these files and
//     bare imports (react, d3) to esm.sh.
//   • USER-AUTHORED component → its own self-contained implementation source (imports libraries as bare
//     specifiers, which resolve from esm.sh). This is the case that renders arbitrary-library components
//     — a d3 component previews with no install. The store record deliberately omits the artifact-only
//     `source` field (it's a contract catalog, #2794), so we take that source from `comp.source` when
//     present, ELSE from `comp.srcText` WHEN it's a real module rather than the usual usage snippet
//     (`looksBuildableModule`, #2828). A usage-snippet `srcText` (`import { X } from "@/…"; <X …/>`) is
//     NOT buildable — its `…` placeholders don't compile — so it stays an honest empty state.
//     COMPOSING (#3112): a user component may `import` a SIBLING in its kit (`@/<sibling.src>` or a
//     relative path); the transitive closure of the siblings it imports is vendored into the build so it
//     resolves and the component composes real siblings instead of inlining everything. An internal
//     import that resolves to NO sibling still fails buildability (the honest empty state).
//
// The bootstrap imports the component and mounts it with sample props derived from its prop schema, so a
// component with required props still renders something representative (not a curated mock).
import { isLibrarySpec } from "@/shared/lib/graph/nodeUrn";
import { resolveInternalBase } from "@/shared/lib/preview/importPath";
import type { ComponentRecord, PropSpec } from "./model";

/**
 * Resolve a `@bsc/<segment>/<name>` LIBRARY import (#3116) to the preview module it vendors — a `path` the
 * import resolves to within the mem file set + the module `source` (an algorithm's reusable `code`) — or
 * `null` when it doesn't resolve. Param-injected so this pure module never imports the algorithms store; the
 * default (`libraryModuleResolver`) is wired at the call sites. Absent ⇒ no `@bsc/…` handling (byte-identical
 * to pre-#3116 for a component with no library imports).
 */
export type LibraryModuleResolver = (spec: string) => { path: string; source: string } | null;

/** The buildable slice of the packaged kit artifact — each component's verbatim `source` and the
 *  `runtime` (non-component @/ closure), both keyed by their `src/`-relative path. This is exactly the
 *  `source` + `runtime` the `react-ui.json` artifact carries (built by reactUiKit.gen, consumed by
 *  `bsc ui emit`); the frontend already bundles it. */
export interface KitArtifact {
  components: { id: string; src: string; source?: string }[];
  runtime?: Record<string, string>;
}

/** A KitArtifact carrying no bytes (#3859) — the packaged `react-ui.json` artifact is no longer imported
 *  under `src/features/designs/`: an app-graph record (`kitId === BASE_STUDIO_CODE_KIT_ID`) previews live
 *  through the runtime loader (`GraphComponent`), never through this esbuild path, and everything else
 *  (third-party / harvested / user-authored) is self-contained by construction — its `@/…` imports resolve
 *  via the registered platform module list + its own kit siblings, not an artifact closure. Callers that
 *  still take a `KitArtifact` param (the sandboxed-preview build) pass this so the parameter stays generic
 *  without reaching for the retired 5 MB file. */
export const EMPTY_ARTIFACT: KitArtifact = { components: [], runtime: {} };

/** The in-memory file set + entry handed to the esbuild bundler for one component's preview. */
export interface ComponentPreviewBuild {
  /** `src/`-relative path → source, PLUS the synthetic bootstrap entry (keyed {@link PREVIEW_ENTRY}). */
  files: Record<string, string>;
  /** The bootstrap entry's key in `files`. */
  entry: string;
}

/** The synthetic bootstrap entry that mounts the previewed component. */
export const PREVIEW_ENTRY = "__component_preview__.tsx";

/** Drop the `.ts`/`.tsx` extension from a `src/`-relative path so it reads as an import specifier. */
function stripExt(path: string): string {
  return path.replace(/\.(tsx|ts|jsx|js)$/, "");
}

// ── internal-import resolution (#3112) ─────────────────────────────────────────────────────────────
// Small twins of the graph_health scanners — kept LOCAL so componentPreview has no dependency on
// graphHealth (graphHealth imports THIS module). Behavior mirrors `importSpecifiers` /
// `isInternalSpecifier` / `resolveInternalBase` there and the Rust `graph_health.rs` twins. Used to
// vendor a user component's imported SIBLINGS into its preview build so it can compose real components.

/** Every module specifier imported/exported-from in `source` (`import … from "x"`, `import "x"`,
 *  `import("x")`), deduped. A loose regex scan — over-inclusion is harmless (callers only act on the
 *  ones that resolve to a sibling). */
function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const importRe = /\bimport\s*\(?\s*["']([^"']+)["']/g;
  while ((m = fromRe.exec(source))) specs.add(m[1]);
  while ((m = importRe.exec(source))) specs.add(m[1]);
  return [...specs];
}

/** Is `spec` an INTERNAL first-party import — a `@/…` alias or a RELATIVE (`./`, `../`) path — as
 *  opposed to a bare npm specifier or an absolute path/URL? Only these resolve against sibling modules. */
function isInternalSpec(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("./") || spec.startsWith("../");
}

/** A user component's own IMPLEMENTATION source — its explicit `source`, else a non-empty `srcText`
 *  (buildability is judged separately). `null` when the record carries neither. */
function ownImplSource(c: ComponentRecord): string | null {
  if (c.source && c.source.trim()) return c.source;
  if (c.srcText && c.srcText.trim()) return c.srcText;
  return null;
}

/** The code-elision marker: U+2026 HORIZONTAL ELLIPSIS. Named rather than inlined so there is ONE place
 *  an encoding round-trip can damage it, and `elisionMarkerIsU2026` asserts its code point — if a tool or
 *  an editor ever rewrites this file as cp1252, the test fails loudly instead of the scanner silently
 *  degrading into a no-op that reports every source as clean. */
const ELISION = "…";

/**
 * Does the code-elision marker appear in real CODE — not inside a string/template literal or a comment?
 * Only then does it stand in for omitted code. The TS twin of Rust `has_code_elision`
 * (bsc-component::graph_health), ported in #3486; the two must move together, because Rust's
 * `is_preview_buildable` deliberately matched whatever THIS file does so `doctor` can never be more
 * permissive than the preview it reports on.
 *
 * The plain substring test this replaced is a MEASURED false-positive generator, not a hypothetical one:
 * the marker is ordinary UI copy (a `placeholder` ending in one) and ordinary doc-comment prose, and
 * over this repo's own `src/shared/ui` it condemned 13 perfectly good components as sketches. Condemning
 * a real component over the ellipsis in its placeholder text is a false accusation someone then has to
 * overrule — so both contexts are skipped.
 */
export function hasCodeElision(src: string): boolean {
  const b = Array.from(src);
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c === "/" && b[i + 1] === "/") {
      while (i < n && b[i] !== "\n") i += 1;
    } else if (c === "/" && b[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(b[i] === "*" && b[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
    } else if (c === '"' || c === "'" || c === "`") {
      i += 1;
      // A backslash escapes the next char, so an escaped quote doesn't end the literal.
      while (i < n && b[i] !== c) i += b[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === ELISION) {
      // An ellipsis DIRECTLY after a word character is PROSE, not an elision marker (#3897). JSX TEXT
      // (`>Loading projects…</Text>`) is not quoted, so the string-skip above misses it — ProjectsPage read
      // as "a sketch, not compilable code" over three UI labels while the app mounted it fine. A real
      // marker sits in code position (`{ … }`, or alone on a line). Rust twin: `has_code_elision`.
      let j = i - 1;
      while (j >= 0 && /\s/.test(b[j])) j -= 1;
      if (j >= 0 && /[A-Za-z0-9]/.test(b[j])) { i += 1; continue; }
      return true;
    } else {
      i += 1;
    }
  }
  return false;
}

/**
 * Does `srcText` look like a self-contained, buildable component MODULE rather than a usage snippet?
 *
 * A component STORE record carries only `srcText` (the artifact-only `source` is stripped from the
 * store — it's a contract catalog, #2794). For most records that `srcText` is a usage snippet —
 * `import { X } from "@/…"; <X …/>` — which is NOT buildable here: its `@/` first-party imports have
 * no dependency closure to resolve against (only the built-in kit ships one), and its `…` placeholders
 * don't compile. A designer session CAN instead author a real, self-contained module into `srcText`
 * (importing only bare libraries, which resolve from esm.sh); that one previews.
 *
 * Heuristic (deliberately conservative — false-negative into the honest empty state, never a false
 * "buildable" that always throws): it must declare an `export` for the bootstrap to import, contain no
 * `…` placeholder, and use no `@/` first-party import.
 */
export function looksBuildableModule(srcText: string | undefined): boolean {
  const s = (srcText ?? "").trim();
  if (!s) return false;
  if (!/\bexport\b/.test(s)) return false; // no export ⇒ nothing for the bootstrap to import + mount
  if (hasCodeElision(s)) return false; // a `…` standing in for omitted CODE ⇒ won't compile (#3486)
  if (/["']@\//.test(s)) return false; // `@/` first-party import ⇒ no closure to resolve it against
  return true;
}

/**
 * Sibling-aware buildability (#3112): like {@link looksBuildableModule}, but an internal (`@/`, `./`)
 * import is allowed WHEN it resolves to a vendored sibling — the closure that lets a user-kit component
 * compose real siblings instead of inlining everything. `source` from module `fromRel`; `resolvesToSibling`
 * says whether an internal import spec lands on a sibling the preview will vendor. An internal import that
 * resolves to NOTHING still fails (the honest empty state); `…` placeholders and no-export still fail.
 */
export function isPreviewBuildable(
  source: string,
  fromRel: string,
  resolvesToSibling: (spec: string, fromRel: string) => boolean,
): boolean {
  const s = source.trim();
  if (!s) return false;
  if (!/\bexport\b/.test(s)) return false;
  if (hasCodeElision(s)) return false; // #3486: an ellipsis in COPY is not an elision marker
  for (const spec of importSpecs(s)) {
    if (isInternalSpec(spec) && !resolvesToSibling(spec, fromRel)) return false;
  }
  return true;
}

/** The data-state a preview renders in (#3135/#3555): `loaded` (demo/populated), `empty` (no data),
 *  `loading` (the component's loading/skeleton render), or `error` (its error render). Drives how
 *  {@link samplePropValue} fills props; {@link supportedStates} decides which a component actually has. */
export type PreviewState = "loaded" | "empty" | "loading" | "error";

/** Is `p` a LOADING-family boolean — the toggle that puts a component into its loading/skeleton render
 *  (`loading` / `busy` / `pending` / `isLoading`)? It's ON only in the `loading` state, off otherwise —
 *  fixing the old "every boolean samples to true" quirk that previewed loading-components as skeletons.
 *  Exported (#3191) so the on-visit scan gates its loading-state blank probe on the SAME predicate that
 *  drives the sampled prop, keeping the finding and the render in lockstep. */
export function isLoadingProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return (t === "boolean" || t.includes("boolean")) && /^(loading|busy|pending|isloading)$/i.test(p.name);
}

/** Is `p` a COLLECTION prop — an array of data (`Row[]`, `array`)? The thing `empty` empties. A collection
 *  is OMITTED in loaded/loading so the component's own demo/default shows (the demo-on-undefined convention,
 *  #3135/#3693 — required collections omit too now); `empty` always passes an explicit `[]`. Exported (#3191)
 *  so the scan gates its empty-state blank probe on the SAME predicate that empties the sampled collection. */
export function isCollectionProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return t.includes("[]") || t.includes("array");
}

/** Is `t` (a LOWERCASED type) a `Record<K, V>` map object — a data container whose empty literal is `{}`
 *  (distinct from an array's `[]`)? Rust twin: `is_record_type`. */
function isRecordType(t: string): boolean {
  return t.startsWith("record<");
}
/** Is `t` (LOWERCASED) a `Set<T>` / `ReadonlySet<T>`? Empty literal `new Set()`; the `set<` boundary (or an
 *  exact bare `set`) keeps `offset`/`dataset`/`subset` out. Rust twin: `is_set_type`. */
function isSetType(t: string): boolean {
  return t === "set" || t.startsWith("set<") || t.startsWith("readonlyset<");
}
/** Is `t` (LOWERCASED) a `Map<K, V>` / `ReadonlyMap<K, V>`? Empty literal `new Map()`. Rust twin: `is_map_type`. */
function isMapType(t: string): boolean {
  return t === "map" || t.startsWith("map<") || t.startsWith("readonlymap<");
}

/** Is `p` an ERROR-family prop — the thing that puts a component into its error render (`error` / `err` /
 *  `isError` / `hasError`)? Set only in the `error` state, omitted otherwise (#3555). A callback like
 *  `onError` is NOT one (it's a function, excluded by name shape). Exported so the scan/doctor gate the
 *  error-state on the SAME predicate that drives the sampled prop. */
export function isErrorProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  const isFn = t.includes("=>") || t.includes("function") || t.includes("void") || /^on[A-Z]/.test(p.name);
  return !isFn && /^(error|err|isError|hasError)$/i.test(p.name);
}

/**
 * A best-effort sample value (as a JS source literal) for a prop, from its (loosely-typed) schema, or
 * `null` to omit it. Enough to render a component whose required props would otherwise be missing —
 * NOT a curated example. `children` is handled by the caller (it becomes the element's child). `state`
 * (#3135) drives the data-state: `loading` turns on a loading-family boolean; `empty` passes the typed
 * EMPTY literal for a data container (`[]` array, `{}` Record, `new Set()`, `new Map()`); `loaded`
 * (default) / `loading` OMIT a container so a demo-on-undefined component shows its own default demo — the
 * same path object props (`gh`) already take. A required container omits too (#3693), not `[]`.
 */
export function samplePropValue(p: PropSpec, state: PreviewState = "loaded"): string | null {
  if (isLoadingProp(p)) return state === "loading" ? "true" : null;
  const t = (p.type || "").toLowerCase();
  const isFn = t.includes("=>") || t.includes("function") || t.includes("void") || /^on[A-Z]/.test(p.name);
  // #3555: an error-family prop is set ONLY in the error state — a boolean gets `true`, else a sample
  // message — and omitted otherwise so the component renders normally in loaded/loading/empty.
  if (isErrorProp(p)) {
    if (state !== "error") return null;
    return t === "boolean" || t.includes("boolean") ? "true" : JSON.stringify("Something went wrong");
  }
  if (isFn) return "() => {}";
  // Data-container props (#3693): omitted in loaded/loading so the component's own default demo shows; the
  // empty state passes the typed EMPTY literal. BEFORE the string/number branches — a `Record<string, number>`
  // / `Set<string>` type contains "string"/"number" and would otherwise sample as a title-cased string
  // (rendering `Object.values("Lang Totals")` NaN nonsense, or crashing `"Highlight".has(k)`). Required
  // containers omit too, exactly as the object-prop fall-through (`MergeQueue.gh`) already does.
  if (isCollectionProp(p)) return state === "empty" ? "[]" : null;
  if (isRecordType(t)) return state === "empty" ? "{}" : null;
  if (isSetType(t)) return state === "empty" ? "new Set()" : null;
  if (isMapType(t)) return state === "empty" ? "new Map()" : null;
  if (t.includes("reactnode") || t.includes("node")) return JSON.stringify(prettyName(p.name));
  if (t === "string" || t.includes("string")) return JSON.stringify(sampleString(p.name));
  if (t === "number" || t.includes("number")) return numberSample(p.name);
  if (t === "boolean" || t.includes("boolean")) return "true";
  // enum-like unions ("a" | "b") → the first literal.
  const firstLiteral = p.type.match(/"([^"]+)"/);
  if (firstLiteral) return JSON.stringify(firstLiteral[1]);
  return null;
}

/** A readable placeholder from a prop/component name (`whenUse` → "When use"). */
function prettyName(name: string): string {
  const s = name.replace(/([A-Z])/g, " $1").replace(/[-_]/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** A plausible string sample — a color token for color-ish props, a fraction hint elsewhere. */
function sampleString(name: string): string {
  if (/colou?r|tone|accent|fill|stroke/i.test(name)) return "var(--accent)";
  if (/login|user|author/i.test(name)) return "octocat";
  return prettyName(name);
}
/** A number sample (as a JS source expression, evaluated in the preview iframe). CANVAS-dimension props
 *  (width/height/size) sample with the actual preview FRAME size (`window.innerWidth`/`innerHeight`) so a
 *  sized component — a d3 chart/graph — fills the frame at its orientation instead of the old 3px
 *  placeholder that rendered it as a tiny sample (#2918). STYLE dimensions (stroke/border/font/line
 *  width, gaps, spacing) are guarded out — they are not canvas sizes and must stay small. Everything else
 *  keeps the prior behavior: a 0–1 fraction for ratio-ish names, else a small integer. */
function numberSample(name: string): string {
  const n = name.toLowerCase();
  // Exclude style dimensions so `strokeWidth`/`borderWidth`/`fontSize`/… never become the viewport size.
  const styleDim = /stroke|border|font|line|gap|margin|pad|spacing|weight|gutter|inset|offset/.test(n);
  // A LAYOUT-COLUMN width/height (a fixed sidebar/rail/panel column, flex:none) must NOT be the viewport
  // size — that makes the column eat the whole preview frame (#3693). A fixed 240px keeps two-column layouts
  // intact; a canvas width (`width`/`w`/`chartWidth`) still fills the frame below.
  const layoutDim = /rail|aside|sidebar|drawer|panel|col/.test(n);
  if (!styleDim) {
    const isW = n === "w" || n === "width" || n.endsWith("width");
    const isH = n === "h" || n === "height" || n.endsWith("height");
    if (layoutDim && (isW || isH)) return "240";
    if (isW) return "window.innerWidth";
    if (isH) return "window.innerHeight";
    if (n === "size" || n === "extent") return "Math.min(window.innerWidth, window.innerHeight)";
  }
  return /value|fraction|ratio|progress|percent|opacity/i.test(name) ? "0.6" : "3";
}

/** One sampled prop the preview harness passes: its `name` and its VALUE as a JS-source
 *  literal/expression — exactly what {@link samplePropValue} returns (e.g. `"() => {}"`,
 *  `"window.innerWidth"`, `"\"Label\""`). NOT a JSON value: it's source the iframe evaluates. */
export interface PreviewProp {
  name: string;
  value: string;
}

/** The props (+ their sampled JS-source values) and the child text the bootstrap passes a component in
 *  ONE state — the inspectable form of what {@link bootstrapSource} mounts. `children` is excluded from
 *  `props` (it becomes the element child, carried in `child`). */
export interface PreviewProps {
  props: PreviewProp[];
  child: string | null;
}

/** The props the bootstrap passes `comp` in `state` — each non-`children` prop that samples to a
 *  non-`null` value, in `comp.props` (schema) order. The structured twin of the object literal
 *  {@link bootstrapSource} builds; `bsc ui preview-props` mirrors it (a shared parity fixture pins them). */
export function previewPropList(comp: ComponentRecord, state: PreviewState = "loaded"): PreviewProp[] {
  const out: PreviewProp[] = [];
  for (const p of comp.props) {
    if (p.name === "children") continue;
    const v = samplePropValue(p, state);
    if (v != null) out.push({ name: p.name, value: v });
  }
  return out;
}

/** The child text the bootstrap passes when `comp` declares a `children` prop
 *  (`JSON.stringify(prettyName(name))`), else `null`. State-independent (children never varies by state). */
export function previewChild(comp: ComponentRecord): string | null {
  return comp.props.some((p) => p.name === "children") ? JSON.stringify(prettyName(comp.name)) : null;
}

/** The inspectable props the preview harness passes `comp` in each data-state (#3165) — exactly what
 *  {@link bootstrapSource} mounts, per state. The `bsc ui preview-props` verb replicates this in Rust; a
 *  shared JSON fixture (`previewProps.fixtures.json`) is asserted on BOTH sides to keep them in lockstep.
 *  Covers the original three states only — `error` (#3555) renders via {@link bootstrapSource}'s per-state
 *  path but is NOT part of this cross-language wire contract. */
export function previewProps(comp: ComponentRecord): Record<Exclude<PreviewState, "error">, PreviewProps> {
  const child = previewChild(comp);
  return {
    loaded: { props: previewPropList(comp, "loaded"), child },
    empty: { props: previewPropList(comp, "empty"), child },
    loading: { props: previewPropList(comp, "loading"), child },
  };
}

/**
 * The data-states `comp` MEANINGFULLY supports (#3555), in natural display order — `loading` (has a
 * loading-family prop) → `loaded` (always) → `empty` (has a collection prop) → `error` (has an
 * error-family prop). The single source of truth for "which states does this component have": the state
 * switcher offers exactly these, and {@link previewCycleStates} derives the auto-cycle from them. A plain
 * component with none of those props returns just `["loaded"]` (no state tabs, no cycling — "not all
 * components need them").
 */
export function supportedStates(comp: ComponentRecord): PreviewState[] {
  const has = (pred: (p: PropSpec) => boolean) => comp.props.some(pred);
  const states: PreviewState[] = [];
  if (has(isLoadingProp)) states.push("loading");
  states.push("loaded");
  if (has(isCollectionProp)) states.push("empty");
  if (has(isErrorProp)) states.push("error");
  return states;
}

/** The states the SMALL preview auto-cycles through (#3555): {@link supportedStates} minus `empty` (it
 *  often reads bare — it stays reachable in the expanded try-on + doctor). So a fully-stated component
 *  cycles loading → loaded → error. A component with only `loaded` yields `["loaded"]` → nothing to cycle. */
export function previewCycleStates(comp: ComponentRecord): PreviewState[] {
  return supportedStates(comp).filter((s) => s !== "empty");
}

/**
 * The bootstrap entry source: import the component by `importSpec` and mount it into `#root` with the
 * sample props. Uses `createElement` (not JSX children) so children/props compose without JSX parsing
 * quirks. Resolves the component export by `name`, falling back to the default export. Builds the props
 * from {@link previewPropList} / {@link previewChild} (the SAME source `bsc ui preview-props` inspects).
 */
/** The props object-literal (JS source) `comp` is mounted with in `state`: the sampled props (schema
 *  order), then any resolved preview-data OVERRIDES layered on top (#2940) — a bound prop renders the
 *  algorithm-generated dataset instead of its trivial sample, and a bound prop the sampler OMITTED (an
 *  optional collection) is added. `previewPropList` stays pure, so the Rust parity fixture is unaffected. */
function statePropsLiteral(comp: ComponentRecord, state: PreviewState, previewData: Record<string, string>): string {
  const byName = new Map(previewPropList(comp, state).map((e) => [e.name, e.value] as const));
  for (const [name, value] of Object.entries(previewData)) {
    if (name !== "children") byName.set(name, value);
  }
  return `{ ${[...byName].map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(", ")} }`;
}

export function bootstrapSource(
  comp: ComponentRecord,
  importSpec: string,
  state: PreviewState = "loaded",
  previewData: Record<string, string> = {},
  liveStates?: PreviewState[],
): string {
  const childText = previewChild(comp);
  const childArg = childText ? `, ${childText}` : "";
  // Role-aware mount wrapper (#3139). A PAGE/LAYOUT is authored for a full viewport (flex:1 / height:100%),
  // so it gets a full-bleed, TOP-LEFT wrapper (no centering, no padding) — its header sits at the top and
  // it fills the natural canvas the frame then scales to fit. A component keeps the centered, padded
  // wrapper so an intrinsic-size primitive reads well. (`height:100%`, not minHeight, so the srcdoc's
  // `max-height:100%` media cap (#2915) resolves.)
  const pageLike = comp.role === "page" || comp.role === "layout";
  const wrapStyle = pageLike
    ? `{ height: "100%", width: "100%", boxSizing: "border-box", overflow: "hidden" }`
    : `{ padding: 20, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }`;
  const head = [
    `import { createRoot } from "react-dom/client";`,
    `import { createElement } from "react";`,
    `import * as __mod from "${importSpec}";`,
    `const __C = __mod[${JSON.stringify(comp.name)}] ?? __mod.default;`,
    `if (!__C) throw new Error("preview: no export ${comp.name} (or default) in ${importSpec}");`,
  ];

  // #3567: LIVE-STATE form — embed EVERY state's props once and switch on a `{ __state }` message with a
  // React re-render, NOT a rebuild. The compiled bundle is identical across states (only props differ), so
  // the small preview's auto-cycle (#3555) becomes an instant re-render instead of an esbuild + reload +
  // "building" flash. `null`-guarded so an unknown/missing state falls back to the initial.
  if (liveStates && liveStates.length) {
    const initial = liveStates.includes(state) ? state : liveStates[0];
    const statesLiteral = liveStates
      .map((s) => `${JSON.stringify(s)}: ${statePropsLiteral(comp, s, previewData)}`)
      .join(", ");
    return [
      ...head,
      `const __STATES = { ${statesLiteral} };`,
      `let __state = ${JSON.stringify(initial)};`,
      `const __root = createRoot(document.getElementById("root"));`,
      `function __render(){ __root.render(createElement("div", { style: ${wrapStyle} }, createElement(__C, __STATES[__state] || {}${childArg}))); }`,
      `__render();`,
      `window.addEventListener("message", function (e) { var s = e && e.data && e.data.__state; if (typeof s === "string" && __STATES[s]) { __state = s; __render(); } });`,
      "",
    ].join("\n");
  }

  // Single-state form (the on-visit scan, one state per build — byte-unchanged from before #3567).
  return [
    ...head,
    `createRoot(document.getElementById("root")).render(`,
    `  createElement("div", { style: ${wrapStyle} },`,
    `    createElement(__C, ${statePropsLiteral(comp, state, previewData)}${childArg})));`,
    "",
  ].join("\n");
}

/**
 * Assemble the buildable files + entry for `comp`'s preview, or `null` when there's no buildable source.
 *
 * BUILT-IN (its `src` is in `artifact` with a `source`): hand esbuild the artifact's whole component +
 * `runtime` set (keyed by `src/`-relative path) so `@/…` imports resolve; the entry imports the target
 * via its `@/…` spec. USER-AUTHORED (not in the artifact): its self-contained implementation source —
 * `comp.source` when present, ELSE a `comp.srcText` that {@link looksBuildableModule} — placed at
 * `comp.src` (or a synthetic path) and imported by the entry. A usage-snippet `srcText` yields `null`
 * (the honest empty state).
 *
 * `siblings` (#3112): the OTHER user components in `comp`'s kit. A user component may `import` a sibling
 * (`@/<sibling.src>` or a relative path) — the transitive closure of the siblings it actually imports is
 * VENDORED into the file set (keyed by each sibling's `src`), so a user-kit component can compose real
 * siblings instead of inlining everything. Buildability is then sibling-aware ({@link isPreviewBuildable}):
 * an internal import that resolves to a vendored sibling is allowed; one that resolves to nothing still
 * yields `null`. Omit `siblings` for the pre-#3112 single-module behavior (any `@/` import ⇒ not buildable).
 */
export function componentPreviewFiles(
  comp: ComponentRecord,
  artifact: KitArtifact,
  siblings: readonly ComponentRecord[] = [],
  libResolver?: LibraryModuleResolver,
  state: PreviewState = "loaded",
  previewData: Record<string, string> = {},
  liveStates?: PreviewState[],
): ComponentPreviewBuild | null {
  const inArtifact = comp.src ? artifact.components.find((c) => c.src === comp.src && c.source) : undefined;

  if (inArtifact) {
    const files: Record<string, string> = {};
    for (const [path, src] of Object.entries(artifact.runtime ?? {})) files[path] = src;
    for (const c of artifact.components) if (c.source) files[c.src] = c.source;
    vendorLibraryModules(files, libResolver); // #3116: any `@bsc/…` a built-in references
    const importSpec = `@/${stripExt(inArtifact.src)}`;
    files[PREVIEW_ENTRY] = bootstrapSource(comp, importSpec, state, previewData, liveStates);
    return { files, entry: PREVIEW_ENTRY };
  }

  // User-authored: build from its own implementation source — the explicit `source` when present, else
  // the `srcText`. An explicit `source` is trusted; a `srcText` must look like a real module (#2828).
  const explicitSource = comp.source && comp.source.trim() ? comp.source : null;
  const userSource = explicitSource ?? (comp.srcText && comp.srcText.trim() ? comp.srcText : null);
  if (userSource === null) return null;
  const path = comp.src?.trim() ? comp.src : `user/${comp.id || "component"}.tsx`;

  // #43/#3660: resolve `@/…` imports the way the RUNTIME loader does, so a graph-source primitive (a
  // `provides` component migrated from the app, #3604) BUILDS instead of falsely reporting no-implementation.
  // Three resolution tiers, keyed by the import SPECIFIER (which also sidesteps the `src/`-prefix mismatch a
  // sibling's `src` path carries):
  //   (b) the packaged artifact's built-in sources + runtime closure — the app's real modules, seeded first;
  //   (a) a graph component whose `provides` EQUALS the specifier — its source, seeded AFTER (graph-first
  //       wins, #3660), keyed at the specifier's mem path so `@/X` resolves to it;
  //   (c) a sibling user component by `src` base (the pre-#3112 path).
  const files: Record<string, string> = {};
  for (const [p, src] of Object.entries(artifact.runtime ?? {})) files[p] = src; // (b) runtime closure
  for (const c of artifact.components) if (c.source) files[c.src] = c.source;     // (b) built-in sources
  const artifactBases = new Set(Object.keys(files).map(stripExt));

  // (a) `provides` — a `@/X` specifier → a graph-source component's module, keyed at the mem path for `X`.
  const providesMod = new Map<string, string>(); // `${base}.tsx` → source
  const providesSpecs = new Set<string>();        // the `@/…` specifiers the graph provides
  for (const s of [comp, ...siblings]) {
    const spec = s.provides?.trim();
    const impl = ownImplSource(s);
    const base = spec ? resolveInternalBase(spec, "") : null;
    if (!spec || !impl || base === null) continue;
    providesSpecs.add(spec);
    providesMod.set(`${base}.tsx`, impl);
  }

  // (c) sibling user components keyed by their import BASE (`src` minus extension).
  const sibByBase = new Map<string, { src: string; source: string }>();
  for (const s of siblings) {
    if (s.id === comp.id) continue;
    const source = ownImplSource(s);
    const sp = s.src?.trim();
    if (source && sp) sibByBase.set(stripExt(sp), { src: sp, source });
  }

  const resolvesInternal = (spec: string, fromRel: string): boolean => {
    if (providesSpecs.has(spec)) return true; // (a) exact `provides` match
    const base = resolveInternalBase(spec, fromRel);
    return base !== null && (artifactBases.has(base) || providesMod.has(`${base}.tsx`) || sibByBase.has(base)); // (b)/(a)/(c)
  };

  // Buildable? An explicit `source` is trusted; a `srcText` must be a module whose internal imports all
  // resolve (provides / artifact / sibling). `looksBuildableModule` (no `@/` at all) is the fallback when
  // there is nothing to resolve against.
  const canResolveInternal = providesMod.size > 0 || sibByBase.size > 0 || artifactBases.size > 0;
  const buildable = explicitSource !== null
    || (canResolveInternal ? isPreviewBuildable(userSource, path, resolvesInternal) : looksBuildableModule(userSource));
  if (!buildable) return null;

  // Seed the graph-first `provides` overrides (they win over the artifact built-in of the same path), the
  // target's own source, then the transitive closure of SIBLING imports (artifact + provides modules are
  // already seeded; esbuild tree-shakes the unreached).
  for (const [key, src] of providesMod) files[key] = src;
  files[path] = userSource;
  const seenBase = new Set<string>([stripExt(path)]);
  const queue: Array<{ source: string; fromRel: string }> = [{ source: userSource, fromRel: path }];
  while (queue.length) {
    const { source, fromRel } = queue.shift()!;
    for (const spec of importSpecs(source)) {
      const base = resolveInternalBase(spec, fromRel);
      if (base === null || seenBase.has(base)) continue;
      const mod = sibByBase.get(base);
      if (!mod) continue;
      seenBase.add(base);
      files[mod.src] = mod.source;
      queue.push({ source: mod.source, fromRel: mod.src });
    }
  }
  vendorLibraryModules(files, libResolver); // #3116: vendor any `@bsc/…` library imports (recursively)
  files[PREVIEW_ENTRY] = bootstrapSource(comp, `@/${stripExt(path)}`, state, previewData, liveStates);
  return { files, entry: PREVIEW_ENTRY };
}

/**
 * Vendor every `@bsc/<segment>/<name>` LIBRARY import reachable from the current `files` (#3116) — resolve
 * each via `libResolver` and add its module `source` at the `path` the import resolves to, recursing into a
 * vendored module's own library imports (an algorithm that `import`s another). Mutates `files` in place.
 * A no-op when `libResolver` is absent or nothing imports `@bsc/…` — so a component with no library imports
 * yields a byte-identical file set to pre-#3116. A spec that doesn't resolve is simply not added (the build
 * then fails "module not found" — the honest unresolvable-import surface, mirrored in graphHealth).
 */
function vendorLibraryModules(files: Record<string, string>, libResolver?: LibraryModuleResolver): void {
  if (!libResolver) return;
  const seenSpec = new Set<string>();
  const queue: string[] = Object.values(files);
  while (queue.length) {
    const source = queue.shift()!;
    for (const spec of importSpecs(source)) {
      if (!isLibrarySpec(spec) || seenSpec.has(spec)) continue;
      seenSpec.add(spec);
      const mod = libResolver(spec);
      if (!mod || mod.path in files) continue;
      files[mod.path] = mod.source;
      queue.push(mod.source);
    }
  }
}
