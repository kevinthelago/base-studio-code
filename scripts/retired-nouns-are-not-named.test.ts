// NOTHING LIVE MAY NAME A `bsc` NOUN THAT NO LONGER DISPATCHES.
//
// `epic-the-command-surface-is-cleaned-and-regrouped` removes nouns outright, with no alias period — so a
// mention left behind does not merely read oddly, it tells the reader to run a command that will be refused.
// That is the #82 defect the epic exists to end, pointed at prose instead of at help text.
//
// EVERY RENAME SO FAR LEFT SOMETHING, and each time it was found by hand, late:
//   * `logs-absorbs-metrics-and-perf` shipped with `perf` still advertised in `bsc_util::SIDECARS` — a
//     command the agent prompt promised and the binary refused. Three slices passed before anyone looked.
//   * `studio-is-renamed-snapshot` swept the studio CLI's `code` and its packaged seed, and missed the 34
//     occurrences in the same record's `tests` field.
//   * the `graph` rename swept `src`, `src-tauri/data`, `scripts`, `docs` and `*.md` — and never looked in
//     `crates/`, where the ten crates that are NOT graph-materialized keep real `.rs` files on disk.
//
// The pattern is always the same: a sweep covers the places its author thought of. This reads the whole
// tree and the whole record store instead, so the next rename cannot quietly cover less than it claims.
//
// HISTORY IS EXEMPT; INSTRUCTIONS ARE NOT — the same line `docs-name-live-scripts.test.ts` draws, for the
// same reason. A CHANGELOG entry, a dated kickoff or a commit-shaped note that named the tool of its day is
// accurate, and rewriting it would falsify the record. Anything a reader could mistake for a current
// instruction is not exempt.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
// The repo's OWN store loader, not `node:sqlite` directly: this suite runs under jsdom, where a
// Node built-in cannot be bundled, and `storesAgree.test.ts` reads the store through this for the
// same reason. It also resolves the store through `graph/store.toml` rather than a hard-coded
// filename — opening a SQLite path that does not exist would silently create an empty one.
import { loadStore, resolveStorePath } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");

/**
 * The retired spellings, and what each became.
 *
 * ONE ROW PER SLICE OF THE EPIC. A rename adds its row here in the same change that removes the noun —
 * that is the whole mechanism, and it is why this list is written out rather than derived: deriving it
 * from the catalog would only know what EXISTS, never what USED to.
 */
const RETIRED: ReadonlyArray<readonly [string, string]> = [
  ["bsc perf", "bsc logs frontend"], // logs-absorbs-metrics-and-perf
  ["bsc metrics", "bsc logs metrics"],
  ["bsc worktree", "bsc disk worktree"], // dev-tooling-nouns-fold
  ["bsc imagine", "bsc ear imagine"], // ear-absorbs-imagine
  ["bsc capability", "bsc network capabilities"], // capability-becomes-a-network-verb
  ["bsc studio", "bsc snapshot"], // studio-is-renamed-snapshot
  ["bsc graph", "bsc algorithms"], // graph-and-ui-are-renamed-algorithms-and-components
  ["bsc ui", "bsc components"], // ui-is-renamed-components
  ["bsc cost", "bsc resources"], // capacity-and-cost-fold-into-resources
  ["bsc capacity", "bsc resources"],
  ["bsc llm", "bsc resources"], // llm-folds-into-resources
  ["bsc inventory", "bsc lan"], // inventory-folds-into-lan
];

/**
 * Verbs that moved to another NOUN, old two-word spelling to new.
 *
 * A VERB IS INVISIBLE TO THE TABLE ABOVE. `RETIRED` is keyed on `bsc <noun>`, so `bsc logs perf` is
 * "bsc logs" plus a word it never looks at — and `bsc logs` is very much alive. The first slice to
 * move verbs rather than a whole noun (`the-logs-resources-seam-is-in-the-wrong-place`, six of them)
 * would have left every caller reading correctly to this file and wrongly to the binary.
 *
 * Same rule as the nouns: the old spelling is refused, never aliased, so a mention left behind tells
 * a reader to run something that will be rejected.
 */
const MOVED_VERBS: ReadonlyArray<readonly [string, string]> = [
  ["bsc logs perf growth", "bsc resources growth"], // …the duplicate that slice removed: read it first
  ["bsc logs perf", "bsc resources samples"],
  ["bsc logs pss", "bsc resources load"],
  ["bsc logs cost", "bsc resources spend"],
  ["bsc logs metrics", "bsc resources scoreboard"],
  ["bsc logs frontend", "bsc resources frontend"],
  ["bsc logs store", "bsc resources store"],
];

/**
 * Dated records and GENERATED mirrors.
 *
 * The first three are history by the rule in the header. The last two are generated FROM the record store
 * (`npm run emit:records`, `UPDATE_KITS=1`), so they are not a second place to fix — they follow whatever
 * the store says, and checking them would report one fault twice.
 */
const EXEMPT = [
  "docs/sessions",
  "CHANGELOG.md",
  "ROADMAP.md",
  "RESUME.md",
  "src-tauri/data/knowledge/algorithms.json",
  "src-tauri/data/components/react-ui.json",
  // BUILD STAGING, not a second store (`src-tauri-resources-is-build-staging-not-a-second-store`):
  // `src-tauri/resources/` is a COPY the build makes of `src-tauri/data/`. Fixing it here would be
  // fixing the shadow — it is overwritten on the next build from the originals this test does check.
  "src-tauri/resources",
  ".bsc-records",
  // A DATED EVALUATION CORPUS, not documentation. `crates/bsc-similar/fixtures/catalog-*-2026-09-15.json`
  // is the catalog as it stood on the day in its own filename, and the relevance thresholds in
  // `bsc-similar--tests.rs` are tuned against exactly those documents — one of which is a row whose whole
  // purpose is to carry a DEPRECATED spelling and its pointer. Rewriting it would move the corpus out
  // from under the assertions and delete the only deprecated-noun case the ranker is tested on.
  "crates/bsc-similar/fixtures",
  "scripts/retired-nouns-are-not-named.test.ts", // this file names them on purpose
];

const SKIP_DIR = new Set(["node_modules", "target", "dist", "coverage"]);
const READ_EXT = [".rs", ".ts", ".tsx", ".mjs", ".js", ".md", ".json", ".sh"];

function isExempt(rel: string): boolean {
  return EXEMPT.some((e) => rel === e || rel.startsWith(`${e}/`));
}

/** Every readable source/prose file, repo-relative, outside the exemptions. */
function liveFiles(dir = REPO, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name) || e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (isExempt(r)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...liveFiles(full, r));
    else if (READ_EXT.some((x) => e.name.endsWith(x)) && statSync(full).size < 8_000_000) out.push(r);
  }
  return out;
}

describe("a retired bsc noun is named nowhere live", () => {
  it("not in any tracked source or prose file", () => {
    const offenders: string[] = [];
    for (const rel of liveFiles()) {
      const text = readFileSync(join(REPO, rel), "utf8");
      for (const [old, now] of [...RETIRED, ...MOVED_VERBS]) {
        // Word-boundaried on the RIGHT so `bsc graph` does not match `bsc graphql`, and the left side is
        // already anchored by the literal `bsc `.
        const hits = text.split(new RegExp(`${old}\\b`)).length - 1;
        if (hits) offenders.push(`${rel}: ${hits}× \`${old}\` — it is \`${now}\` now`);
      }
    }
    expect(offenders, `a retired noun is named where a reader will read it as an instruction:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  /**
   * A retired noun as the FIRST element of an ARRAY LITERAL near a `bsc` call.
   *
   * THIS IS THE CASE THAT BROKE THE APP, twice in one day. `componentBridge.ts` calls
   * `bsc(null, ["ui", "list", "--full"])` and the LAN workspace called `bsc(null, ["inventory",
   * "scene"])`. Neither contains the string `bsc ui` or `bsc inventory`, so the two scans above —
   * and the sweeps that did the renames — walked straight past 118 call sites. The desktop's
   * Components workspace went blank, the phone stopped loading component sources, and the LAN screen
   * lost its scene, all while every gate was green.
   *
   * The earlier version of this check only matched `{ cmd: "bsc", args: [...] }`, the one shape a
   * `scripts/` leg happened to use. It found that one and none of these.
   *
   * WHY THE PROXIMITY TEST. Matching a bare `["ui", …]` flags 173 places, because these words belong
   * to other vocabularies too: `ui` is a blueprint stage key and a URN pillar, `graph` is a common
   * word, `worktree` is a `git` subcommand, and `usage` is a LIVE noun. Requiring a `bsc` mention in
   * the preceding 200 characters separates an argv from a list of stage names: MEASURED on the commit
   * that fixed this, 43 file sites and 74 record sites flagged before, 1 and 5 after — and every
   * survivor is named in EXEMPT_ARGV below with the reason it is not an argv.
   */
  const RETIRED_NOUNS = ["perf", "metrics", "worktree", "imagine", "capability", "studio", "graph", "ui", "cost", "capacity", "llm", "inventory"];
  /** Not argv, each checked by hand — the noun is some other vocabulary's word in these. */
  const EXEMPT_ARGV = new Map<string, string>([
    ["bsc-component--cli.rs", "`store.set(\"cost\", …)` — a JSON-store KEY, next to `bsc_json_store`"],
    ["bsc-component--crossgraph--mod.rs", "`@bsc/ui/Sparkline` — the URN PILLAR, which did not move"],
    ["classify-config.ts", "`SYSTEM_SOURCES = [\"studio\", …]` — a config-source name, not a verb"],
    ["logs--cli.rs", "the list of verbs that LEFT, asserted absent from the overview"],
    ["bsc--tests.rs", "the RENAMED/FOLDED tables — they name old spellings on purpose"],
  ]);
  // The LEAD is sliced by index rather than captured in the pattern: a `[\s\S]{0,200}` prefix with the
  // `g` flag backtracks across every record in the store and the whole suite times out at 5s.
  const ARGV_RE = new RegExp(String.raw`[\[(]\s*("|')(${RETIRED_NOUNS.join("|")})\1\s*,`, "g");
  const NEAR_BSC = /\bbsc\b|sidecar_read|is_servable|try_warm|BSC/i;

  function argvOffenders(label: string, text: string): string[] {
    if (EXEMPT_ARGV.has(label)) return [];
    const out: string[] = [];
    for (const m of text.matchAll(ARGV_RE)) {
      const lead = text.slice(Math.max(0, m.index - 200), m.index);
      if (!NEAR_BSC.test(lead)) continue;
      out.push(`${label}: spawns \`bsc ${m[2]} …\` as an argv array — that noun is retired`);
    }
    return out;
  }

  it("not as the first element of an argv array near a `bsc` call", () => {
    const offenders: string[] = [];
    for (const rel of liveFiles()) {
      if (!/\.(mjs|js|ts|tsx|rs)$/.test(rel)) continue;
      offenders.push(...argvOffenders(rel, readFileSync(join(REPO, rel), "utf8")));
    }
    const store = loadStore(resolveStorePath(REPO)) as { implementations?: Array<Record<string, unknown>> };
    for (const rec of store.implementations ?? []) {
      const id = String(rec.id ?? "<unnamed>");
      const tests = ((rec.tests ?? []) as Array<{ src?: string }>).map((t) => t.src ?? "").join("\n");
      offenders.push(...argvOffenders(id, `${rec.code ?? ""}\n${tests}`));
    }
    expect(offenders, `a retired noun is spawned as an argv array, where no text sweep will find it:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("not in any record's code or carried tests", () => {
    // THE RECORD STORE IS MOST OF THE SOURCE, and it is the half every sweep so far has half-missed: a
    // record keeps its prose in `code` AND a second copy in `tests`, and a sweep of one is not a sweep.
    const store = loadStore(resolveStorePath(REPO)) as { implementations?: Array<Record<string, unknown>> };
    const records = store.implementations ?? [];
    expect(records.length, "the record scan found nothing — the scan is broken, not the store").toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const rec of records) {
      const id = String(rec.id ?? "<unnamed>");
      for (const field of ["code", "tests"]) {
        // A carried test is checked by its SOURCE, not its title. `tests` is an array of
        // `{name, src}` and a `name` cannot be changed: the store UPSERTS by name and has no remove
        // verb, so renaming an entry adds a second one and emits a duplicate test file (measured on
        // `theme-bridge.ts`). Filed as `a-carried-test-entry-cannot-be-renamed-or-removed`; until it
        // exists, a stale noun in a test's TITLE is a label nobody executes, while one in its source
        // is an instruction a reader will follow.
        const text = JSON.stringify(
          field === "tests"
            ? ((rec.tests ?? []) as Array<{ src?: string }>).map((t) => t.src ?? "")
            : (rec[field] ?? ""),
        );
        for (const [old, now] of [...RETIRED, ...MOVED_VERBS]) {
          const hits = text.split(new RegExp(`${old}\\b`)).length - 1;
          if (hits) offenders.push(`${id}.${field}: ${hits}× \`${old}\` — it is \`${now}\` now`);
        }
      }
    }
    expect(offenders, `a record names a retired noun:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
