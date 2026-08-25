// THE PLANNER IS DOMAIN ONLY, AND NOTHING IN IT IS UNREACHABLE
// (`clean-the-components-tree-after-the-cut`).
//
// THE BUG THIS EXISTS FOR. Deleting the planner's SCREEN left 14 modules behind that nothing imports:
// the focused pane's handlers, the GitHub board's GraphQL documents, the projects-summary query, the
// plan linter, the planner-sync barrel and its snapshot half, the Claude-Design brief, the terminal
// scraper, and a React view for a pane that no longer renders. Every gate stayed green, because an
// unimported module is not a broken one — `tsc` type-checks it, `eslint` lints it, `vitest` never
// mentions it, and `vite build` tree-shakes it out without a word. The only thing that notices is a
// reader who finds it and assumes it is live.
//
// WHY A TEST AND NOT A ONE-TIME SWEEP. The cut is not the only thing that orphans a module — every
// later deletion of a consumer does too, and each one is invisible for the same reason. The sweep has
// to run on every gate or it answers for one afternoon.
//
// WHAT REACHABILITY MEANS HERE. A root is anything outside `features/planner/` (a file or a record) plus
// any test anywhere — a module reached only by its own test is COVERED, not dead, and this must not
// argue for deleting a tested module. Edges come from both stores as well as from disk, because most of
// the planner ships as records (docs/records.md): a file-only scan would call a live record orphaned.
// Relative specifiers are resolved, not skipped — `planStageDerive` is imported as `./planStageDerive`
// and an `@/`-only scan reported it dead when it is not.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const APP_RECORDS = join(ROOT, "src-tauri/data/components/app");
const IMPLS = join(ROOT, "src-tauri/data/knowledge/algorithms.json");

/** `src/a/b.tsx` → `@/a/b`; anything else → undefined. */
function specOf(src: string): string | undefined {
  return src.startsWith("src/") ? `@/${src.slice(4).replace(/\.(tsx?|jsx?)$/, "")}` : undefined;
}

/** Resolve one import specifier against the module that wrote it. Bare package imports → undefined. */
function resolve(raw: string, owner: string): string | undefined {
  if (raw.startsWith("@/")) return raw.replace(/\.(tsx?|jsx?)$/, "");
  if (!raw.startsWith(".")) return undefined;
  const base = posix.dirname(owner.slice(2));
  return `@/${posix.normalize(posix.join(base, raw)).replace(/\.(tsx?|jsx?)$/, "")}`;
}

const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const graph = new Map<string, Set<string>>();
const onDisk = new Set<string>();

function note(spec: string, text: string) {
  const out = graph.get(spec) ?? new Set<string>();
  for (const m of text.matchAll(IMPORT)) {
    const r = resolve(m[1], spec);
    if (r) out.add(r);
  }
  graph.set(spec, out);
}

function walk(dir: string, visit: (path: string) => void) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    else visit(p);
  }
}

// ── files on disk ─────────────────────────────────────────────────────────────
walk(SRC, (p) => {
  if (!/\.tsx?$/.test(p)) return;
  const spec = specOf(p.slice(ROOT.length + 1).split("\\").join("/"));
  if (!spec) return;
  onDisk.add(spec);
  note(spec, readFileSync(p, "utf8"));
});

// ── component records (the app kit) ───────────────────────────────────────────
if (existsSync(APP_RECORDS)) {
  walk(APP_RECORDS, (p) => {
    if (!p.endsWith(".json")) return;
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      const rec = r as { src?: string; srcText?: string; code?: string; tests?: { src?: string }[] };
      const spec = specOf(rec?.src ?? "");
      if (spec) {
        note(spec, `${rec.srcText ?? ""}\n${rec.code ?? ""}`);
        noteCarriedTests(spec, rec.tests);
      }
    }
  });
}

// ── implementation records ────────────────────────────────────────────────────
const impls = JSON.parse(readFileSync(IMPLS, "utf8")) as {
  implementations: { provides?: string; code?: string; tests?: { src?: string }[] }[];
};
for (const n of impls.implementations) {
  if (!n.provides) continue;
  note(n.provides, n.code ?? "");
  noteCarriedTests(n.provides, n.tests);
}

/**
 * A record's CARRIED TESTS are importers too (#algorithm-tests-live-on-their-records).
 *
 * A retired module's test lives on its record now, not beside it in `src/`, so a graph built only from
 * module SOURCE cannot see it — and a module whose only importer was its own test reads as an orphan.
 * That is not a hypothetical: migrating the algorithm tests onto their impls made 11 planner modules
 * look dead in one step, all of them reachable the whole time.
 *
 * Registered under a synthetic `<spec>.test` key so `isTest` treats it as a root exactly as a colocated
 * file was, which keeps "reachable from a test" meaning the same thing in both worlds.
 */
function noteCarriedTests(spec: string, tests: { src?: string }[] | undefined) {
  for (const t of tests ?? []) if (t?.src) note(`${spec}.test`, t.src);
}

const isPlanner = (s: string) => s === "@/features/planner" || s.includes("/features/planner/");
const isTest = (s: string) => /\.(test|spec)$/.test(s);

describe("the planner leaves nothing unreachable behind", () => {
  it("finds a graph to sweep at all", () => {
    // Non-vacuity: a scan that resolved nothing would report a clean sweep for the wrong reason.
    expect(graph.size).toBeGreaterThan(500);
    expect([...graph.keys()].filter(isPlanner).length).toBeGreaterThan(100);
  });

  it("every planner module is reachable from outside the planner, or from a test", () => {
    const seen = new Set<string>();
    const stack = [...graph.keys()].filter((s) => !isPlanner(s) || isTest(s));
    while (stack.length) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of graph.get(cur) ?? []) if (!seen.has(e)) stack.push(e);
    }
    const orphans = [...graph.keys()].filter((s) => isPlanner(s) && !seen.has(s)).sort();
    expect(
      orphans,
      `planner modules nothing imports — not a file, not a record, not a test. Each is dead weight a ` +
        `reader will mistake for live code, and no other gate can see it:\n  ${orphans
          .map((s) => `${onDisk.has(s) ? "file  " : "record"} ${s}`)
          .join("\n  ")}`,
    ).toEqual([]);
  });

  it("no module under features/planner imports React — the planner is DOMAIN ONLY", () => {
    // The screen is gone and the barrel is React-free so eleven outside importers (and the store's type
    // graph) stay clear of it. A .tsx that creeps back in is how that quietly reverses.
    const offenders: string[] = [];
    walk(join(SRC, "features/planner"), (p) => {
      if (!/\.tsx?$/.test(p) || /\.(test|spec)\.tsx?$/.test(p)) return;
      const text = readFileSync(p, "utf8");
      if (/from\s+["']react["']|from\s+["']react\/|from\s+["']react-dom/.test(text))
        offenders.push(p.slice(ROOT.length + 1).split("\\").join("/"));
    });
    expect(
      offenders,
      `features/planner/ is the plan MODEL — the architect and director drive it through \`bsc plan\`, ` +
        `and it has no screen. A React import here pulls the framework back into the store's type ` +
        `graph:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
