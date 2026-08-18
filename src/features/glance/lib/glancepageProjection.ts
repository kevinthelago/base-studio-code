// The glancepage PROJECTION (#the-glance-record-lost-the-architect-and-four-other-fixes).
//
// WHY THIS EXISTS. Glance does not render `GlanceWorkspace.tsx`. `lazyWorkspaces.tsx` aliases the
// workspace to `GlanceGraphHost`, which renders `<GraphComponent id="glancepage" />` (#4185, epic
// #3604) — so the running cockpit is the `glancepage` RECORD, and the `.tsx` is its source of truth
// only if something keeps the two in step. Nothing did. The record was last mirrored by hand in
// bc3f38d1 (2026-08-12) and then drifted for weeks, silently losing the architect drill
// (#architect-node-expands-into-system-sessions), the contract re-read
// (#architect-wires-project-relationships), plan.db outranking the persisted fleet, the progress
// ref-namespace split, and the director progress fallback. Every one of those was live in `src/`
// and dead in the app.
//
// THE RECORD IS A PROJECTION, NOT A COPY, and all three differences below are deliberate — reproduce
// them or the page breaks:
//
//   1. The AS GRAPH SOURCE preamble, which tells a reader of the record where its behaviour comes from.
//   2. First-party RELATIVE specifiers rewritten ABSOLUTE. The runtime loader resolves a record's
//      imports against the app's module registry, not against a directory, so `./lib/glanceData` has
//      no meaning to it. Sibling COMPONENTS take the SAME prefix rule as everything else
//      (`page-records-import-siblings-by-specifier`): they used to be rewritten to
//      `@/components/<record-id>`, which resolves in the loader and nowhere else, and that is what made
//      this record impossible to materialize into `.bsc-records/` — i.e. what kept `GlanceWorkspace.tsx`
//      alive. They are registered in `graphPlatform.ts` instead, so ONE specifier satisfies both
//      resolvers.
//   3. `import "./glance.css"` STRIPPED. The loader cannot resolve a CSS side-effect import;
//      `GlanceGraphHost` owns the stylesheet instead (see its header).
//
// Keeping this as a pure function, rather than inline in the generator, is what lets the guard test
// assert the record IS the projection — the check that would have caught the drift.

/** The record's preamble — four lines, verbatim, ahead of the file's own header. */
export const GRAPH_SOURCE_HEADER = [
  "// Glance → the cockpit workspace (#2206), AS GRAPH SOURCE (#4185, epic #3604). Transcribed from the live feature file: the runtime",
  "// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui",
  "// design system + the store via appModules, the glance lib/hook surface via the glance graph-platform,",
  "// and the sibling components via the glance graph-platform too). Behaviour runs here.",
];

/** Sibling COMPONENTS no longer get a special specifier, and that is the point of
 *  `page-records-import-siblings-by-specifier`.
 *
 *  They used to be rewritten to `@/components/<id>` — the graph record form. That resolves in the runtime
 *  loader and NOWHERE ELSE: `@/components/<id>` is not a path, so a record carrying it cannot be
 *  materialized into `.bsc-records/` and imported by the bundle. It is exactly what made `glancepage`
 *  un-retirable, and what `retire-module.mjs`'s `importsSiblingsByRecordId` now refuses on.
 *
 *  So a sibling is projected like every other relative import — `./GlanceCanvas` →
 *  `@/features/glance/GlanceCanvas` — and `graphPlatform.ts` REGISTERS it, the same as the rest of the
 *  glance surface. The loader resolves it through the registry; the bundle resolves it through the file
 *  today and through `.bsc-records/` once the file is retired. One specifier, both resolvers.
 *
 *  Kept as an empty export rather than deleted: `glancepageRecord.gen.test.ts` asserts the projection
 *  emits no `@/components/` specifier, and a named, documented empty is what tells the next reader this
 *  was decided rather than forgotten. */
export const SIBLING_RECORDS: Record<string, string> = {};

/** Relative specifiers that are NOT sibling components resolve as feature paths under the glance slice. */
const FEATURE_PREFIX = "@/features/glance/";

/** The CSS side-effect import the loader cannot resolve — dropped; the host imports it instead. */
const CSS_IMPORT = 'import "./glance.css";';

/**
 * Project `GlanceWorkspace.tsx` source into the `glancepage` record's `srcText`.
 *
 * @param src the file's verbatim contents (LF-normalized by the caller).
 * @returns the record source: preamble + the file with its relative imports resolved and the CSS
 *   side-effect import removed.
 * @throws if a relative specifier points OUT of the glance slice (`../`), which the record has no way
 *   to express — better to fail the generator than to emit a record that compiles to the wrong module.
 */
export function projectGlancePage(src: string): string {
  const out: string[] = [];
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === CSS_IMPORT) continue;
    out.push(rewriteSpecifier(line));
  }
  return [...GRAPH_SOURCE_HEADER, ...out].join("\n");
}

/** Rewrite one line's relative import specifier, if it has one. */
function rewriteSpecifier(line: string): string {
  return line.replace(/from "(\.\.?\/[^"]+)"/, (_match, spec: string) => {
    if (SIBLING_RECORDS[spec]) return `from "${SIBLING_RECORDS[spec]}"`;
    if (spec.startsWith("../")) {
      throw new Error(
        `glancepage projection: cannot express the out-of-slice specifier ${spec}. A record resolves ` +
        `against the module registry, so an import that leaves the glance slice needs an explicit ` +
        `@/… path in GlanceWorkspace.tsx, or an entry in SIBLING_RECORDS if it is a graph component.`,
      );
    }
    return `from "${FEATURE_PREFIX}${spec.slice(2)}"`;
  });
}
