// Shared module-path resolution for the in-browser previews (#3246 — consolidated from three copies:
// designs/lib/graphHealth, designs/lib/componentPreview, and shared/lib/preview/componentBundle).
// Pure string helpers — no DOM, no esbuild.

/** Collapse empty/`.`/`..` segments of a split module path (`..` pops the parent), joining with `/`. Pure. */
export function collapseSegments(segs: string[]): string {
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Resolve an INTERNAL import `spec` — imported FROM module `fromRel` (a `src/`-relative path) — to its
 *  `src/`-relative module BASE (no extension), or `null` when it isn't internal. `@/x` → `x`; a relative
 *  path is joined onto the importer's dir and `.`/`..` segments collapsed. Rust twin: `resolve_internal_base`. */
export function resolveInternalBase(spec: string, fromRel: string): string | null {
  let segs: string[];
  if (spec.startsWith("@/")) {
    segs = spec.slice(2).split("/");
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    const fromDir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
    segs = (fromDir ? fromDir.split("/") : []).concat(spec.split("/"));
  } else {
    return null;
  }
  return collapseSegments(segs);
}
