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
//     NOT buildable — its `@/` first-party imports have no closure to resolve against and its `…`
//     placeholders don't compile — so it stays an honest empty state.
//
// The bootstrap imports the component and mounts it with sample props derived from its prop schema, so a
// component with required props still renders something representative (not a curated mock).
import type { ComponentRecord, PropSpec } from "./model";

/** The buildable slice of the packaged kit artifact — each component's verbatim `source` and the
 *  `runtime` (non-component @/ closure), both keyed by their `src/`-relative path. This is exactly the
 *  `source` + `runtime` the `react-ui.json` artifact carries (built by reactUiKit.gen, consumed by
 *  `bsc ui emit`); the frontend already bundles it. */
export interface KitArtifact {
  components: { id: string; src: string; source?: string }[];
  runtime?: Record<string, string>;
}

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
  if (s.includes("…")) return false; // the `…` usage-snippet placeholder ⇒ won't compile
  if (/["']@\//.test(s)) return false; // `@/` first-party import ⇒ no closure to resolve it against
  return true;
}

/**
 * A best-effort sample value (as a JS source literal) for a prop, from its (loosely-typed) schema, or
 * `null` to omit it. Enough to render a component whose required props would otherwise be missing —
 * NOT a curated example. `children` is handled by the caller (it becomes the element's child).
 */
export function samplePropValue(p: PropSpec): string | null {
  const t = (p.type || "").toLowerCase();
  const isFn = t.includes("=>") || t.includes("function") || t.includes("void") || /^on[A-Z]/.test(p.name);
  if (isFn) return "() => {}";
  if (t.includes("reactnode") || t.includes("node")) return JSON.stringify(prettyName(p.name));
  if (t === "string" || t.includes("string")) return JSON.stringify(sampleString(p.name));
  if (t === "number" || t.includes("number")) return numberSample(p.name);
  if (t === "boolean" || t.includes("boolean")) return "true";
  if (t.includes("[]") || t.includes("array")) return "[]";
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
/** A number sample — a 0–1 fraction for ratio-ish props, else a small integer. */
function numberSample(name: string): string {
  return /value|fraction|ratio|progress|percent|opacity/i.test(name) ? "0.6" : "3";
}

/**
 * The bootstrap entry source: import the component by `importSpec` and mount it into `#root` with the
 * sample props. Uses `createElement` (not JSX children) so children/props compose without JSX parsing
 * quirks. Resolves the component export by `name`, falling back to the default export.
 */
export function bootstrapSource(comp: ComponentRecord, importSpec: string): string {
  const childText = comp.props.find((p) => p.name === "children")
    ? JSON.stringify(prettyName(comp.name))
    : null;
  const propEntries = comp.props
    .filter((p) => p.name !== "children")
    .map((p) => {
      const v = samplePropValue(p);
      return v == null ? null : `${JSON.stringify(p.name)}: ${v}`;
    })
    .filter(Boolean);
  const propsLiteral = `{ ${propEntries.join(", ")} }`;
  const childArg = childText ? `, ${childText}` : "";
  return [
    `import { createRoot } from "react-dom/client";`,
    `import { createElement } from "react";`,
    `import * as __mod from "${importSpec}";`,
    `const __C = __mod[${JSON.stringify(comp.name)}] ?? __mod.default;`,
    `if (!__C) throw new Error("preview: no export ${comp.name} (or default) in ${importSpec}");`,
    `createRoot(document.getElementById("root")).render(`,
    `  createElement("div", { style: { padding: 20, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100%" } },`,
    `    createElement(__C, ${propsLiteral}${childArg})));`,
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
 */
export function componentPreviewFiles(comp: ComponentRecord, artifact: KitArtifact): ComponentPreviewBuild | null {
  const inArtifact = comp.src ? artifact.components.find((c) => c.src === comp.src && c.source) : undefined;

  if (inArtifact) {
    const files: Record<string, string> = {};
    for (const [path, src] of Object.entries(artifact.runtime ?? {})) files[path] = src;
    for (const c of artifact.components) if (c.source) files[c.src] = c.source;
    const importSpec = `@/${stripExt(inArtifact.src)}`;
    files[PREVIEW_ENTRY] = bootstrapSource(comp, importSpec);
    return { files, entry: PREVIEW_ENTRY };
  }

  // User-authored: build from its own self-contained implementation source — the explicit `source`
  // field when present, else a `srcText` that is a real module (not the usual usage snippet, #2828).
  const userSource =
    comp.source && comp.source.trim() ? comp.source
    : looksBuildableModule(comp.srcText) ? comp.srcText
    : null;
  if (userSource) {
    const path = comp.src?.trim() ? comp.src : `user/${comp.id || "component"}.tsx`;
    const importSpec = `@/${stripExt(path)}`;
    const files: Record<string, string> = { [path]: userSource, [PREVIEW_ENTRY]: bootstrapSource(comp, importSpec) };
    return { files, entry: PREVIEW_ENTRY };
  }

  return null;
}
