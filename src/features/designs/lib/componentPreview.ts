// componentPreview (#2824) — assemble the in-memory files + bootstrap entry for a component's
// build-and-iframe preview. Pure (no esbuild, no DOM) so it's unit-testable; the actual esbuild-wasm
// bundle + iframe live in the shared preview transport.
//
// Two source paths:
//   • BUILT-IN react-ui component → its verbatim `source` from the packaged kit artifact, PLUS the
//     artifact's whole component + `runtime` (@/ dependency-closure) set as in-memory files. esbuild
//     tree-shakes to just what the entry imports; the mem plugin resolves `@/…` to these files and
//     bare imports (react, d3) to esm.sh.
//   • USER-AUTHORED component → its own self-contained `source` (imports libraries as bare specifiers,
//     which resolve from esm.sh). This is the case that renders arbitrary-library components — a d3
//     component previews with no install.
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
 * via its `@/…` spec. USER-AUTHORED (`comp.source` set, not in the artifact): its self-contained source
 * at `comp.src` (or a synthetic path), imported by the entry.
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

  // User-authored: needs its own self-contained implementation source.
  if (comp.source && comp.source.trim()) {
    const path = comp.src?.trim() ? comp.src : `user/${comp.id || "component"}.tsx`;
    const importSpec = `@/${stripExt(path)}`;
    const files: Record<string, string> = { [path]: comp.source, [PREVIEW_ENTRY]: bootstrapSource(comp, importSpec) };
    return { files, entry: PREVIEW_ENTRY };
  }

  return null;
}
