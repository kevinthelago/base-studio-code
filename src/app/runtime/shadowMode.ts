// Shadow mode (#4169, step 1 of the graph-renders-the-app reframe) — build every page from the graph
// ALONGSIDE the app, compare it to the files, and report. It renders nothing and changes nothing.
//
// WHY THIS BEFORE THE TOGGLE. The epic's open question is not "graph or files" but "what fraction of a
// page is expressible as data, and how complete is the registry for the rest". A toggle over an
// incomplete registry does not give a migration — it gives a fast way to render a shell that does
// nothing (#3605's "built, not mounted" state, and #3758's Settings roll-back). So the soft signal comes
// first: shadow mode produces the coverage data that does not exist today, and that data is the worklist
// for the registry work, instead of a guess.
//
// WHAT IT COSTS, AND WHY IT IS ON DEMAND. Reading the registry honestly means the feature's platform
// surface has to be loaded — a page's modules register when its feature's host module evaluates — so a
// sweep imports every migrated feature's barrel. That is the same work a first visit to each page does,
// but doing it unasked would eagerly load the whole app and muddy exactly the boot-cost picture this
// project measures. So nothing runs at boot: the sweep runs when asked for.
//
//   window.__bscShadow.run()               → every page
//   window.__bscShadow.run("mcppage")      → one page (loads only that feature)
//   window.__bscShadow.last()              → the last report, without re-running
//
// The report goes to the app log (`base-studio-code.log`), next to the `graph-loader` lines that say what
// actually mounted, and is returned for inspection in the console.
import { useAppStore } from "@/store";
import { log } from "@/shared/lib/core/log";
import { isAppModule } from "@/shared/lib/runtime/moduleRegistry";
import { compileToCjs } from "@/shared/lib/runtime/componentLoader";
import { resolveGraphSource, GRAPH_SIBLING_PREFIX } from "@/shared/lib/runtime/graphResolver";
import { outlineJsx } from "@/shared/lib/runtime/shadow/jsxOutline";
import { diffOutlines } from "@/shared/lib/runtime/shadow/outlineDiff";
import { analyzeBindings, type SiblingResolver } from "@/shared/lib/runtime/shadow/pageBinding";
import {
  buildPageShadow, formatShadowLine, formatShadowSummary,
  type ModuleShadow, type PageShadow,
} from "@/shared/lib/runtime/shadow/shadowReport";
import { SHADOW_PAGES, loadFileSource, type ShadowPageDef } from "./shadowPages";

/** The last sweep's report, so a caller can re-read it without paying for another one. */
let lastReport: PageShadow[] | null = null;

/** A graph record as shadow mode reads it — structural, so this file does not depend on the Design
 *  Studio's record type (the app shell may not reach into a feature's internals). */
interface GraphRecord {
  id: string;
  srcText?: string;
  provides?: string;
}

/** The loader's sibling resolution, over a records snapshot: `@/components/<id>` for a sibling (#3606),
 *  or a record whose `provides` matches the specifier (#3660). Mirrors `resolveGraphSource`, but returns
 *  the record's ID as well — the binding walk needs it to attribute an import and to break cycles. */
function siblingResolver(records: GraphRecord[]): SiblingResolver {
  return (specifier) => {
    const record = specifier.startsWith(GRAPH_SIBLING_PREFIX)
      ? records.find((r) => r.id === specifier.slice(GRAPH_SIBLING_PREFIX.length))
      : records.find((r) => r.provides === specifier);
    return record?.srcText ? { id: record.id, source: record.srcText } : null;
  };
}

/** Compare one module's graph record against its file. */
async function shadowModule(def: { recordId: string; file: string | null }, records: GraphRecord[]): Promise<ModuleShadow> {
  const record = records.find((r) => r.id === def.recordId);
  const fileSource = await loadFileSource(def.file);
  if (!record?.srcText) return { recordId: def.recordId, file: def.file, status: "no-graph-node", diff: null };
  if (!fileSource) return { recordId: def.recordId, file: def.file, status: "no-file-baseline", diff: null };
  const diff = diffOutlines(outlineJsx(fileSource), outlineJsx(record.srcText));
  return { recordId: def.recordId, file: def.file, status: diff.identical ? "identical" : "differs", diff };
}

/** Build ONE page from the graph and report on it. Never throws: a page that cannot be analysed is a
 *  finding, not a crash — this is a diagnostic and must survive whatever it finds. */
export async function shadowPage(def: ShadowPageDef): Promise<PageShadow> {
  try {
    await def.ensurePlatform();
  } catch (e) {
    // The registry then reads short, so `unbound` would blame the page for a chunk that failed to load.
    // Say so instead.
    log.warn(`shadow: ${def.pageId} — platform load FAILED (${String(e).slice(0, 120)}); bindings unreliable`, "shadow");
  }

  const records = useAppStore.getState().components as GraphRecord[];
  const modules = await Promise.all(def.modules.map((m) => shadowModule(m, records)));
  const page = records.find((r) => r.id === def.pageId);

  let unbound: PageShadow["unbound"] = [];
  let compileError: string | undefined;
  if (page?.srcText) {
    unbound = analyzeBindings({ id: page.id, source: page.srcText }, siblingResolver(records), isAppModule).unbound;
    try {
      // The static walk above answers "what will this require, and is it registered". The compile answers
      // the other way a page fails: source the loader cannot build at all. Same call the loader makes, so
      // a pass here means the mount path's build step is proven, not assumed.
      await compileToCjs(page.srcText, resolveGraphSource);
    } catch (e) {
      compileError = String(e).slice(0, 300);
    }
  }

  return buildPageShadow({
    pageId: def.pageId,
    label: def.label,
    rendersFrom: def.rendersFrom,
    modules,
    unbound,
    hasGraphNode: Boolean(page?.srcText),
    compileError,
  });
}

/**
 * Sweep every page (or one, by id) and report. Returns the reports and logs them.
 *
 * Sequential on purpose: each page loads a feature's chunk and compiles its source, and running eight of
 * those at once would contend with whatever the app is doing on the same thread — the report is not
 * urgent, and a sweep that makes the app stutter would be its own kind of behaviour change.
 */
export async function runShadowMode(pageId?: string): Promise<PageShadow[]> {
  const defs = pageId ? SHADOW_PAGES.filter((p) => p.pageId === pageId) : SHADOW_PAGES;
  if (!defs.length) {
    log.warn(`shadow: no page "${pageId}" in the catalogue (${SHADOW_PAGES.map((p) => p.pageId).join(", ")})`, "shadow");
    return [];
  }
  log.info(`shadow: building ${defs.length} page(s) from the graph — files stay authoritative`, "shadow");
  const reports: PageShadow[] = [];
  for (const def of defs) {
    const report = await shadowPage(def);
    reports.push(report);
    log.info(`shadow: ${formatShadowLine(report)}`, "shadow");
    for (const u of report.unbound) {
      log.warn(`shadow:   unbound ${u.specifier} → ${u.symbols.join(", ") || "(side effect)"} [via ${u.importedBy.join(", ")}]`, "shadow");
    }
    for (const m of report.modules.filter((x) => x.status === "differs")) {
      const d = m.diff;
      log.info(
        `shadow:   ${m.recordId} differs in ${d?.differing} nodes` +
          `${d?.onlyInFile.length ? ` · file-only: ${d.onlyInFile.join(", ")}` : ""}` +
          `${d?.onlyInGraph.length ? ` · graph-only: ${d.onlyInGraph.join(", ")}` : ""}`,
        "shadow",
      );
    }
    for (const m of report.modules.filter((x) => x.status === "no-graph-node")) {
      log.warn(`shadow:   ${m.recordId} has NO graph record (file ${m.file})`, "shadow");
    }
  }
  log.info(`shadow: ${formatShadowSummary(reports)}`, "shadow");
  lastReport = reports;
  return reports;
}

/** Install the console handle. DEV-only (see `main.tsx`): the file half of every diff is a Vite `?raw`
 *  glob, which only a dev server can serve, so shadow mode is a maintainer instrument by construction. */
export function initShadowMode(): void {
  (window as unknown as { __bscShadow?: unknown }).__bscShadow = {
    run: runShadowMode,
    last: () => lastReport,
    pages: () => SHADOW_PAGES.map((p) => p.pageId),
  };
  log.info("shadow: ready — window.__bscShadow.run() builds every page from the graph and reports (renders nothing)", "shadow");
}
