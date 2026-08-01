// Page binding analysis (#4169, epic #3604) — given a graph page's source, work out WHICH BEHAVIOURS it
// needs from the app and which of those are not registered.
//
// This is the half of shadow mode that matters for the epic. "Presentation is data, behavior stays code":
// a page node carries the skeleton, and everything it does — store reads, hooks, `usePoll`, `bscJson`,
// feature libs — arrives as a REGISTERED module the loader's `require` hands back (`moduleRegistry`). An
// import with no registration does not fail quietly: `makeRequire` throws by name, the error boundary
// catches it, and the page shows its fallback. So "is this page ready to render from the graph?" is
// exactly "is every specifier it requires registered?" — and today that is a judgement call. This makes it
// a list.
//
// It mirrors what the loader does at runtime, statically: `routeImport` consults the graph resolver FIRST
// (a sibling by id, or a component whose `provides` matches the specifier) and vendors that source into
// the same compile; anything else stays external and goes through the registry. So the walk below vendors
// what the loader would vendor, recurses into it, and collects what is left over — the exact set of
// `require()` calls the compiled module will make. No esbuild needed, which is why this runs in a node
// test as happily as in the app.

/** One `… from "specifier"` in a source: the module and the symbols taken from it. */
export interface ImportRef {
  specifier: string;
  /** Imported names (the ORIGINAL name, not the local alias) — the "behaviour names" of a report. A
   *  namespace import is `*`; a default import is `default`; a bare side-effect import has none. */
  symbols: string[];
}

/** A specifier the loaded page will `require()` at runtime, and which of its modules asked for it. */
export interface ExternalImport extends ImportRef {
  /** The graph module ids whose source imports this specifier (the page itself, or a vendored sibling). */
  importedBy: string[];
}

/** Resolve a specifier to another graph component's source, exactly as the app's `resolveGraphSource`
 *  does — `@/components/<id>` for a sibling, or a record whose `provides` matches (#3660). `null` when the
 *  specifier is not a graph node, in which case it stays external and must be registered. */
export type SiblingResolver = (specifier: string) => { id: string; source: string } | null;

/** `import`/`export … from "x"`, capturing the clause so its symbols (and its `type` marker) can be read.
 *  The re-export form is included deliberately: esbuild compiles `export { X } from "./y"` to the same
 *  `require("./y")` an import produces, so an unregistered re-export breaks the loader identically —
 *  the gap that shipped `projectspage` broken (#3874). */
//  The clause is `[^"';]*?` — it may span lines (a multi-line named-import list) but may cross neither a
//  quote nor a statement end, so the scan cannot run past a side-effect import or an `export function`
//  into the next `from "…"` and invent an import that is not there.
const FROM_IMPORT = /^[ \t]*(import|export)\s+([^"';]*?)\s*from\s*["']([^"']+)["']/gm;

/** A side-effect import (`import "./x.css"`) — no clause, still a `require` at runtime. */
const BARE_IMPORT = /^[ \t]*import\s*["']([^"']+)["']/gm;

/** Every module specifier a source imports, with the symbols it takes.
 *
 *  TYPE-ONLY imports are excluded: esbuild erases them, so they never become a `require` and an
 *  unregistered one cannot break anything. Reporting them would pad the worklist with work that is not
 *  work. A clause with even one value binding is kept — that module IS required. */
export function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const m of source.matchAll(FROM_IMPORT)) {
    const clause = m[2];
    if (/^type\s/.test(clause)) continue; // `import type { X } from …` — erased
    const symbols = clauseSymbols(clause);
    // `import { type A, type B } from …` — every binding erased, so the whole import goes with them.
    if (symbols.length > 0 && symbols.every((s) => s.startsWith("type "))) continue;
    refs.push({ specifier: m[3], symbols: symbols.map((s) => s.replace(/^type\s+/, "")) });
  }
  for (const m of source.matchAll(BARE_IMPORT)) refs.push({ specifier: m[1], symbols: [] });
  return refs;
}

/** The names an import clause binds, as written on the MODULE's side (`{ a as b }` → `a`), with an inline
 *  `type ` marker preserved so [`parseImports`] can spot an all-type clause. */
function clauseSymbols(clause: string): string[] {
  const names: string[] = [];
  const braced = /\{([\s\S]*)\}/.exec(clause);
  const head = clause.slice(0, braced ? clause.indexOf("{") : undefined).replace(/,\s*$/, "").trim();
  if (head) names.push(head.startsWith("*") ? "*" : "default"); // `* as ns` / `export *` vs a default import
  if (braced) {
    for (const part of braced[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** The full binding picture for one graph page. */
export interface BindingReport {
  /** Graph modules pulled into the page's compile (the page id first, then vendored siblings). */
  vendored: string[];
  /** Specifiers the compiled page will `require()` from the app. */
  external: ExternalImport[];
  /** The subset of `external` with no registered module — every one of these throws when the page loads. */
  unbound: ExternalImport[];
}

/**
 * Walk a graph page's source the way the loader compiles it — vendoring graph siblings, recursing into
 * them, and collecting every specifier that stays external — then split those by whether the app has
 * registered them.
 *
 * `isRegistered` is injected (the live `isAppModule`, or a fake in a test) so this stays pure. It is read
 * at CALL time, which matters: a feature's platform surface registers when its module loads, so a report
 * taken before that reads as unbound. The runner loads a page's feature before analysing it.
 */
export function analyzeBindings(
  page: { id: string; source: string },
  resolveSibling: SiblingResolver,
  isRegistered: (specifier: string) => boolean,
): BindingReport {
  const vendored: string[] = [];
  const seen = new Set<string>();
  const bySpecifier = new Map<string, ExternalImport>();
  const queue: { id: string; source: string }[] = [page];

  while (queue.length) {
    const module = queue.shift() as { id: string; source: string };
    if (seen.has(module.id)) continue; // a sibling cycle must not spin the walk
    seen.add(module.id);
    vendored.push(module.id);
    for (const ref of parseImports(module.source)) {
      const sibling = resolveSibling(ref.specifier);
      if (sibling) {
        queue.push(sibling);
        continue;
      }
      const existing = bySpecifier.get(ref.specifier);
      if (existing) {
        for (const s of ref.symbols) if (!existing.symbols.includes(s)) existing.symbols.push(s);
        if (!existing.importedBy.includes(module.id)) existing.importedBy.push(module.id);
      } else {
        bySpecifier.set(ref.specifier, { specifier: ref.specifier, symbols: [...ref.symbols], importedBy: [module.id] });
      }
    }
  }

  const external = [...bySpecifier.values()].sort((a, b) => a.specifier.localeCompare(b.specifier));
  return { vendored, external, unbound: external.filter((e) => !isRegistered(e.specifier)) };
}
