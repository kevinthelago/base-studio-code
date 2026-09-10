// EVERY READER OF THE COMMITTED GRAPH STORE GOES THROUGH THE MERGED LOADER — the invariant, asserted
// over the source rather than trusted.
//
// The store is a DATABASE now (`epic-retire-json-ledgers-for-db-and-git-drivers`), named by
// `graph/store.toml` and reached only through a loader. It went there via one-file-per-record, and both
// moves had the same driver: a 27 MB single JSON file means every branch touching ANY record conflicts
// with every other, which is what makes a decomposition wave cost a night of hand-merging. The ledger
// answers that with per-record revisions and a real merge driver instead of 2,946 files.
//
// # Why this needs a gate and not a convention
//
// A reader that parses the store file alone does not FAIL. It gets an `implementations` array missing
// every split-out record and walks it happily — and the readers in question are source GUARDS
// (`src-tauri`'s `source_units`, `bsc-cli-util`'s tree-wide surface scan, the method-leaf drift gate,
// the relationship recognizer). A guard walking a shrunken population passes over whatever is left and
// reports green. That is this repo's signature failure, and it is why the file could not be split until
// every reader had moved.
//
// WRITING THIS SCANNER IS WHAT FOUND THE LAST TWO. `scripts/graph-relationships.test.ts` and
// `graph-materialize`'s own `the_committed_store_still_names_the_test_target_…` were both still parsing
// the file directly after a by-hand sweep of the tree had declared the migration finished.
//
// # It scans RECORDS as well as files
//
// Most of this codebase is not files (#3604): `bsc-graph`, `bsc-cli-util` and `bsc-perms` all compile
// from the graph, so a scanner reaching the tree with `readdir` alone would miss the readers that
// matter most. The population floor below is what says so out loud if that ever stops being true.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStore, resolveStorePath, isSqliteStore } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");

/** Anything that reads bytes off disk. Deliberately broad — the precision comes from the scope below. */
const READ = /read_to_string\s*\(|readFileSync\s*\(|readFile\s*\(/;

/**
 * The unit with `//` line comments blanked out, so PROSE about a direct read is not a direct read.
 *
 * That distinction is load-bearing here rather than fussy: every reader migrated in this epic carries a
 * comment saying what it stopped doing and why, and a scanner that could not tell the two apart would
 * fire on exactly the code that had been fixed. Both languages in scope use `//`. A `//` inside a
 * string literal is left alone by counting the quotes before it — the alternative is a parser, and the
 * only thing this needs to be right about is which half of a line is code.
 */
export function withoutLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (let i = 0; i + 1 < line.length; i += 1) {
        if (line[i] === "/" && line[i + 1] === "/") {
          const before = line.slice(0, i);
          const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length;
          if (quotes % 2 === 0) return before;
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Every string a record document carries, as its own unit.
 *
 * A WALK rather than a field list, because the field that got past this guard was not `code`: three
 * store readers were carried as `tests[].src` — one on an algorithm record, one on an EDGE in the
 * packaged seed, one on a component record — and the split found them by breaking them, not by being
 * scanned. A list of fields to look at is a list that will be missing the next one.
 */
function recordStrings(doc: unknown, name: string, out: { name: string; text: string }[]): void {
  if (typeof doc === "string") {
    if (doc.includes("\n")) out.push({ name, text: doc });
  } else if (Array.isArray(doc)) {
    doc.forEach((v, i) => recordStrings(v, `${name}[${i}]`, out));
  } else if (doc && typeof doc === "object") {
    const id = (doc as { id?: string }).id;
    for (const [k, v] of Object.entries(doc)) {
      recordStrings(v, id ? `${name}:${id}.${k}` : `${name}.${k}`, out);
    }
  }
}

/**
 * The units to scan: every source FILE under the code roots, plus every string in every RECORD —
 * the committed store, the PACKAGED SEED (impls and edges alike), and the component seeds.
 *
 * `data/` is skipped by the file walk because the stores under it are stores, not readers; their
 * CONTENT is scanned as records instead. `target/`/`node_modules` are build output, and `.bsc-records`
 * is the emitted form of records already scanned at their source, where it cannot go stale.
 */
function sourceUnits(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const skip = new Set(["node_modules", "target", ".bsc-records", "data", ".git"]);
  const walk = (dir: string, exts: string[]) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, exts);
      else if (exts.some((x) => e.endsWith(x))) out.push({ name: p.slice(REPO.length + 1), text: readFileSync(p, "utf8") });
    }
  };
  walk(join(REPO, "scripts"), [".mjs", ".js", ".ts"]);
  walk(join(REPO, "src"), [".ts", ".tsx"]);
  walk(join(REPO, "crates"), [".rs"]);
  walk(join(REPO, "src-tauri"), [".rs"]);
  recordStrings(loadStore(resolveStorePath(REPO)), "record", out);
  recordStrings(
    JSON.parse(readFileSync(join(REPO, "src-tauri/data/knowledge/algorithms.json"), "utf8")),
    "seed",
    out,
  );
  const components = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) components(p);
      else if (e.endsWith(".json")) recordStrings(JSON.parse(readFileSync(p, "utf8")), "component", out);
    }
  };
  components(join(REPO, "src-tauri/data/components"));
  return out;
}

/**
 * Every place a unit reads the committed store off disk itself.
 *
 * Scoped to the enclosing STATEMENT — the text back to the nearest `;`, `{` or `}` — so a mention in a
 * comment, a path binding on its own line, or a `loadStore(resolve(REPO, "graph/algorithms.json"))`
 * does not read as a direct parse.
 *
 * # It matches the path's ALIASES, not only the literal
 *
 * A literal-only rule has a hole big enough to drive the whole failure through, and it did: the
 * materializer's own `src_tauri_resolves_and_now_renders_every_record_it_owns` read
 * `std::fs::read_to_string(&plan.store_path)` — no literal in sight — and the day `src-tauri`'s 138
 * records split out it asserted "src-tauri owns only 0 records". So the names the repo uses FOR that
 * path count as the path: `store_path`, `path_under(`, `REPO_STORE_REL`.
 *
 * A literal match must also name `graph` and must NOT name `knowledge`: the PACKAGED SEED at
 * `src-tauri/data/knowledge/algorithms.json` is a different file, one file by design, that ships
 * inside the binaries and is nobody's business here.
 */
export function directReads(units: { name: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { name, text: raw } of units) {
    const text = withoutLineComments(raw);
    const at: number[] = [];
    for (const m of text.matchAll(/algorithms\.json|store_path|path_under\s*\(|REPO_STORE_REL/g)) {
      const head = text.slice(Math.max(0, m.index - 400), m.index);
      const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
      const stmt = cut >= 0 ? head.slice(cut + 1) : head;
      if (!READ.test(stmt)) continue;
      // A LITERAL path has to say which store; an ALIAS already names the repo one by construction.
      if (m[0] === "algorithms.json" && (!stmt.includes("graph") || stmt.includes("knowledge"))) continue;
      const line = text.slice(0, m.index).split("\n").length;
      if (!at.includes(line)) at.push(line);
    }
    for (const line of at) found.push(`${name}:${line}`);
  }
  return found;
}

/**
 * The two loaders themselves, which must read the file — they ARE the merge.
 *
 * Kept to a named pair rather than a pattern: an allow-list that grew by pattern is how a boundary gate
 * quietly stops covering anything.
 */
const LOADERS = [
  "scripts/lib/recordStore.mjs",
  "crates/graph-materialize/emit.rs",
  // The `bsc graph store` verb's own help prose and the `repo_store` module that IS the merge.
  "record:bsc-graph--cli.rs",
  "record:bsc-graph--repo-store--mod.rs",
  // THIS FILE. The scanner has to hold both shapes it recognises as literal fixtures, or the bite test
  // below could only ever be written somewhere the scanner does not look — which is to say, nowhere.
  "scripts/graph-store-readers.test.ts",
];

describe("the committed graph store has exactly one reader: the merged loader", () => {
  const units = sourceUnits();

  it("scans both homes — files AND records", () => {
    // NON-VACUITY. A scanner that silently stopped matching (a moved root, a records store it could not
    // read) would report an empty offender list, which is indistinguishable from a pass. The floors are
    // deliberately far below today's population — this detects a COLLAPSE, not a single unit going
    // missing.
    const kind = (p: string) => units.filter((u) => u.name.startsWith(p)).length;
    expect(kind("scripts") + kind("src") + kind("crates"), "source files").toBeGreaterThan(250);
    expect(kind("record"), "committed-store record strings").toBeGreaterThan(1000);
    expect(kind("seed"), "packaged-seed record strings").toBeGreaterThan(500);
    expect(kind("component"), "component record strings").toBeGreaterThan(200);
  });

  it("finds no reader that parses graph/algorithms.json itself", () => {
    const offenders = directReads(units).filter((o) => !LOADERS.some((l) => o.startsWith(l)));
    expect(
      offenders,
      "these parse the committed store file directly. The store is the ledger DATABASE, named by " +
        "`graph/store.toml`, so a spelled path is stale the moment it moves and a direct parse cannot " +
        "read it at all. Read it through `graph_materialize::load_merged_value` / `repo_store::read_at` " +
        "(Rust) or `scripts/lib/recordStore.mjs`'s `loadStore` (JS/TS).",
    ).toEqual([]);
  });

  it("the store is not JSON, which is what makes an unmigrated reader LOUD rather than short", () => {
    // THE STRUCTURAL HALF of this invariant, and the more reliable half.
    //
    // The scanner above catches the shapes it knows. What catches the rest is that a reader which does
    // not go through the loader cannot get a PLAUSIBLE answer out of the store: `JSON.parse` on a
    // SQLite file throws on the first byte. That is a strict improvement on what this asserted before
    // the ledger — with one file per record, parsing the store file alone yielded an empty
    // `implementations` array, which was loud only because every reader here carries a population
    // floor. A throw needs no floor to be noticed.
    //
    // The state this rules out is the MIXED one: a store still spelled `.json` while records live
    // elsewhere is the only shape where an unmigrated reader sees a subset instead of an error.
    const at = resolveStorePath(REPO);
    expect(isSqliteStore(at), `the committed store at ${at} must be the ledger database`).toBe(true);
    expect(() => JSON.parse(readFileSync(at, "utf8")), "a direct JSON read of the store must THROW")
      .toThrow();
    const merged = loadStore(at) as { implementations: unknown[] };
    expect(merged.implementations.length, "the merged store").toBeGreaterThan(1000);
  });

  it("still recognises a direct read when it sees one", () => {
    // Guard the guard: the assertion above passes for a scanner that matches nothing at all, which is
    // the one failure a boundary test cannot afford. These are the two shapes actually found in the
    // tree when this was written.
    expect(
      directReads([
        { name: "x.rs", text: 'let raw = std::fs::read_to_string(root.join("graph").join("algorithms.json"));' },
        { name: "y.ts", text: "const recs = JSON.parse(readFileSync('graph/algorithms.json','utf8'));" },
        // THE ONE THAT GOT THROUGH: the path reaches the read through a variable, so there is no
        // literal to match. This shape read as green while returning zero records.
        { name: "z.rs", text: 'let raw = std::fs::read_to_string(&plan.store_path).expect("reads");' },
        { name: "w.rs", text: 'let raw = std::fs::read_to_string(path_under(&root)).unwrap();' },
      ]),
    ).toEqual(["x.rs:1", "y.ts:1", "z.rs:1", "w.rs:1"]);
    // …and does NOT fire on the seed, on a comment, or on a call that goes through the loader.
    expect(
      directReads([
        { name: "a.rs", text: 'std::fs::read_to_string(repo.join("src-tauri/data/knowledge/algorithms.json"));' },
        { name: "b.ts", text: '// readFileSync("graph/algorithms.json") is what this replaced\nconst s = loadStore(P);' },
        { name: "c.ts", text: 'const store = loadStore(resolve(REPO, "graph/algorithms.json"));' },
        { name: "d.rs", text: '// std::fs::read_to_string(root.join("graph/algorithms.json")) — no longer\nlet s = read_at(&p);' },
      ]),
    ).toEqual([]);
  });
});
