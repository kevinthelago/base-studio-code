// Design-graph health — the pure TS mirror of the `bsc components doctor` analyzer (Rust `bsc-component`
// crate, #2678/#2679), used to badge dead/duplicated nodes in the Designs composition graph (#2680,
// epic #2677). Same taxonomy, same rules; operates on ONE kit's components (the Design Studio already
// scopes `kitComps` to the active kit, and `composes` edges only resolve within a kit).
//
// Findings, most-severe first: cycle (a `composes` loop) · dangling-composes-reference (a `composes` entry
// naming no component in the kit — the edge is silently dropped, so the graph reads as complete while the
// reference names nothing, #89) · dangling-branch (an unused root that still
// pulls in dependencies) · duplicate (same `wraps` intrinsic, or identical source) · no-implementation
// (a component the preview can't build — a spec, not code) · self-reference (an own-module component
// whose only rendered element is itself, <Name/> — a self-referential stub that passes the buildability
// + syntax gates yet produces no output, #3026) · unresolvable-import (a module imports
// something the preview can't resolve: a bare npm package not in the import-map (#2934) OR an internal
// `@/…`/relative import matching no kit component or runtime module (#2954) — throws at preview time) ·
// reimplementation (an own-source component that DECLARES a symbol re-coding a node that already exists in
// the library — an inline `function fibonacci` while `@bsc/algorithms/fibonacci` exists — instead of
// importing it; the "compose, don't recreate" guardrail, #3118) ·
// orphan (isolated, never-
// referenced primitive/composite) · unwired-prop (declares props its own source never references — a
// declared interface that does nothing, #2924) · props-metadata-mismatch (the record's `props` disagrees
// with the prop signature its own source declares — an EMPTY `props: []` on a component with a real typed
// signature silently disables the preview's sample-data synthesizer, #88) · skips-family-shell (a member
// of a folder/name-suffix family that does NOT compose the shell primitive nearly all its siblings do — a
// REPORT, not a rule, #87) · phantom-compose (a user component declares `composes`
// children its own source never renders — a false graph edge that also masks orphan detection, #3111) ·
// slot-shell (INFORMATIONAL — a composite whose composed children arrive via ReactNode content slots, so
// a standalone preview renders a demo placeholder, #2921).
// "Unused" = no composer AND used === 0; a page/layout with used > 0 is a legit entry point, never flagged.
//
// Two categories — empty-empty-state / empty-loading-state (#3191) — are RUNTIME-only: they are in the
// HealthCategory union (with a severity + a badge) but are NOT produced here; the on-visit iframe scan
// (componentScan.ts) render-confirms a blank empty/loading state and folds them into the graph badges.
//
// The no-implementation check reuses the EXACT preview logic (`componentPreviewFiles`, #2824/#2828):
// the store strips a built-in's artifact `source` (#2794), so a built-in still builds from the packaged
// artifact — only a node in NEITHER the artifact NOR carrying its own module/`source` is flagged.
import reactUiArtifact from "@data/components/react-ui.json";
import previewImportmap from "@data/ui/preview-importmap.json";
import { buildComposesEdges } from "@/features/designs/lib/compositionLayout";
import { componentBuildable, looksBuildableModule, isPreviewBuildable, hasCodeElision, erasedSpecs, type KitArtifact } from "./componentPreview";
import { libraryModuleResolver, libraryReimplTargets } from "@/features/designs/lib/libraryModules";
import type { LibraryModuleResolver } from "./componentPreview";
import { isLibrarySpec } from "@/shared/lib/graph/nodeUrn";
import { resolveInternalBase } from "@/shared/lib/preview/importPath";
import { PLATFORM_MODULES as PLATFORM_MODULE_SPECS } from "@/shared/lib/preview/platformModules";
import type { ComponentRecord, PropSpec } from "@/features/designs/lib/model";
import type { KitAnimation } from "@/shared/ui/kit/animations";

/** The specifiers the preview iframe can resolve — the exact keys of the preview import-map (react/three/
 *  d3/lucide-react/…). A bare import not in this set throws "Failed to resolve module specifier" at
 *  preview time (#2934). Kept in lockstep with the Rust twin (which embeds the SAME json). */
const RESOLVABLE_SPECIFIERS = new Set(Object.keys(previewImportmap));

/** The specifiers the runtime module REGISTRY resolves (#3897) — the second half of the declared
 *  boundary, now shared with the preview it reports on (`shared/lib/preview/platformModules`).
 *
 *  Without this the buildability check resolved `@/…` against the packaged artifact and sibling node `src`
 *  paths ONLY, so a record honestly importing a registered platform module
 *  (`@/shared/lib/security/consoleModel`) matched neither and read as `no-implementation` — while the app
 *  mounted it fine. Worse, the finding pressured the next author to STUB the import to silence it, which is
 *  the corruption `reimplemented-component` exists to catch (#3892/#3895). Matched LITERALLY, exactly as
 *  the loader's `isAppModule` does. Rust twin embeds the same json. */
const PLATFORM_MODULES = PLATFORM_MODULE_SPECS;

/** Is `p` a CONTENT-SLOT prop — a non-`children` prop typed as a React node? Matches how the preview
 *  samples props (`samplePropValue` treats any `reactnode`/`node`-typed prop as a slot), so a component
 *  with one renders a placeholder standalone. `children` is universal and excluded (#2921). */
function isNodeSlotProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return p.name !== "children" && (t.includes("reactnode") || t.includes("node"));
}

/** Is `p` a COLLECTION/data prop — an array (`Row[]`, `array`)? Data components take one; the preview's
 *  empty/loading state switch (#3135) is expected of them. Mirrors `isCollectionProp` (componentPreview.ts). */
function isCollectionProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return t.includes("[]") || t.includes("array");
}

/** Is `p` a LOADING-family boolean (`loading`/`busy`/`pending`/`isLoading`)? A data component with one can
 *  preview its loading/skeleton render (#3135). Mirrors `isLoadingProp` (componentPreview.ts). */
function isLoadingProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return (t === "boolean" || t.includes("boolean")) && /^(loading|busy|pending|isloading)$/i.test(p.name);
}

/** Is `p` an ERROR-family prop (`error`/`err`/`isError`/`hasError`, non-function)? A data component with one
 *  can preview its error render (#3555). Mirrors `isErrorProp` (componentPreview.ts). */
function isErrorProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  const isFn = t.includes("=>") || t.includes("function") || t.includes("void");
  return !isFn && /^(error|err|isError|hasError)$/i.test(p.name);
}

/** Is `p` an ACTION prop — an event/callback the component fires (`onClick`/`onChange`/…: name starts
 *  with `on` + a function type)? Its presence marks the component INTERACTIVE, so `no-analytics` (#3810)
 *  expects an events manifest and `no-tests` (#3878) expects tests. Mirrors `is_action_prop`
 *  (graph_health.rs).
 *
 *  Exported (#3884) so the inspector's Tests tab reads "interactive ⇒ untested is a gap" from the SAME
 *  predicate the finding uses. A second copy in the UI would drift from the check it claims to explain. */
export function isActionProp(p: PropSpec): boolean {
  const t = (p.type || "").toLowerCase();
  return p.name.length > 2 && p.name.toLowerCase().startsWith("on") && t.includes("=>");
}

/** The component's OWN module source (a user-authored module) — its record `source`, else a `srcText`
 *  that {@link looksBuildableModule} — or `null` when the source isn't in the record: a built-in (its
 *  artifact `source` is stripped from the store, #2794) or a spec (no buildable module). Only these have
 *  a source we can scan for prop references. Mirrors `componentPreviewFiles`'s user-authored source pick.
 *
 *  `siblings` (#3112): the kit's other components. A `srcText` that imports SIBLINGS is a real module too
 *  (the preview vendors them) — sibling-aware buildability keeps this in lockstep with the preview build,
 *  so the health checks scan exactly the source the preview compiles. */
function ownModuleSource(c: ComponentRecord, siblings: readonly ComponentRecord[] = []): string | null {
  // #4130: memoized per (siblings identity, record). `analyzeGraphHealth` asks the SAME question in five
  // separate check loops, and the sibling-aware branch below rebuilds two ~750-entry Sets every time —
  // roughly a million Set insertions per analysis on the real kit. Pure in its inputs, so caching the
  // answer is exact; the entry dies with the array (and the record) it keys.
  let per = ownSourceMemo.get(siblings);
  if (!per) ownSourceMemo.set(siblings, (per = new WeakMap()));
  const hit = per.get(c);
  if (hit !== undefined) return hit;
  const val = computeOwnModuleSource(c, siblings);
  per.set(c, val);
  return val;
}

const ownSourceMemo = new WeakMap<readonly ComponentRecord[], WeakMap<ComponentRecord, string | null>>();

/** {@link ownModuleSource} without the memo — the original derivation. */
function computeOwnModuleSource(c: ComponentRecord, siblings: readonly ComponentRecord[]): string | null {
  if (c.source && c.source.trim()) return c.source;
  const srcText = c.srcText ?? "";
  if (!srcText.trim()) return null;
  if (siblings.length) {
    // Resolve `@/` the way `componentPreviewFiles` does (#43/#3660): a graph `provides` specifier, the
    // packaged artifact runtime/built-ins, OR a sibling `src` base — so a graph-source primitive that
    // composes siblings + app utilities is scanned as the real module it is (lockstep with the build).
    const providesSpecs = new Set([c, ...siblings].map((s) => s.provides?.trim()).filter(Boolean) as string[]);
    // `@/components/<node-id>` is the loader's SIBLING-BY-ID form (#3897) — how a migrated page pulls in
    // its panels. Injected as a synthetic target so the ordinary resolver finds it.
    const sibTargets = new Set([
      ...siblings.filter((s) => s.id !== c.id).map((s) => s.src).filter(Boolean),
      ...siblings.map((s) => `components/${s.id}.tsx`),
    ]);
    const resolves = (spec: string, fromRel: string): boolean =>
      PLATFORM_MODULES.has(spec) || providesSpecs.has(spec)
      || resolvesInternal(spec, fromRel, sibTargets) || resolvesInternal(spec, fromRel, INTERNAL_TARGETS);
    return isPreviewBuildable(srcText, c.src, resolves) ? srcText : null;
  }
  return looksBuildableModule(srcText) ? srcText : null;
}

/** Escape a string for literal use inside a RegExp (component names are identifiers, but be safe). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `source` DECLARE the symbol `name` — a `function`/`const`/`let`/`var`/`class` binding of it — as
 *  opposed to a bare reference? Distinguishes a module that DEFINES the component from a usage snippet.
 *  Rust twin: `declares_symbol`. */
function declaresSymbol(source: string, name: string): boolean {
  return new RegExp(`\\b(?:function|const|let|var|class)\\s+${escapeRe(name)}\\b`).test(source);
}

/** Is `name` a plain JS identifier — the case {@link declaredSymbols} can answer by lookup? */
const PLAIN_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Every IDENTIFIER declared at `function`/`const`/`let`/`var`/`class` in `source` — ONE scan (#4130).
 *
 *  {@link declaresSymbol} compiles a fresh RegExp per candidate name, which the two "compose, don't
 *  recreate" checks did once per (component × candidate): 248 × 248 = 61k regex constructions over full
 *  source text on the real kit. Scanning once and testing set membership is the SAME predicate for any
 *  plain-identifier name; a name that is not one (a display name carrying a space) falls back to
 *  `declaresSymbol`, so the verdict is unchanged either way. */
function declaredSymbols(source: string): Set<string> {
  const set = new Set<string>();
  const re = /\b(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) set.add(m[1]);
  return set;
}

/** {@link declaresSymbol} bound to ONE source, answered from its {@link declaredSymbols} index. */
function declaresFrom(source: string): (name: string) => boolean {
  const declared = declaredSymbols(source);
  return (name) => (PLAIN_IDENT.test(name) ? declared.has(name) : declaresSymbol(source, name));
}

/** The set of JSX element/component tag names OPENED in `source` — every `<Ident` that is not a closing
 *  `</…` tag. (A TS generic like `<Number>` lands here too, only making the self-reference check more
 *  conservative.) Rust twin: `jsx_tag_names`. */
function jsxTagNames(source: string): Set<string> {
  const set = new Set<string>();
  const re = /<([A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) set.add(m[1]);
  return set;
}

/** Is `c` a SELF-REFERENTIAL STUB — an own-module component that declares its own name yet the ONLY
 *  element it renders is itself (`<Name/>`)? It passes the buildability + syntax gates but produces no
 *  output and recurses forever (#3026). Rust twin: `is_self_referential_stub`. */
function isSelfReferentialStub(c: ComponentRecord, siblings: readonly ComponentRecord[] = []): boolean {
  const src = ownModuleSource(c, siblings);
  if (!src || !c.name || !declaresSymbol(src, c.name)) return false;
  const tags = jsxTagNames(src);
  return tags.size === 1 && tags.has(c.name);
}

/** Does `source` reference `name` as a whole identifier (not a substring of a longer name)? The TS twin of
 *  the Rust `contains_word` — word chars are `[A-Za-z0-9_]`, kept in lockstep (#2924). */
function referencesIdentifier(source: string, name: string): boolean {
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  let from = 0;
  for (;;) {
    const at = source.indexOf(name, from);
    if (at < 0) return false;
    const beforeOk = at === 0 || !isWord(source[at - 1]);
    const afterIdx = at + name.length;
    const afterOk = afterIdx >= source.length || !isWord(source[afterIdx]);
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

/** `src` with every COMMENT and every string/template-literal BODY blanked to spaces — the substrate the
 *  prop-signature parser below scans. Length- and newline-preserving, so column-0 detection still works and
 *  every later scan is plain bracket-depth counting: a `,` inside a JSDoc block, a trailing `// note`, or a
 *  default value like `{ sep = "," }` can no longer split a parameter list.
 *
 *  Two guards keep prose from eating real code, because over-blanking is the one way this could invent a
 *  finding rather than miss one: a `'`/`"` is only a delimiter when it does NOT immediately follow a value
 *  end (so the apostrophe in a JSX `don't` or `</b>'s` is not a string opener), and a `'`/`"` literal that
 *  reaches a newline before its closer is prose rather than a string. Rust twin: `blank_code`. */
function blankCode(src: string): string {
  const out = [...src];
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let k = Math.max(from, 0); k < Math.min(to, n); k++) if (out[k] !== "\n") out[k] = " ";
  };
  const isValueEnd = (ch: string) => /[A-Za-z0-9_$)\]}]/.test(ch);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      blank(start, i);
    } else if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i + 1 < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      blank(start, i);
    } else if (c === '"' || c === "'" || c === "`") {
      // Adjacency is the whole rule: a quote pressed against a value end is prose, not a literal. A
      // BACKTICK is exempt — pressed against a name it is a tagged template, which really is a literal.
      const prose = i > 0 && c !== "`" && (isValueEnd(src[i - 1]) || (src[i - 1] === ">" && src[i - 2] !== "="));
      if (prose) { i++; continue; }
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "\n" && c !== "`") break; // only a template may span lines
        if (src[j] === c) { closed = true; break; }
        j++;
      }
      if (!closed) { i++; continue; }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/** The index of the bracket closing the one at `openAt` (`(`, `[` or `{`), counting only that pair — safe
 *  on the blanked source, where no literal can contribute a stray bracket. Rust twin: `matching_bracket`. */
function matchingBracket(b: string, openAt: number): number {
  const close = { "(": ")", "[": "]", "{": "}" }[b[openAt]];
  if (!close) return -1;
  let depth = 0;
  for (let i = openAt; i < b.length; i++) {
    if (b[i] === b[openAt]) depth++;
    else if (b[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** `b`'s first non-whitespace index at or after `from` (or `b.length`). Rust twin: `skip_ws`. */
function skipWs(b: string, from: number): number {
  let i = from;
  while (i < b.length && /\s/.test(b[i])) i++;
  return i;
}

/** The JS identifier starting at `from` (empty when there isn't one) and the index just past it. Rust
 *  twin: `ident_at`. */
function identAt(b: string, from: number): [string, number] {
  if (from >= b.length || !/[A-Za-z_$]/.test(b[from])) return ["", from];
  let i = from;
  while (i < b.length && /[A-Za-z0-9_$]/.test(b[i])) i++;
  return [b.slice(from, i), i];
}

/** Split `b` on `sep` at bracket depth 0 (`(`/`[`/`{` counted). Rust twin: `split_top_level`. */
function splitTopLevel(b: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) { out.push(b.slice(start, i)); start = i + 1; }
  }
  out.push(b.slice(start));
  return out;
}

/** The PARAMETER-LIST text of the top-level declaration of component `name` in the blanked source `b` — the
 *  chars between its outer parens. `null` when there is no unambiguous column-0 `function name(` /
 *  `const name = (` / `const name = function (` form (with or without `export`/`export default`/`async` and
 *  a generic list), which is the conservative outcome: an exotic wrapper like `const X = memo((…) => …)` is
 *  left alone rather than guessed at. Rust twin: `decl_params`. */
function declParams(b: string, name: string): string | null {
  for (let lineStart = 0; lineStart < b.length; ) {
    const nl = b.indexOf("\n", lineStart);
    const nextLine = nl < 0 ? b.length : nl + 1;
    if (/\s/.test(b[lineStart])) { lineStart = nextLine; continue; } // column 0 only
    let i = lineStart;
    for (const kw of ["export ", "default ", "async "]) if (b.startsWith(kw, i)) i = skipWs(b, i + kw.length);
    const isFn = b.startsWith("function ", i);
    const binding = ["const ", "let ", "var "].find((kw) => b.startsWith(kw, i));
    if (!isFn && !binding) { lineStart = nextLine; continue; }
    i = skipWs(b, i + (isFn ? "function".length : binding!.length - 1));
    if (b[i] === "*") i = skipWs(b, i + 1); // `function* Gen(`
    const [found, after] = identAt(b, i);
    if (found !== name) { lineStart = nextLine; continue; }
    return isFn ? fnParams(b, after) : bindingParams(b, after);
  }
  return null;
}

/** The parameter list of a `function name…` whose name ends at `after` — skipping a generic list. */
function fnParams(b: string, after: number): string | null {
  let i = skipWs(b, after);
  if (b[i] === "<") {
    let depth = 0;
    while (i < b.length) {
      if (b[i] === "<") depth++;
      else if (b[i] === ">" && --depth === 0) { i++; break; }
      i++;
    }
    i = skipWs(b, i);
  }
  if (b[i] !== "(") return null;
  const close = matchingBracket(b, i);
  return close < 0 ? null : b.slice(i + 1, close);
}

/** The parameter list of a `const name … = <fn>` binding whose name ends at `after`. Handles an arrow
 *  (`= (…) =>`, `= async (…) =>`) and a function expression (`= function (…)`); anything else — a `memo(`
 *  wrapper, a non-function value — yields `null`. */
function bindingParams(b: string, after: number): string | null {
  // The assignment `=` — the first that is not part of a compound operator or the `=>` of an arrow inside
  // the type annotation (`: Record<string, () => void> =` reaches the initializer past two).
  let i = after;
  for (; i < b.length; i++) {
    if (b[i] === ";") return null; // a declaration with no initializer — not a component
    if (b[i] === "=" && b[i + 1] !== "=" && b[i + 1] !== ">" && (i === 0 || !/[=!<>+\-*/%&|^]/.test(b[i - 1]))) break;
  }
  if (i >= b.length) return null;
  i = skipWs(b, i + 1);
  for (const kw of ["async ", "function"]) {
    if (b.startsWith(kw, i)) {
      i = skipWs(b, i + kw.length);
      i = skipWs(b, identAt(b, i)[1]); // `function Name(` — step past an optional expression name
    }
  }
  if (b[i] !== "(") return null;
  const close = matchingBracket(b, i);
  return close < 0 ? null : b.slice(i + 1, close);
}

/** The body of the column-0 `interface <name> { … }` / `type <name> = { … }` declaration in `b`. `null`
 *  when the type is imported, generic, or an intersection/union rather than a plain object literal: in
 *  every one of those the member list is NOT knowable from this source alone, and a guess would be a
 *  fabricated finding. Rust twin: `type_block`. */
function typeBlock(b: string, name: string): string | null {
  for (let lineStart = 0; lineStart < b.length; ) {
    const nl = b.indexOf("\n", lineStart);
    const nextLine = nl < 0 ? b.length : nl + 1;
    if (/\s/.test(b[lineStart])) { lineStart = nextLine; continue; }
    let i = lineStart;
    if (b.startsWith("export ", i)) i = skipWs(b, i + "export ".length);
    const isIface = b.startsWith("interface ", i);
    const isAlias = b.startsWith("type ", i);
    if (!isIface && !isAlias) { lineStart = nextLine; continue; }
    i = skipWs(b, i + (isIface ? "interface".length : "type".length));
    const [found, after] = identAt(b, i);
    if (found !== name) { lineStart = nextLine; continue; }
    let j = skipWs(b, after);
    if (isAlias) {
      if (b[j] !== "=") return null; // a generic alias (`type P<T> = …`) — not resolvable here
      j = skipWs(b, j + 1);
    }
    if (b[j] !== "{") return null; // `interface P extends Q {` / `type P = A & B` — members aren't all here
    const close = matchingBracket(b, j);
    return close < 0 ? null : b.slice(j + 1, close);
  }
  return null;
}

/** The top-level member names of an object-type body (`{ a: string; b?: () => void }` → `a`, `b`). An index
 *  signature contributes nothing. A segment only counts when its leading identifier is followed by `?`, `:`
 *  or `(` — the shape of a real member — so the debris left by splitting a one-line `Map<string, number>` on
 *  its comma is discarded rather than read as a prop. Rust twin: `object_member_names`. */
function objectMemberNames(b: string): string[] {
  const out: string[] = [];
  for (const raw of splitTopLevel(b, ";").flatMap((s) => splitTopLevel(s, ","))) {
    for (const seg of splitTopLevel(raw, "\n")) {
      const start = skipWs(seg, 0);
      if (start >= seg.length || seg[start] === "[") continue;
      let i = start;
      if (seg.startsWith("readonly ", i)) i = skipWs(seg, i + "readonly ".length);
      const [name, after] = identAt(seg, i);
      if (!name) continue;
      const next = seg[skipWs(seg, after)];
      if ((next === "?" || next === ":" || next === "(" || next === "<") && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** The top-level bindings of a destructuring pattern body (`{ a, b: alias, c = 1, ...rest }` → `a`, `b`,
 *  `c`), plus whether a REST element is present. The key is what the prop is called, so `b: alias` reports
 *  `b`; a rest element means the component can consume props this list does not name, which is why the
 *  caller stops reporting EXTRA metadata once it sees one. Rust twin: `destructured_names`. */
function destructuredNames(b: string): { names: string[]; hasRest: boolean } {
  const names: string[] = [];
  let hasRest = false;
  for (const part of splitTopLevel(b, ",")) {
    const start = skipWs(part, 0);
    if (start >= part.length) continue;
    if (part.startsWith("...", start)) { hasRest = true; continue; }
    const [name] = identAt(part, start);
    if (name && !names.includes(name)) names.push(name);
  }
  return { names, hasRest };
}

/**
 * The prop signature of component `name` as parsed from its own module source — the oracle the
 * `props-metadata-mismatch` check (#88) diffs the record's `props[]` against.
 *
 * Reads the FIRST parameter of the component's top-level declaration, by both routes an author writes: a
 * destructuring pattern (`({ a, b }: Props)`) and a named parameter with a type (`(props: Props)` /
 * `(props: { a: string })`). When a destructured parameter ALSO carries a resolvable annotation the two are
 * UNIONED — a member the interface declares but the body never destructures is part of the declared
 * contract (its absence from the body is `unwired-prop`'s finding, not this one), so counting it here keeps
 * the two checks from contradicting each other.
 *
 * `null` means "not knowable from this source" — no column-0 declaration of that name, an untyped `props`
 * parameter, or an annotation naming a type that is imported rather than declared here. Every such case is
 * SILENT: the whole value of this check is that it fires only on a mechanical mismatch, so anything
 * requiring a guess yields nothing at all. A non-null result with an empty set is the confident opposite —
 * the component genuinely takes no props. Rust twin: `signature_props`.
 */
export function signatureProps(src: string, name: string): { names: Set<string>; hasRest: boolean } | null {
  const b = blankCode(src);
  const params = declParams(b, name);
  if (params === null) return null;
  const first = splitTopLevel(params, ",")[0] ?? "";
  const start = skipWs(first, 0);
  // `function Foo()` — no parameter at all, so the component takes no props. Confident, not ignorant.
  if (start >= first.length) return { names: new Set(), hasRest: false };

  const names = new Set<string>();
  let hasRest = false;
  let annotationAt: number;
  if (first[start] === "{") {
    const close = matchingBracket(first, start);
    if (close < 0) return null;
    const d = destructuredNames(first.slice(start + 1, close));
    for (const n of d.names) names.add(n);
    hasRest = d.hasRest;
    annotationAt = skipWs(first, close + 1);
  } else {
    // A named parameter (`props`) — everything it declares comes from its annotation.
    const [ident, after] = identAt(first, start);
    if (!ident) return null;
    annotationAt = skipWs(first, after);
  }
  if (first[annotationAt] !== ":") {
    // An untyped `props` parameter tells us nothing; an untyped destructure told us everything.
    return names.size === 0 && !hasRest ? null : { names, hasRest };
  }
  const tyStart = skipWs(first, annotationAt + 1);
  let members: string[] | null;
  if (first[tyStart] === "{") {
    const close = matchingBracket(first, tyStart);
    members = close < 0 ? null : objectMemberNames(first.slice(tyStart + 1, close));
  } else {
    const [tyName, after] = identAt(first, tyStart);
    // A generic or qualified type (`Props<T>`, `NS.Props`) is not resolvable by name lookup alone.
    const plain = !!tyName && skipWs(first, after) >= first.length;
    const blk = plain ? typeBlock(b, tyName) : null;
    members = blk === null ? null : objectMemberNames(blk);
  }
  if (members) for (const m of members) names.add(m);
  // The annotation named a type this module doesn't declare (an imported contract). A destructure still
  // stands on its own; a bare `props: Imported` leaves us with nothing to say.
  else if (names.size === 0 && !hasRest) return null;
  return { names, hasRest };
}

/** Every module specifier imported/exported-from in `source` (`import … from "X"`, `export … from "X"`,
 *  `import "X"`, `import("X")`), deduped. A loose regex scan — over-inclusion is harmless (the caller only
 *  flags BARE unresolved ones). The Rust twin (`import_specifiers`) is a hand scanner but the same intent. */
function importSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  const fromRe = /\bfrom\s*["']([^"']+)["']/g; // import … from "x"; export … from "x"
  const importRe = /\bimport\s*\(?\s*["']([^"']+)["']/g; // import "x"; import("x")
  while ((m = fromRe.exec(source))) specs.add(m[1]);
  while ((m = importRe.exec(source))) specs.add(m[1]);
  return [...specs];
}

/** The identifiers an `import` statement BINDS in `source` — the names inside `{ … }`, a default binding,
 *  and a `* as X` namespace. Used by `reimplemented-component` (#3892) to skip a node that legitimately
 *  imports the name it also mentions, so only a genuine local RE-DECLARATION is flagged.
 *
 *  Deliberately loose: it scans each `import … from` header and takes every identifier that is not a
 *  keyword. Over-collecting only ever SUPPRESSES a finding, the safe direction for a check whose false
 *  positives are worse than its misses. Rust twin: `imported_identifiers`. */
function importedIdentifiers(source: string): Set<string> {
  const out = new Set<string>();
  const headerRe = /^[ \t]*import\b([\s\S]*?)\bfrom\s*["']/gm;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(source))) {
    for (const id of m[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      if (id !== "type" && id !== "as") out.add(id);
    }
  }
  return out;
}

/** Is `spec` an ABSOLUTE URL — a `scheme:` prefix (the first `:` sits before any `/`, e.g. `https:`,
 *  `http:`, `data:`)? Such a specifier resolves DIRECTLY in the preview iframe (the import-map's own
 *  values ARE esm.sh URLs), so it needs no import-map entry and is never an unresolvable bare import
 *  (#2963). Rust twin: `is_url_specifier`. (Protocol-relative `//` is excluded by the leading-`/` check.) */
function isUrlSpecifier(spec: string): boolean {
  const colon = spec.indexOf(":");
  if (colon < 0) return false;
  const slash = spec.indexOf("/");
  return slash < 0 || colon < slash;
}

/** Is `spec` a BARE package specifier — not a relative (`.`/`..`), absolute (`/`), first-party
 *  (`@/`), or an absolute URL? Only bare specifiers resolve through the preview import-map. */
function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@/") && !isUrlSpecifier(spec);
}

/** Is `spec` an INTERNAL first-party import — a `@/…` alias or a RELATIVE (`./`, `../`) path — as opposed
 *  to a bare npm specifier or an absolute path? These resolve against the kit's components + runtime
 *  closure, not the preview import-map (#2954). Rust twin: `is_internal_specifier`. */
function isInternalSpecifier(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("./") || spec.startsWith("../");
}

/** Does an INTERNAL import `spec` (from module `fromRel`) resolve to a component or runtime module the
 *  preview provides (`targets`)? Tries TS module-resolution order over the importer-relative base. A
 *  NON-internal spec returns `true` — not this check's concern (the bare-specifier check owns npm).
 *  Rust twin: `resolves_internal`. */
/** Every reason the preview CANNOT build `source`, in the order `isPreviewBuildable` tests them — its
 *  reason-first face.
 *
 *  A `no-implementation` finding used to state only THAT a component was unbuildable, leaving the reader
 *  to re-derive the cause by hand (the gap `bsc request` #4 was filed for). The causes are already
 *  computed to decide the predicate; naming them makes `bsc components doctor` diagnosable on its own.
 *
 *  Returns EMPTY only when nothing is wrong — a component with no source at all is a STATED reason, not
 *  an empty list. Rust twin: `no_implementation_reasons` (graph_health.rs); the two must move together.
 *
 *  Lives HERE rather than beside `isPreviewBuildable` in componentPreview.ts so the twins sit in the
 *  mirrored files — graph_health.rs ↔ graphHealth.ts — which is where the parity tests look. (Both
 *  modules are vendored into the packaged preview closure, so either placement regenerates
 *  `react-ui.json`; placement is about parity, not artifact size.) */
export function previewBuildFailures(
  source: string,
  fromRel: string,
  resolvesToSibling: (spec: string, fromRel: string) => boolean,
): string[] {
  const s = source.trim();
  if (!s) return ["it carries no module source of its own (neither `source` nor `srcText`)"];
  const why: string[] = [];
  if (!/\bexport\b/.test(s)) why.push("its source declares no `export`");
  if (hasCodeElision(s)) why.push("its source contains a code-elision marker (`…`) — a sketch, not code");
  const erased = erasedSpecs(s); // #4076: erased by the loader, so never a missing dependency
  const unresolved = [
    ...new Set(
      importSpecifiers(s).filter(
        (spec) => isInternalSpecifier(spec) && !erased.has(spec) && !resolvesToSibling(spec, fromRel),
      ),
    ),
  ].sort();
  if (unresolved.length) {
    const list = unresolved.map((u) => "`" + u + "`").join(", ");
    why.push(`it imports ${list} — resolving to no kit component, runtime file or registered platform module`);
  }
  return why;
}

function resolvesInternal(spec: string, fromRel: string, targets: Set<string>): boolean {
  const base = resolveInternalBase(spec, fromRel);
  if (base === null) return true;
  return [".ts", ".tsx", "/index.ts", "/index.tsx"].some((ext) => targets.has(base + ext));
}

// The packaged kit artifact (each built-in's verbatim `source` + the `runtime` @/ closure) — the SAME
// raw import ComponentPreviewFrame builds against. A built-in's `src` resolves here, so it's buildable
// even though the store strips its `source` (#2794).
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

/** The set an INTERNAL import can resolve to at preview time (#2954): every runtime-closure module PLUS
 *  every packaged built-in that ships a real `source` (a `composes` sibling `componentPreviewFiles`
 *  vendors). The exact files the preview writes for `@/`/relative resolution. Rust twin: `internal_targets`
 *  (the analyze pass also unions in the store's own component `src` paths for same-store siblings). */
const INTERNAL_TARGETS = new Set<string>([
  ...Object.keys(ARTIFACT.runtime ?? {}),
  ...ARTIFACT.components.filter((c) => c.source).map((c) => c.src),
]);

export type HealthCategory =
  | "cycle" | "dangling-branch" | "duplicate" | "no-implementation" | "self-reference" | "unresolvable-import"
  // dangling-composes-reference (#89) — a `composes` entry naming no component in the kit, by name or id.
  // The edge builder drops it, so the graph reads as complete while the reference names nothing.
  | "dangling-composes-reference"
  | "stubbed-import" // #3696 — a bare npm import rendered via a local shim/stub (sev 1, not an error)
  | "hardcoded-color" // #3704 — hardcodes color literals + no theme token (not wired to the theme, sev 1)
  | "reimplementation" | "reimplemented-component" | "orphan" | "unwired-prop"
  // props-metadata-mismatch (#88): the record's `props[]` disagrees with the prop signature its own source
  // declares. An EMPTY `props: []` on a component with a real typed signature is the load-bearing case —
  // the preview's sample-data synthesizer reads ONLY the metadata, so it silently has nothing to sample.
  | "props-metadata-mismatch"
  // skips-family-shell (#87) — a member of a folder/name-suffix family that does NOT compose the shell
  // primitive the rest of the family does. A REPORT, not a rule.
  | "skips-family-shell"
  | "phantom-compose"
  // MOTION checks (#3163, `bsc components doctor --motion` / `analyzeMotion`) — mechanical faults an author used to
  // hand-diagnose: a dead animation-selector hook, a stroke-dash draw with no pathLength, a CSS-transform
  // keyframe fighting an SVG transform ATTRIBUTE, and a cross-component keyframe-name collision.
  | "motion-dead-selector" | "motion-dash-no-pathlength" | "motion-transform-attr" | "motion-name-collision"
  | "no-empty-state" | "no-loading-state" | "no-error-state"
  // no-analytics (#3810): an INTERACTIVE component (an action/event prop) that declares no analytics
  // events manifest — instrumentation is a per-node data contract. Static; mirrored in the Rust doctor.
  | "no-analytics"
  // no-tests (#3878): an IMPLEMENTED own-module component carrying no `tests` manifest.
  | "no-tests"
  // RUNTIME data-state blanks (#3191) — a component that BUILDS clean and renders fine LOADED but produces
  // a BLANK #root in a real app state: `empty-empty-state` (no output when its data is empty — no
  // empty-state message) / `empty-loading-state` (no output while loading — no skeleton/spinner). Unlike
  // the STATIC no-empty-state/no-loading-state (#3135, "the source has no empty/loading branch"), these are
  // RENDER-CONFIRMED: the on-visit iframe scan mounts the empty/loading preview state and measures a blank
  // #root (componentScan.ts). NOT produced by `analyzeGraphHealth` (it can't run a component) — and NOT
  // mirrored in the static Rust doctor, which keeps only the #3135 complements it can compute.
  | "empty-empty-state" | "empty-loading-state"
  | "slot-shell";

/**
 * Fold RUNTIME health categories into a node's static badge — most severe wins.
 *
 * Extracted so the workbench and a single node apply the SAME rule
 * (#two-store-keys-drive-more-than-half-the-apps-jank). It used to live inline in `DesignsWorkbench`'s
 * `nodeHealth` memo, which meant that memo depended on `componentStateHealth` — so every 150ms scan
 * flush rebuilt a Map over every component AND re-rendered the whole workbench, even though
 * `ComponentNode` was already memoized (#4132). Measured: 3,296 designs commits at a 38.5ms median,
 * 100% of them over a frame budget, and 486 of 891 jank windows attributed to these two store keys.
 *
 * With the rule pure, the parent can memo on the STATIC findings alone and each node folds in its own
 * runtime categories from its own store slice — so a flush re-renders the nodes that changed rather
 * than the graph.
 *
 * `static` may be undefined (no static finding) and `runtime` may be empty; the result is whichever
 * category ranks worst under {@link HEALTH_SEVERITY}, or undefined when there is nothing to badge.
 */
export function worstHealth(
  staticBadge: HealthCategory | undefined,
  runtime: readonly HealthCategory[] | undefined,
): HealthCategory | undefined {
  let worst = staticBadge;
  for (const cat of runtime ?? []) {
    if (!worst || HEALTH_SEVERITY[cat] > HEALTH_SEVERITY[worst]) worst = cat;
  }
  return worst;
}

/** Category → severity (higher = worse); drives ranking + which badge wins on a multi-flagged node.
 *  `unresolvable-import` (3) is a real defect — the component throws at preview time (a bare import the
 *  preview can't resolve). `unwired-prop` (2) is a real but mild signal — a declared interface a
 *  component never implements. `slot-shell` is INFORMATIONAL (1, below every defect) — it never overrides
 *  a real defect badge, it just explains why a composite previews as a demo placeholder (#2921). */
export const HEALTH_SEVERITY: Record<HealthCategory, number> = {
  cycle: 4,
  "dangling-branch": 3,
  duplicate: 3,
  "no-implementation": 3,
  "self-reference": 3,
  "unresolvable-import": 3,
  "stubbed-import": 1,
  "hardcoded-color": 1,
  reimplementation: 3,
  "reimplemented-component": 3,
  orphan: 2,
  "dangling-composes-reference": 2,
  "unwired-prop": 2,
  "props-metadata-mismatch": 2,
  "skips-family-shell": 2,
  "phantom-compose": 2,
  // Motion (#3163): a dead selector hook + a cross-component name collision are real faults (the motion
  // targets nothing / two components' keyframes clobber) → 2; the two SVG traps are advisory (the motion
  // still runs, just not as intended) → 1.
  "motion-dead-selector": 2,
  "motion-name-collision": 2,
  "motion-dash-no-pathlength": 1,
  "motion-transform-attr": 1,
  "no-empty-state": 1,
  "no-loading-state": 1,
  "no-error-state": 1,
  "no-analytics": 1,
  "no-tests": 1,
  // Runtime data-state blanks (#3191) — a real but mild defect (renders fine loaded, blanks in a real app
  // state), the unwired-prop/orphan tier (2). Render-confirmed by the scan, so ABOVE the static #3135
  // no-empty/no-loading advisories (1): when a node hits both, the confirmed blank wins the badge.
  "empty-empty-state": 2,
  "empty-loading-state": 2,
  "slot-shell": 1,
};

/** The badge glyph + tooltip per category (#2680) — mirrors `bsc components doctor`; read by the Design Studio
 *  graph node cards (`DesignsWorkbench`). Typed as a TOTAL `Record<HealthCategory, …>`, so the compiler
 *  forces an entry for EVERY category (the #3026 gap stays closed — a new category can't ship without a
 *  badge). Co-located with {@link HEALTH_SEVERITY} (both keyed by category) in this pure module so it's
 *  testable without loading the workbench component. */
export const HEALTH_BADGE: Record<HealthCategory, { glyph: string; label: string }> = {
  cycle: { glyph: "⟳", label: "on a composes cycle" },
  "dangling-branch": { glyph: "⚠", label: "unused branch (nothing composes it, used = 0)" },
  duplicate: { glyph: "⧉", label: "duplicate (same intrinsic / identical source)" },
  "no-implementation": { glyph: "∅", label: "no buildable implementation — a spec, not code" },
  "self-reference": { glyph: "↺", label: "self-referential stub — only renders itself; supply its real body" },
  "unresolvable-import": { glyph: "↯", label: "imports a package the preview can't resolve — throws at preview time" },
  "stubbed-import": { glyph: "◍", label: "imports a non-curated package — renders via a local shim/stub (approximate, not the real package)" },
  "hardcoded-color": { glyph: "▦", label: "hardcodes colors + no theme token — won't follow the active theme; wire it to var(--…) tokens" },
  reimplementation: { glyph: "♻", label: "reimplements a library node — compose it via @bsc/… instead of re-coding it" },
  "reimplemented-component": { glyph: "⧉", label: "re-declares a component that already exists — the preview renders the local stub, not the real node" },
  orphan: { glyph: "○", label: "orphan — isolated & unused" },
  "dangling-composes-reference": { glyph: "⇠", label: "dangling composes — names a component that is not in this kit; the edge is dropped, so the graph looks complete while the reference resolves to nothing" },
  "unwired-prop": { glyph: "⊘", label: "unwired props — declares an interface its source never uses" },
  "props-metadata-mismatch": { glyph: "≠", label: "props metadata disagrees with the signature its own source declares — the preview samples from `props`, so a stale (or empty) list gives it nothing to sample" },
  "skips-family-shell": { glyph: "⊟", label: "skips the family shell — its folder/name-suffix siblings nearly all compose one primitive and this one does not; likely hand-rolls the same shell" },
  "phantom-compose": { glyph: "⇢", label: "phantom composes — declares a composition its source never renders (a false graph edge)" },
  "motion-dead-selector": { glyph: "⌁", label: "motion dead selector — an animation targets a class hook its source never renders" },
  "motion-dash-no-pathlength": { glyph: "┅", label: "stroke-dash motion with no pathLength — a draw-in needs a known path length" },
  "motion-transform-attr": { glyph: "⤥", label: "CSS transform keyframe fights an SVG transform= attribute — they don't compose" },
  "motion-name-collision": { glyph: "⧗", label: "cross-component keyframe-name collision — two components' same-named animations clobber" },
  "no-empty-state": { glyph: "◍", label: "no empty state — takes data but renders no distinct empty view; add an EmptyState" },
  "no-loading-state": { glyph: "◌", label: "no loading state — takes data but has no `loading` prop; add one for a loading preview" },
  "no-error-state": { glyph: "◒", label: "no error state — takes data but has no `error` prop; add one for an error preview" },
  "no-analytics": { glyph: "◉", label: "no analytics — interactive but declares no events manifest; add one so a composed app is instrumented by construction (#3810)" },
  "no-tests": { glyph: "⊘", label: "no tests — has an implementation but carries no tests manifest; the node's source lives in the graph while nothing covering it does (#3878)" },
  "empty-empty-state": { glyph: "⬚", label: "blank empty state — renders NOTHING when its data is empty; add an empty-state message" },
  "empty-loading-state": { glyph: "◐", label: "blank loading state — renders NOTHING while loading; add a skeleton/spinner" },
  "slot-shell": { glyph: "▤", label: "slot shell — previews a demo placeholder; fill its content slots to see its real function" },
};

export interface HealthFinding {
  category: HealthCategory;
  severity: number;
  nodeIds: string[];
  nodeNames: string[];
  why: string;
}

/** The nodes reachable from `start` along `out` (DFS, cycle-safe). Excludes `start`. */
function reachable(start: string, out: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const walk = (id: string) => {
    for (const d of out.get(id) ?? []) if (!seen.has(d)) { seen.add(d); walk(d); }
  };
  walk(start);
  seen.delete(start);
  return seen;
}

/** Node ids that sit on a `composes` cycle (any node whose DFS reaches itself). */
function cycleNodes(ids: string[], out: Map<string, string[]>): Set<string> {
  const onCycle = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=on-stack 2=done
  const stack: string[] = [];
  const dfs = (id: string) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of out.get(id) ?? []) {
      const c = color.get(d) ?? 0;
      if (c === 1) {
        // back edge → everything from d up the stack is on a cycle.
        for (let i = stack.length - 1; i >= 0; i--) { onCycle.add(stack[i]); if (stack[i] === d) break; }
      } else if (c === 0) dfs(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const id of ids) if ((color.get(id) ?? 0) === 0) dfs(id);
  return onCycle;
}

/** The hardcoded COLOR literals in `text` (#3704) — a 6- or 8-digit hex or an `rgb()/rgba()/hsl()/hsla()/
 *  oklch()/oklab()` function; the leak candidates a theme change can't reach. A 3-digit `#219` (an issue
 *  ref) is skipped.
 *
 *  CODE POSITION ONLY (#87): a `//` or block comment is skipped, because a hex written there styles
 *  nothing — the swatch in `// palette: #171717` is documentation, and reporting it sends the reader to
 *  fix a line that has no effect. A literal inside a STRING is still caught: that is exactly where a real
 *  one lives (`color: "#171717"`). Rust twin: `color_literals`. */
function colorLiterals(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
    } else if (c === "#") {
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(text[j])) j++;
      if (j - i - 1 === 6 || j - i - 1 === 8) out.push(text.slice(i, j));
      i = Math.max(j, i + 1);
    } else if (/[A-Za-z]/.test(c)) {
      // A colour FUNCTION — matched on a whole-word boundary so `to_rgb(` isn't one.
      const start = i;
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      const word = text.slice(start, i).toLowerCase();
      const boundaryOk = start === 0 || !/[A-Za-z0-9_]/.test(text[start - 1]);
      if (boundaryOk && text[i] === "(" && ["rgb", "rgba", "hsl", "hsla", "oklch", "oklab"].includes(word)) {
        out.push(word);
      }
    } else i++;
  }
  return out;
}

// ── skips-family-shell (#87) — the four gates that make "which sibling skips the shared shell?" a SIGNAL
// rather than a list. Set against the real 585-record library: at these values the whole store yields six
// findings, including the case the request was filed for (20 of the 21 `settings/cards` components compose
// `Card`; `AchievementsCard` does not). Loosening the share to 0.7 turns the same sweep into ~20 rows of
// five- and six-member "outlier" sets — the report that made a human read a dozen srcTexts by hand.

/** A family must have this many members before "most of them do X" means anything. A cheap pre-filter:
 *  {@link FAMILY_SHELL_SHARE} binds first, making SEVEN the smallest family that can fire (6/7 = 0.857). */
const FAMILY_MIN = 6;
/** The share of a family that must compose a shell before the rest read as outliers, not a 2nd convention. */
const FAMILY_SHELL_SHARE = 0.85;
/** Past this many non-composers it is a split, not an outlier set — a design question, not a finding. */
const FAMILY_MAX_OUTLIERS = 3;
/** The shell must be widely composed IN ITS KIT, so two siblings sharing a helper cannot become "the shell". */
const FAMILY_SHELL_COMPOSERS_MIN = 10;

/** The trailing PascalCase word of `name` (`AchievementsCard` → `Card`) — the second grouping convention,
 *  alongside the record's folder. `null` for a single-segment name, which also keeps a shell out of the
 *  family named after it (`Card` itself is not a `*Card`). Rust twin: `name_suffix`. */
export function nameSuffix(name: string): string | null {
  const segments: string[] = [];
  for (const c of name) {
    if (/[A-Z]/.test(c) || segments.length === 0) segments.push("");
    segments[segments.length - 1] += c;
  }
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1];
  return last.length > 1 ? last : null;
}

/** Does `text` reference a THEME TOKEN (`var(--…)`)? A component that does is wired to the theme. Rust twin:
 *  `uses_theme_token`. */
function usesThemeToken(text: string): boolean {
  return text.includes("var(--");
}

/**
 * Analyze one kit's components for graph-health findings, ranked most-severe first. Pure — mirrors
 * `graph_health::analyze`. Same input always yields the same order (stable name tiebreak).
 */
export function analyzeGraphHealth(
  comps: ComponentRecord[],
  // The library resolver `@bsc/…` references are judged against — the ACTIVE project's pinned sound kit
  // when the caller has project context (#3412), else the packaged default. Kept a PARAM so this module
  // stays pure; the Rust twin takes the same kit via `HealthOptions::sound_kit_json`, so a reference that
  // resolves here resolves there.
  libResolver: LibraryModuleResolver = libraryModuleResolver,
  // The WHOLE library, when the caller has it (#89). `composes` resolves within a kit, so an entry naming a
  // component that lives only in ANOTHER kit still draws no edge — but it is a different defect from one
  // naming nothing at all, and the two have opposite fixes. Omit it and the dangling-composes finding stays
  // true but unqualified ("no component in this kit"), never guessing which of the two it is. The Rust twin
  // always has this, because `analyze_with` sees every kit before it buckets them.
  library?: readonly ComponentRecord[],
): HealthFinding[] {
  const nameById = new Map(comps.map((c) => [c.id, c.name]));
  const edges = buildComposesEdges(comps);

  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>(comps.map((c) => [c.id, 0]));
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const nameOf = (id: string) => nameById.get(id) ?? id;

  const findings: HealthFinding[] = [];

  // dangling-composes-reference (#89) — a `composes` entry naming NO component in the kit, by name OR by id.
  // `buildComposesEdges` DROPS an unresolved name ("no dangling graph edges"), so the graph draws nothing and
  // reads as complete while the record claims a composition of something that is not there. It is the
  // standard the designer doc has always stated ("every `composes` entry names a real component in the kit")
  // and the one thing nothing checked — so the name is recomputed here rather than read off the edges.
  //
  // It gets its OWN category because the finding it used to surface as was actively misleading: two
  // components sharing a forward reference score as a fuzzy near-DUPLICATE pair (their prop shapes align
  // around the child they both mean to extract), and that finding's "merge X into Y" is not merely less
  // useful — it is impossible, since the preview sandbox forbids the first-party import a literal merge
  // would need. Grouped by the MISSING name, because the fix is one record, not one per composer.
  // Rust twin: the dangling-composes-reference loop in graph_health.rs.
  const kitHandles = new Set<string>(comps.flatMap((c) => [c.name, c.id]));
  const kitId = comps[0]?.kitId ?? "";
  const dangling = new Map<string, ComponentRecord[]>();
  for (const c of comps) {
    for (const dep of c.composes) {
      if (!dep.trim() || kitHandles.has(dep)) continue;
      (dangling.get(dep) ?? dangling.set(dep, []).get(dep)!).push(c);
    }
  }
  for (const [missing, composers] of [...dangling].sort(([a], [b]) => a.localeCompare(b))) {
    const names = composers.map((c) => c.name);
    const one = composers.length === 1;
    // Where else does the name live? Only answerable when the caller passed the library.
    const elsewhere = library
      ? [...new Set(library.filter((c) => c.name === missing || c.id === missing).map((c) => c.kitId))]
          .filter((k) => k !== kitId)
          .sort()
      : null;
    const tail = elsewhere === null
      ? "no component in this kit carries that name or id"
      : elsewhere.length === 0
        ? "no component ANYWHERE in the library carries that name or id — the reference names something that does not exist"
        : `no component in THIS kit carries that name or id — it exists in ${elsewhere.length === 1 ? "another kit" : "other kits"} (${elsewhere.join(", ")}), and \`composes\` only ever resolves within one kit`;
    findings.push({
      category: "dangling-composes-reference", severity: 2,
      nodeIds: composers.map((c) => c.id), nodeNames: names,
      why: `${composers.length} component${one ? "" : "s"} (${names.join(", ")}) declare${one ? "s" : ""} they compose \`${missing}\`, but ${tail} — the edge resolves to nothing and is silently dropped, so the graph reads as complete`,
    });
  }

  // cycles
  const onCycle = cycleNodes(comps.map((c) => c.id), out);
  if (onCycle.size) {
    const ids = [...onCycle];
    const names = ids.map(nameOf);
    findings.push({ category: "cycle", severity: 4, nodeIds: ids, nodeNames: names,
      why: `these components form a composes cycle: ${names.join(" → ")}` });
  }

  // dead roots → orphan or dangling-branch
  for (const c of comps) {
    if ((inDeg.get(c.id) ?? 0) !== 0 || c.used !== 0) continue;
    const outN = (out.get(c.id) ?? []).length;
    if (outN === 0) {
      if (c.role === "primitive" || c.role === "composite") {
        findings.push({ category: "orphan", severity: 2, nodeIds: [c.id], nodeNames: [c.name],
          why: `${c.name} is isolated (nothing composes it) and unused (used = 0)` });
      }
    } else {
      // A `page` is a root BY DEFINITION — nothing composes a page; that is what makes it a page.
      // Its `nodeIds` name ONLY the root, never the reachable set: those are the page's ordinary,
      // often widely-shared content (#110 — a settings page alone can reach dozens of real components,
      // including some also composed by unrelated live cards). Sweeping the whole branch into ONE
      // finding badged every one of them as "unused" purely because ONE page happens to reach them.
      // A dead LAYOUT keeps the full branch below — unlike a page it is not guaranteed to be a real
      // entry point, so dragging its subtree down with it is a genuine, worth-reporting risk.
      // Mirrors the Rust twin's page-root guard in `graph_health.rs`.
      const reach = reachable(c.id, out);
      const [ids, names] = c.role === "page"
        ? [[c.id], [c.name]]
        : [[c.id, ...reach], [c.name, ...[...reach].map(nameOf)]];
      findings.push({ category: "dangling-branch", severity: 3,
        nodeIds: ids, nodeNames: names,
        why: `${c.name} is an unused root that pulls in ${reach.size} dependenc${reach.size === 1 ? "y" : "ies"}` });
    }
  }

  // duplicates — same wraps, or identical source
  const group = <K>(key: (c: ComponentRecord) => K | undefined) => {
    const m = new Map<K, ComponentRecord[]>();
    for (const c of comps) { const k = key(c); if (k !== undefined) (m.get(k) ?? m.set(k, []).get(k)!).push(c); }
    return [...m.values()].filter((g) => g.length >= 2);
  };
  for (const g of group((c) => c.wraps)) {
    const names = g.map((c) => c.name);
    findings.push({ category: "duplicate", severity: 3, nodeIds: g.map((c) => c.id), nodeNames: names,
      why: `${g.length} components all wrap the raw <${g[0].wraps}>: ${names.join(", ")}` });
  }
  for (const g of group((c) => (c.srcText.trim() ? c.srcText : undefined))) {
    const names = g.map((c) => c.name);
    findings.push({ category: "duplicate", severity: 3, nodeIds: g.map((c) => c.id), nodeNames: names,
      why: `${g.length} components have identical source: ${names.join(", ")}` });
  }

  // no-implementation — a component the Design Studio preview can't build (`componentPreviewFiles` →
  // null): it's a spec, not code. Reuses the EXACT preview logic so the badge and the live preview
  // agree. A built-in resolves via the artifact roster (its source lives there even though the store
  // strips it, #2794); only a node in neither the artifact nor carrying its own module/`source` is
  // flagged (a user-authored spec, e.g. a `page` like GraphExplorerPage). Independent of used/role.
  // The set an INTERNAL import may resolve against — the kit's own `src` paths, the loader's
  // sibling-by-id form, and the graph-source primitives a component `provides`. Built here (rather than
  // at its later `unresolvable-import` use) because the no-implementation reasons below need it too.
  const internalTargets = new Set<string>([
    ...INTERNAL_TARGETS,
    ...comps.map((c) => c.src).filter(Boolean),
    ...comps.map((c) => `components/${c.id}.tsx`), // #3897 — the loader's sibling-by-id form
  ]);
  // #43/#3660: a `@/X` import also resolves to the graph component that `provides` X (a graph-source
  // primitive), exactly as the build does — so it's not falsely flagged an unresolvable internal import.
  for (const c of comps) {
    const base = c.provides ? resolveInternalBase(c.provides, "") : null;
    if (base) internalTargets.add(`${base}.tsx`);
  }
  for (const c of comps) {
    // Pass the kit as siblings so a composing user component (importing a sibling, #3112) builds and is
    // NOT falsely flagged — the exact set the live preview vendors.
    // #4130: the PREDICATE, not a discarded bundle. `componentBuildable` is exactly
    // `componentPreviewFiles(...) !== null` (pinned by a test over the real library) but answers off the
    // cached artifact/sibling indexes — this loop used to be 1297ms of a 1766ms page mount.
    if (!componentBuildable(c, ARTIFACT, comps)) {
      const reasons = previewBuildFailures(c.srcText ?? "", c.src ?? "", (spec, fromRel) =>
        PLATFORM_MODULES.has(spec) || resolvesInternal(spec, fromRel, internalTargets));
      findings.push({ category: "no-implementation", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} has no buildable implementation — the preview can't render it (a spec, not code): ${reasons.join("; ")}` });
    }
  }

  // hardcoded-color (#3704) — a component NOT wired to the theme: its own source hardcodes color literals
  // (hex / rgb / hsl / oklch) and references NO `var(--…)` design token, so it won't follow the active
  // theme/preset (the contract is "components reference ONLY semantic tokens, never raw colors"). Built-ins
  // are skipped (their record is a curated snippet). Uses the node's own source, independent of
  // buildability, so an unthemed mobile component is flagged whether or not its imports resolve. Rust twin.
  for (const c of comps) {
    if (c.builtin) continue;
    const src = (c.source && c.source.trim() ? c.source : c.srcText) ?? "";
    if (!src.trim() || usesThemeToken(src)) continue;
    const colors = colorLiterals(src);
    if (!colors.length) continue;
    const sample = colors.slice(0, 4).map((x) => `\`${x}\``).join(", ") + (colors.length > 4 ? `, +${colors.length - 4}` : "");
    findings.push({ category: "hardcoded-color", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} hardcodes ${colors.length} color literal${colors.length === 1 ? "" : "s"} (${sample}) and references no theme token — it won't follow the active theme/preset` });
  }

  // self-reference — an own-module component whose only rendered element is ITSELF (`<Name/>`): a
  // self-referential stub. It passes the buildability check (it has an `export`, so no-implementation is
  // blind to it) and the write-time syntax gate, yet produces no output and recurses forever — the class
  // the designer hit authoring D3 components as self-calls (#3026). Rust twin: the self-reference loop.
  for (const c of comps) {
    if (isSelfReferentialStub(c, comps)) {
      findings.push({ category: "self-reference", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} only renders itself (<${c.name}/>) — a self-referential stub, not a real implementation (it produces no output and recurses forever)` });
    }
  }

  // unresolvable-import — a component whose OWN module imports something the preview CAN'T resolve, the
  // class `bsc components doctor` was blind to (the graph looked clean while the component was broken). Two kinds:
  //   • BARE — an npm package not in the preview import-map → "Failed to resolve module specifier" (#2934).
  //   • INTERNAL — a `@/…`/relative import matching NEITHER a kit component NOR a runtime-closure module →
  //     "module not found" (exactly the `Code`→`../typography/type` / `Skeleton`→`./shimmer` failure #2954
  //     fixed in the packaged closure; this surfaces any future/user-authored recurrence).
  //   • LIBRARY (#3116) — a `@bsc/<segment>/<name>` cross-graph reference (the THIRD import class: neither
  //     npm nor first-party) that names NO real library node. A `@bsc/algorithms/<name>` matching a real
  //     algorithm is a NEW resolvable class — the preview vendors its code (`libraryModuleResolver`), so it
  //     is NEVER flagged; only a `@bsc/…/<missing>` is.
  // Only own-source components (`ownModuleSource`) — the source the preview actually builds. Rust twin:
  // the `unresolvable-import` loop in graph_health.rs.
  const fmtSpecs = (v: string[]) => v.map((s) => `\`${s}\``).join(", ");
  for (const c of comps) {
    const src = ownModuleSource(c, comps);
    if (!src) continue;
    // Every classification below asks "can the preview provide this module?". A SYNTACTICALLY type-only
    // import (#4076) is erased before anything resolves, so it needs no kit component, runtime file,
    // library node or npm stub — drop it up front rather than exempting it three times.
    const erasedHere = erasedSpecs(src);
    const specs = importSpecifiers(src).filter((s) => !erasedHere.has(s));
    // A `@bsc/…` library spec is bare-shaped but resolves against the algorithms store, NOT the import-map
    // — so it's excluded from `stubbed` and judged by `libraryModuleResolver` (resolvable ⇒ vendored ⇒ clean).
    const library = specs.filter((s) => isLibrarySpec(s) && libResolver(s) === null).sort();
    // #3696: a bare npm specifier that isn't a curated preview external no longer FAILS — the preview bundles
    // a local shim/stub for it, so it renders approximately → a severity-1 `stubbed-import` note, not an error.
    const stubbed = specs.filter((s) => isBareSpecifier(s) && !isLibrarySpec(s) && !RESOLVABLE_SPECIFIERS.has(s)).sort();
    // A REGISTERED platform module (#3897) resolves literally, like the loader's `isAppModule` — it is
    // neither an artifact path nor a sibling `src`, so without this it read as unresolvable.
    const internal = specs
      .filter((s) => isInternalSpecifier(s) && !PLATFORM_MODULES.has(s) && !resolvesInternal(s, c.src, internalTargets))
      .sort();
    // GENUINELY unresolvable (sev 3): a `@/…`/relative or `@bsc/…` import with NO stub fallback.
    if (internal.length || library.length) {
      const reasons: string[] = [];
      if (library.length) reasons.push(`${fmtSpecs(library)} (no matching node in the library)`);
      if (internal.length) reasons.push(`${fmtSpecs(internal)} (no such module in the kit or its runtime closure)`);
      findings.push({ category: "unresolvable-import", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} imports ${reasons.join("; ")} — the preview can't resolve it, so it throws "module not found" when rendered` });
    }
    // STUBBED npm imports (sev 1): renders, but via a local shim/stub, not the real package (#3696).
    if (stubbed.length) {
      findings.push({ category: "stubbed-import", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} imports ${fmtSpecs(stubbed)} — not a curated preview external, so the preview renders it via a bundled-in local shim/stub (approximate, not the real package)` });
    }
  }

  // reimplementation — the "compose, don't recreate" guardrail (#3118, epic #3114). An own-source
  // component that DECLARES a symbol whose name EXACTLY matches an existing LIBRARY ALGORITHM is RE-CODING
  // what it could import via `@bsc/algorithms/…` — an inline `function fibonacci` while
  // `@bsc/algorithms/fibonacci` already exists. #3116 made those cross-graph references resolvable +
  // vendorable (the preview runs the library impl with no inline copy); this closes the loop by steering
  // the designer to compose the ONE canonical node instead of forking it. ALGORITHMS-ONLY by design (see
  // `libraryReimplTargets`): sounds are excluded — a cue id like `click` collides with common handler
  // names, and you don't re-code a cue as a function. Conservative to keep false positives out (worse than
  // a miss here): EXACT whole-identifier match only (`declaresSymbol`), scanned on the source the preview
  // actually builds (`ownModuleSource`), and SKIPPED when the component already imports that
  // `@bsc/<segment>/<name>` node (it's already composing, not recreating). Rust twin: graph_health.rs.
  const reimplTargets = libraryReimplTargets();
  for (const c of comps) {
    const src = ownModuleSource(c, comps);
    if (!src) continue;
    const specs = new Set(importSpecifiers(src));
    const declares = declaresFrom(src); // #4130: one scan, then a lookup per candidate
    const recoded = reimplTargets.filter((t) => declares(t.name) && !specs.has(t.importSpec));
    if (recoded.length === 0) continue;
    const list = recoded.map((t) => `\`${t.name}\` (import \`${t.importSpec}\`)`).join(", ");
    const one = recoded.length === 1;
    findings.push({ category: "reimplementation", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} re-codes ${one ? "a library node that already exists" : "library nodes that already exist"}: ${list} — compose ${one ? "it" : "them"} from the library instead of re-coding (compose, don't recreate)` });
  }

  // reimplemented-component (#3892) — the SAME "compose, don't recreate" guardrail as above, one dimension
  // over: an own-source component that DECLARES a name which is already a COMPONENT NODE in this graph.
  // The algorithm version has existed since #3118; the component version did not, which is how 36 of 74
  // harvested records came to carry a local `function Box` while a `Box` node sat in the same kit. They
  // render — as a STUB Box, not the kit's — so the page looks right and every later revision iterates on
  // the reduced copy (the #3833 failure mode). Provenance is PROMOTION, not harvest: `bsc components harvest`
  // reports such a candidate as `buildable: false` with the exact unresolved specifiers and never stubs
  // them; this catches the hand "resolution" that fakes the import to satisfy buildability.
  // Conservative like its sibling: exact whole-identifier declaration, own-module source, never self, and
  // skipped when the source already imports that identifier. Rust twin: graph_health.rs.
  for (const c of comps) {
    const src = ownModuleSource(c, comps);
    if (!src) continue;
    const imported = importedIdentifiers(src);
    const declares = declaresFrom(src); // #4130: one scan, then a lookup per sibling name
    // SAME-FILE siblings are not stubs (#3895): several nodes are routinely extracted from ONE module
    // (`AgentFace` and `TeamsCanvas` both come from TeamsCanvas.tsx), so that module's closure legitimately
    // CONTAINS both declarations — flagging them would demand an import of the file from itself.
    const recoded = [...new Set(
      comps
        .filter((t) => t.name !== c.name && !(t.src === c.src && !!c.src))
        .map((t) => t.name)
        .filter((name) => declares(name) && !imported.has(name)),
    )].sort();
    if (recoded.length === 0) continue;
    const list = recoded.map((n) => `\`${n}\``).join(", ");
    const one = recoded.length === 1;
    findings.push({ category: "reimplemented-component", severity: 3, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} declares ${list} locally, but ${one ? "that name is" : "those names are"} already ${one ? "a node" : "nodes"} in this graph — the preview renders the LOCAL copy, so this node looks correct while composing a stub instead of the real component` });
  }

  // unwired-prop — a component that declares props its own source never references (a declared interface
  // that does nothing, #2924). Only for a node with its OWN module source (user-authored); a built-in
  // (source in the artifact) or a spec (no buildable module) is skipped. Guard: require ≥1 prop REFERENCED
  // (so it clearly uses NAMED props — not a `{...props}` spreader) before flagging the unreferenced ones.
  for (const c of comps) {
    const src = ownModuleSource(c, comps);
    if (!src || c.props.length === 0) continue;
    const used = new Map(c.props.map((p) => [p.name, referencesIdentifier(src, p.name)]));
    if (![...used.values()].some(Boolean)) continue; // no named-prop usage confirmed → conservative skip
    const unwired = c.props.map((p) => p.name).filter((n) => !used.get(n));
    if (unwired.length === 0) continue;
    findings.push({ category: "unwired-prop", severity: 2, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} declares prop${unwired.length === 1 ? "" : "s"} its source never uses: ${unwired.join(", ")} — a declared interface that does nothing` });
  }

  // props-metadata-mismatch (#88) — the record's `props[]` disagrees with the prop signature its OWN source
  // declares. The mismatch is purely mechanical, but the preview's sample-data synthesizer reads ONLY the
  // metadata, so an EMPTY `props: []` on a component with a real typed signature silently gives it nothing
  // to synthesize and the component crashes on its first unguarded prop read. Four such records were found
  // ONE AT A TIME chasing individual render errors, because nothing could ask the question in bulk.
  //
  // The conservatism IS the check: `signatureProps` returns null for anything not readable off this source
  // alone (an imported props type, an untyped `props`, a `memo(…)` wrapper) rather than guessing. Built-ins
  // are skipped — their `srcText` is an illustrative snippet, not the module (#2794). A `...rest` element
  // means the component can take props the signature does not name, so EXTRA metadata stops being reported
  // for it; MISSING still is, because a rest element cannot explain that away. Rust twin: graph_health.rs.
  for (const c of comps) {
    if (c.builtin) continue;
    const src = ownModuleSource(c, comps);
    if (!src) continue; // built-in or spec-only — no module of ours to read the signature off
    const sig = signatureProps(src, c.name);
    if (!sig) continue; // not knowable from this source — say nothing
    // Both lists are SORTED, not source-ordered: the Rust twin walks `BTreeSet`s, so sorting here is what
    // keeps the two `why` strings byte-identical for the same input.
    const declared = c.props.map((p) => p.name);
    const missing = [...sig.names].filter((n) => !declared.includes(n)).sort();
    const extra = sig.hasRest ? [] : [...new Set(declared)].filter((n) => !sig.names.has(n)).sort();
    if (!missing.length && !extra.length) continue;
    // `unwired-prop` (#2924) ALREADY owns the case where the only disagreement is metadata naming props the
    // source never uses at all — same evidence, same fix ("drop it from `props`"), so saying it a second
    // time would only double the noise. This check speaks when the signature itself is out of sync:
    // something is MISSING, or an extra name IS referenced by the source (a parse/metadata disagreement
    // rather than a dead declaration).
    if (!missing.length && !extra.some((n) => referencesIdentifier(src, n))) continue;
    // The load-bearing case gets its own prose: an empty `props` is not "a bit out of date", it is the one
    // state that disables the sampler outright.
    const why = declared.length === 0
      ? `${c.name} carries NO props metadata while its own signature declares ${missing.length}: ${missing.join(", ")} — the preview's sample-data synthesizer reads \`props\`, so it has nothing to synthesize and the component renders with every prop undefined`
      : `${c.name}'s props metadata disagrees with the signature its own source declares: ${[
          ...(missing.length ? [`missing ${missing.join(", ")} (in the signature, absent from \`props\`)`] : []),
          ...(extra.length ? [`extra ${extra.join(", ")} (in \`props\`, absent from the signature)`] : []),
        ].join("; ")}`;
    findings.push({ category: "props-metadata-mismatch", severity: 2, nodeIds: [c.id], nodeNames: [c.name], why });
  }

  // skips-family-shell (#87, a REPORT not a rule) — the members of a family that do NOT compose the shell
  // the rest of it does. A family is a folder or a trailing-PascalCase-word group; a shell is any component
  // the family composes at or above FAMILY_SHELL_SHARE and that its kit composes widely.
  //
  // This is the question `dupes`/`similar` structurally CANNOT answer, and the cost of answering it by hand
  // is measured: a ~480k-token fork reading a dozen srcTexts. Fuzzy name + prop-contract distance never
  // sees "shares a shell primitive", because the two components' props are unrelated — a toggle card has
  // `enabled`/`onToggle` and an info card has `value`/`label`, so none of the 51 card-suffixed ids ever
  // appeared together in a dupes report. What answered it in ONE call was `bsc components used-by ui-card`. This is
  // that call, run for every family at once. Rust twin: the skips-family-shell loop in graph_health.rs.
  // Keyed `"<grouping>::<name>"`, split on the FIRST `::` so a folder path is never truncated.
  // "folder" sorts before "name suffix", which is what makes the dedupe below keep the specific grouping.
  const familyOf = new Map<string, ComponentRecord[]>();
  const addTo = (key: string, c: ComponentRecord) => (familyOf.get(key) ?? familyOf.set(key, []).get(key)!).push(c);
  for (const c of comps) {
    const folder = (c.folder ?? "").trim();
    if (folder) addTo(`folder::${folder}`, c);
    const suffix = nameSuffix(c.name);
    if (suffix) addTo(`name suffix::${suffix}`, c);
  }
  // How many DISTINCT in-kit components compose each name — the `used-by` count this check is built on.
  const composersInKit = new Map<string, number>();
  for (const c of comps) for (const dep of new Set(c.composes)) composersInKit.set(dep, (composersInKit.get(dep) ?? 0) + 1);
  // A component's folder family and its name-suffix family usually overlap, so both can reach the SAME
  // (shell, outliers) verdict. That is one fact, reported once — and "folder" sorts first, so the more
  // specific grouping is the one that keeps it.
  const saidAlready = new Set<string>();
  for (const [key, members] of [...familyOf].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < FAMILY_MIN) continue;
    const sep = key.indexOf("::");
    const [grouping, famName] = [key.slice(0, sep), key.slice(sep + 2)];
    const within = new Map<string, number>();
    for (const m of members) for (const dep of new Set(m.composes)) within.set(dep, (within.get(dep) ?? 0) + 1);
    for (const [shell, composedBy] of [...within].sort(([a], [b]) => a.localeCompare(b))) {
      // Not a widely-composed primitive — an accident of two siblings sharing a helper, not a shell.
      if ((composersInKit.get(shell) ?? 0) < FAMILY_SHELL_COMPOSERS_MIN) continue;
      // Not the family's shell; a minority convention is not a standard to hold the others to.
      if (composedBy < FAMILY_SHELL_SHARE * members.length) continue;
      // The shell is never an outlier in its own family — it cannot compose itself.
      const outliers = members.filter((m) => m.name !== shell && !m.composes.includes(shell));
      if (!outliers.length || outliers.length > FAMILY_MAX_OUTLIERS) continue;
      const dedupe = `${shell}::${outliers.map((o) => o.id).join(",")}`;
      if (saidAlready.has(dedupe)) continue;
      saidAlready.add(dedupe);
      const names = outliers.map((o) => o.name);
      const one = outliers.length === 1;
      findings.push({
        category: "skips-family-shell", severity: 2,
        nodeIds: outliers.map((o) => o.id), nodeNames: names,
        why: `${composedBy} of the ${members.length} components in the \`${famName}\` ${grouping} family compose \`${shell}\`; ${names.join(", ")} do${one ? "es" : ""} not — the outlier${one ? "" : "s"} of an otherwise consistent family`,
      });
    }
  }

  // phantom-compose — a component that DECLARES `composes` children its own source never renders. The
  // composition graph draws edges straight from `composes` (`buildComposesEdges`), so a phantom edge makes
  // the graph claim a composition that doesn't happen AND masks orphan detection (the phantom in-edge makes
  // the child look used). Only USER-authored components with own-module source: a built-in's store record is
  // a contract catalog (its `source` is stripped, #2794, and its `srcText` is an illustrative snippet — not
  // the real module that renders the child), so scanning it would false-positive. A SLOT-SHELL is exempt —
  // its composed children legitimately arrive via a content slot, not a direct render (the informational
  // slot-shell finding already explains it). Rust twin: the phantom-compose loop in graph_health.rs. (#3111)
  for (const c of comps) {
    if (c.builtin || c.composes.length === 0) continue;
    const src = ownModuleSource(c, comps);
    if (!src) continue; // no scannable module (a spec) → no-implementation owns it
    if (c.props.some((p) => isNodeSlotProp(p))) continue; // slot-shell: composes may arrive via a slot
    const rendered = jsxTagNames(src);
    if (rendered.size === 0) continue; // renders no JSX at all → a stub, not a phantom composition
    const phantom = c.composes.filter((name) => !rendered.has(name));
    if (phantom.length === 0) continue;
    findings.push({ category: "phantom-compose", severity: 2, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} declares it composes ${phantom.join(", ")} but its source never renders ${phantom.length === 1 ? "it" : "them"} — a phantom composition edge (the graph draws a composition that doesn't happen, and the false edge hides the child from orphan detection)` });
  }

  // no-empty-state / no-loading-state / no-error-state (informational, #3135/#3555) — the preview's
  // data-state switcher can only SHOW a state a component SUPPORTS. A DATA component (has a collection/array
  // prop), scanned from its own module source, is flagged when it lacks: (a) an EMPTY render — no
  // `EmptyState` and no `Array.isArray`/`.length` empty-guard, so its empty preview matches loaded; (b) a
  // `loading`-family prop, so its loading preview can't skeleton; or (c) an `error`-family prop, so its
  // error preview can't render. Guides the designer session to add the missing state. Rust twin:
  // the same loop in graph_health.rs.
  for (const c of comps) {
    const src = ownModuleSource(c, comps);
    if (!src) continue;
    const collections = c.props.filter(isCollectionProp).map((p) => p.name);
    if (collections.length === 0) continue; // not a data component
    if (!/\bEmptyState\b/.test(src) && !/\bArray\.isArray\b|\.length\b/.test(src)) {
      findings.push({ category: "no-empty-state", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} takes data (${collections.join(", ")}) but renders no distinct EMPTY state (no EmptyState, no empty-data branch) — its empty preview shows the same as loaded; add an EmptyState / empty-data render so its empty state is viewable` });
    }
    if (!c.props.some(isLoadingProp)) {
      findings.push({ category: "no-loading-state", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} takes data (${collections.join(", ")}) but exposes no \`loading\` prop — the preview can't show its LOADING state; add a boolean \`loading\` prop that renders a skeleton` });
    }
    if (!c.props.some(isErrorProp)) {
      findings.push({ category: "no-error-state", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
        why: `${c.name} takes data (${collections.join(", ")}) but exposes no \`error\` prop — the preview can't show its ERROR state; add an \`error\` prop (message string or boolean) that renders an error state` });
    }
  }

  // no-analytics (informational, #3810) — an INTERACTIVE component (exposes an action/event prop) that
  // declares no analytics events. Instrumentation is a per-node data CONTRACT — like the behavior/motion a
  // node already carries — so every interactive node should declare what it emits, and any app composed
  // from these nodes is instrumented by construction. Own-module (user-authored) only; built-ins skipped.
  // Rust twin: the same loop in graph_health.rs.
  for (const c of comps) {
    if (!ownModuleSource(c, comps)) continue;
    if ((c.analytics?.length ?? 0) > 0) continue;
    const actions = c.props.filter(isActionProp).map((p) => p.name);
    if (actions.length === 0) continue;
    findings.push({ category: "no-analytics", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} is interactive (${actions.join(", ")}) but declares no analytics events — an app composed from it captures nothing when the user acts; add an \`analytics\` manifest declaring the events it emits (data, not code)` });
  }

  // no-tests (informational, #3878) — an IMPLEMENTED own-module component carrying no tests. Tests are a
  // per-node data CONTRACT, the same shape as the analytics manifest one field over: once a component's
  // source is a store record compiled at runtime, a test file under src/** is no longer beside what it
  // tests. Narrow on purpose — built-ins skipped; a SPEC-ONLY node skipped (it already earns
  // `no-implementation`, and one cause should not raise two findings); and only INTERACTIVE nodes flagged,
  // the same line no-analytics draws. Flagging every implemented node lit up essentially the whole graph.
  // Rust twin: the same loop in graph_health.rs.
  for (const c of comps) {
    if (!ownModuleSource(c, comps)) continue;
    if ((c.tests?.length ?? 0) > 0) continue;
    if (!c.props.some(isActionProp)) continue;
    findings.push({ category: "no-tests", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} is interactive and implemented but carries no tests — its source lives in the graph while anything covering it does not, so the node can be revised with nothing to catch a regression; add a \`tests\` manifest (an array of { name, src }), data alongside the node like its analytics events` });
  }

  // slot-shell (informational) — a composite whose composed children arrive via ReactNode CONTENT SLOTS.
  // Standalone (no slots passed) it renders a demo/placeholder fallback, not its assembled function, so a
  // preview looks non-functional even though it isn't (#2921). Explains e.g. GraphExplorerPage /
  // AnalyticsPage. Detect: it `composes` ≥1 child AND exposes ≥1 non-`children` ReactNode slot prop.
  for (const c of comps) {
    if (c.composes.length === 0) continue;
    const slots = c.props.filter((p) => isNodeSlotProp(p)).map((p) => p.name);
    if (slots.length === 0) continue;
    findings.push({ category: "slot-shell", severity: 1, nodeIds: [c.id], nodeNames: [c.name],
      why: `${c.name} is a slot-driven composite — its composed children (${c.composes.join(", ")}) arrive via content slots (${slots.join(", ")}), so a standalone preview renders a demo placeholder, not its assembled function; fill the slots to see it` });
  }

  return findings.sort((a, b) => b.severity - a.severity || (a.nodeNames[0] ?? "").localeCompare(b.nodeNames[0] ?? ""));
}

// ── motion checks (#3163, `bsc components doctor --motion`) ──────────────────────────────────────────────────
// Four MECHANICAL faults an author used to hand-diagnose from a broken preview, now surfaced from the data.
// They scan a component's INLINE animation defs (the object entries of `animations`; a name-ref string
// points at the shared kit library, which the doctor doesn't resolve) against its rendered markup. The
// Rust twin is `graph_health::analyze_motion` — keep both in lockstep (categories, severities, rules).

/** The INLINE animation defs on a component (its `animations` object entries; name-ref strings skipped). */
function inlineAnimations(c: ComponentRecord): KitAnimation[] {
  return (c.animations ?? []).filter(
    (a): a is KitAnimation => typeof a === "object" && a !== null && typeof (a as KitAnimation).name === "string",
  );
}

/** The class HOOK tokens a `selector` targets — every `.<ident>` (#3163 check a). */
function selectorClasses(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** The set of CSS declaration PROPERTIES an animation's keyframes touch (#3163 checks b/c). */
function keyframeProps(anim: KitAnimation): Set<string> {
  const props = new Set<string>();
  for (const decls of Object.values(anim.keyframes ?? {})) for (const p of Object.keys(decls ?? {})) props.add(p);
  return props;
}

/** The component's rendered markup to scan — its module `source` + usage `srcText` (a class hook /
 *  pathLength / transform attribute may live in either). */
function componentMarkup(c: ComponentRecord): string {
  return `${c.source ?? ""}\n${c.srcText ?? ""}`;
}

/**
 * Analyze a kit's components for MOTION-graph faults (#3163) — the `bsc components doctor --motion` checks,
 * mirrored from `graph_health::analyze_motion`. Ranked most-severe first (stable name tiebreak). Pure.
 * Four checks:
 *   (a) motion-dead-selector — an animation `selector` whose class hook the component's source never renders.
 *   (b) motion-dash-no-pathlength — a stroke-dash(array|offset) keyframe on a component that sets no pathLength.
 *   (c) motion-transform-attr — a CSS `transform` keyframe on a component using an SVG `transform=` ATTRIBUTE.
 *   (d) motion-name-collision — an inline animation NAME declared by 2+ components in the same kit.
 */
export function analyzeMotion(comps: ComponentRecord[]): HealthFinding[] {
  const findings: HealthFinding[] = [];
  // (d) per-kit collision groups: `${kit} ${animName}` → the owning components (deduped by id).
  const collisions = new Map<string, { id: string; name: string }[]>();

  for (const c of comps) {
    const anims = inlineAnimations(c);
    if (anims.length === 0) continue;
    const markup = componentMarkup(c);
    for (const anim of anims) {
      const props = keyframeProps(anim);
      // (a) dead selector hook — the animation targets a class the source never renders.
      if (anim.selector) {
        const dead = selectorClasses(anim.selector).filter((cls) => !markup.includes(cls));
        if (dead.length) {
          findings.push({ category: "motion-dead-selector", severity: HEALTH_SEVERITY["motion-dead-selector"],
            nodeIds: [c.id], nodeNames: [c.name],
            why: `${c.name}'s animation \`${anim.name}\` targets ${dead.map((d) => `\`.${d}\``).join(", ")} but its source renders no such element — the animation matches nothing (a dead selector hook)` });
        }
      }
      // (b) stroke-dash keyframe with no pathLength — a draw-in that needs a known geometry length.
      const dash = [...props].filter((p) => p === "stroke-dashoffset" || p === "stroke-dasharray");
      if (dash.length && !/pathlength/i.test(markup)) {
        findings.push({ category: "motion-dash-no-pathlength", severity: HEALTH_SEVERITY["motion-dash-no-pathlength"],
          nodeIds: [c.id], nodeNames: [c.name],
          why: `${c.name}'s animation \`${anim.name}\` animates ${dash.map((d) => `\`${d}\``).join(", ")} but its source sets no \`pathLength\` — a stroke-dash draw needs a known path length to animate predictably` });
      }
      // (c) CSS transform keyframe on a transform-ATTRIBUTED SVG element — the two don't compose.
      if (props.has("transform") && /transform\s*=/.test(markup)) {
        findings.push({ category: "motion-transform-attr", severity: HEALTH_SEVERITY["motion-transform-attr"],
          nodeIds: [c.id], nodeNames: [c.name],
          why: `${c.name}'s animation \`${anim.name}\` sets a CSS \`transform\` keyframe, but its source uses an SVG \`transform=\` ATTRIBUTE — CSS transforms and the SVG transform attribute don't compose (animate the attribute, or drop the attribute and transform via CSS)` });
      }
      // (d) collect this inline name for the cross-component collision pass.
      const key = `${c.kitId} ${anim.name}`;
      const owners = collisions.get(key) ?? collisions.set(key, []).get(key)!;
      if (!owners.some((o) => o.id === c.id)) owners.push({ id: c.id, name: c.name });
    }
  }

  // (d) an inline animation NAME declared by 2+ components in a kit — a cross-component keyframe collision.
  for (const [key, owners] of collisions) {
    if (owners.length < 2) continue;
    const animName = key.slice(key.indexOf(" ") + 1);
    const sorted = [...owners].sort((a, b) => a.name.localeCompare(b.name));
    findings.push({ category: "motion-name-collision", severity: HEALTH_SEVERITY["motion-name-collision"],
      nodeIds: sorted.map((o) => o.id), nodeNames: sorted.map((o) => o.name),
      why: `inline animation \`${animName}\` is declared by ${owners.length} components (${sorted.map((o) => o.name).join(", ")}) — same-named keyframes across components collide; namespace them (#3163) or lift the shared one into the kit's animation library` });
  }

  return findings.sort((a, b) => b.severity - a.severity || (a.nodeNames[0] ?? "").localeCompare(b.nodeNames[0] ?? ""));
}

/** Node id → its MOST-SEVERE health category — what the graph badges each node with (#2680). */
export function nodeHealth(comps: ComponentRecord[]): Map<string, HealthCategory> {
  const map = new Map<string, HealthCategory>();
  for (const f of analyzeGraphHealth(comps)) {
    for (const id of f.nodeIds) {
      const cur = map.get(id);
      if (!cur || HEALTH_SEVERITY[f.category] > HEALTH_SEVERITY[cur]) map.set(id, f.category);
    }
  }
  return map;
}
