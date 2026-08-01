// The shadow report (#4169, step 1 of the graph-renders-the-app reframe) — assemble, per page, the answer
// to "could this page render from the graph, and is the graph copy still the same page?"
//
// Shadow mode renders NOTHING. The app keeps rendering whatever it renders today; this builds each page
// from the graph ALONGSIDE that — resolving its siblings, walking its bindings, diffing its skeleton
// against the file copy — and reports. That is the point of doing it first: the coverage data does not
// exist today, so "is this page ready?" is a judgement call, and the registry work that follows (step 3)
// would be guesswork. This turns both into a list.
//
// Two independent signals per page, and they answer different questions:
//   • STRUCTURAL (`status` / `differingNodes`) — has the graph copy drifted from the file it was
//     transcribed from? A page that renders from the graph today and differs has already lost whatever
//     the file gained; a page that still renders from files and differs is not safe to flip.
//   • BINDING (`unbound`) — every behaviour the page needs that the app has not registered. Each one
//     throws in `makeRequire` the moment the page loads, so a page with any unbound import must NOT be
//     flipped: it renders its fallback, not "most of the page". This is the step-3 worklist.
//
// `readyForGraph` is the conjunction, and is exactly the predicate step 2's resolution chain will ask.
import type { OutlineDiff } from "./outlineDiff";
import type { ExternalImport } from "./pageBinding";

/** The structural verdict for one module of a page. */
export type ModuleStatus =
  | "identical" //        the graph node renders the same element tree as its file
  | "differs" //          the trees diverge — the graph copy has drifted (or the file has moved on)
  | "no-graph-node" //    the file exists; nothing in the graph carries it
  | "no-file-baseline"; // the graph node is the ONLY copy — the file was deleted (fleet, #3636)

/** One module of a page: its page record, its file, and how the two compare. */
export interface ModuleShadow {
  recordId: string;
  /** The file this record was transcribed from, or `null` once that file is gone. */
  file: string | null;
  status: ModuleStatus;
  /** The structural diff — `null` when one side is missing and there is nothing to compare. */
  diff: OutlineDiff | null;
}

/** The page-level verdict — the worst of its modules'. */
export type PageStatus = "graph-identical" | "differs" | "no-graph-node" | "no-file-baseline";

/** What the app renders for this page TODAY. Shadow mode does not change it; it is reported so the
 *  numbers read against reality (a `differs` page already rendering from the graph is a live problem;
 *  the same verdict on a file-rendered page is a not-yet). */
export type RenderSource = "graph" | "file";

/** The shadow verdict for one page. */
export interface PageShadow {
  /** The graph page node's id (`automationspage`). */
  pageId: string;
  label: string;
  rendersFrom: RenderSource;
  status: PageStatus;
  /** Element paths present in one copy and not the other, summed over the page's modules. */
  differingNodes: number;
  /** Elements in the file copy of the page's modules — the denominator for `differingNodes`. */
  fileNodes: number;
  /** Behaviours the page requires that the app has not registered. Non-empty ⇒ loading it throws. */
  unbound: ExternalImport[];
  modules: ModuleShadow[];
  /** True when the page's source resolves and every behaviour it needs is bound — the predicate step 2's
   *  resolution chain asks before it may render this page from the graph. Structural drift does NOT clear
   *  it: a drifted page still renders, it just renders the older skeleton. */
  readyForGraph: boolean;
  /** A compile failure, when the runner verified the source through esbuild (browser-only, so absent from
   *  a node run). A page that will not compile can never mount, whatever its bindings say. */
  compileError?: string;
}

/** Assemble one page's verdict from its per-module diffs and its binding walk. Pure — the runner does the
 *  I/O (store reads, raw file loads, the optional compile) and hands the results here. */
export function buildPageShadow(input: {
  pageId: string;
  label: string;
  rendersFrom: RenderSource;
  modules: ModuleShadow[];
  unbound: ExternalImport[];
  hasGraphNode: boolean;
  compileError?: string;
}): PageShadow {
  const { modules, unbound, hasGraphNode, compileError } = input;
  const differingNodes = modules.reduce((n, m) => n + (m.diff?.differing ?? 0), 0);
  const fileNodes = modules.reduce((n, m) => n + (m.diff?.fileNodes ?? 0), 0);
  const status: PageStatus = !hasGraphNode
    ? "no-graph-node"
    : modules.some((m) => m.status === "no-graph-node") || differingNodes > 0
      ? "differs"
      : modules.every((m) => m.status === "no-file-baseline")
        ? "no-file-baseline"
        : "graph-identical";
  return {
    pageId: input.pageId,
    label: input.label,
    rendersFrom: input.rendersFrom,
    status,
    differingNodes,
    fileNodes,
    unbound,
    modules,
    readyForGraph: hasGraphNode && unbound.length === 0 && !compileError,
    ...(compileError ? { compileError } : {}),
  };
}

/** One line per page, for the log — the format the report is READ in. Terse on purpose: this lands in
 *  `base-studio-code.log` next to the `graph-loader` lines that report what actually mounted. */
export function formatShadowLine(page: PageShadow): string {
  const verdict =
    page.status === "graph-identical"
      ? "graph-identical"
      : page.status === "differs"
        ? `differs in ${page.differingNodes} of ${page.fileNodes} nodes`
        : page.status === "no-file-baseline"
          ? "graph-only (no file baseline)"
          : "NO graph node";
  const bindings = page.unbound.length
    ? `unbound: ${page.unbound.map((u) => u.specifier).join(", ")}`
    : "all behaviors bound";
  const compile = page.compileError ? ` · COMPILE FAILED: ${page.compileError.slice(0, 120)}` : "";
  return `${page.pageId} [renders from ${page.rendersFrom}] — ${verdict} · ${bindings}${compile}`;
}

/** The one-line roll-up: how much of the app the graph could render today. */
export function formatShadowSummary(pages: PageShadow[]): string {
  const identical = pages.filter((p) => p.status === "graph-identical" || p.status === "no-file-baseline").length;
  const ready = pages.filter((p) => p.readyForGraph).length;
  const unbound = new Set(pages.flatMap((p) => p.unbound.map((u) => u.specifier))).size;
  return `${pages.length} pages · ${identical} structurally identical · ${ready} fully bound · ${unbound} distinct unbound specifiers`;
}
