// EVERY READER OF THE COMMITTED GRAPH STORE GOES THROUGH THE MERGED LOADER — the invariant, asserted
// over the source rather than trusted.
//
// The store is being taken apart into one file per record: `graph/algorithms.json` for the document's
// own keys, `graph/records/<id>.json` for each implementation
// (`epic-retire-json-ledgers-for-db-and-git-drivers`, mirroring `src-tauri/data/components/**` where a
// record has always been one file). A 27 MB single file means every branch touching ANY record
// conflicts with every other, which is what makes a decomposition wave cost a night of hand-merging.
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
import { loadStore } from "./lib/recordStore.mjs";

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
 * The units to scan: every source FILE under the code roots, plus every RECORD's code.
 *
 * `data/` is excluded because `src-tauri/data/knowledge/algorithms.json` IS a store, not a reader of
 * one, and `target/`/`node_modules`/`.bsc-records` are build output.
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
  for (const rec of loadStore(join(REPO, "graph/algorithms.json")).implementations as { id: string; code?: string }[]) {
    if (rec.code) out.push({ name: `record:${rec.id}`, text: rec.code });
  }
  return out;
}

/**
 * Every place a unit reads `…graph/algorithms.json` off disk itself.
 *
 * Scoped to the enclosing STATEMENT — the text back to the nearest `;`, `{` or `}` — so a mention in a
 * comment, a path binding on its own line, or a `loadStore(resolve(REPO, "graph/algorithms.json"))`
 * does not read as a direct parse. The statement must also name `graph` and must NOT name `knowledge`:
 * the PACKAGED SEED at `src-tauri/data/knowledge/algorithms.json` is a different file that is one file
 * by design, ships inside the binaries, and is nobody's business here.
 */
export function directReads(units: { name: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { name, text: raw } of units) {
    const text = withoutLineComments(raw);
    for (const m of text.matchAll(/algorithms\.json/g)) {
      const head = text.slice(Math.max(0, m.index - 400), m.index);
      const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
      const stmt = cut >= 0 ? head.slice(cut + 1) : head;
      if (!stmt.includes("graph") || stmt.includes("knowledge") || !READ.test(stmt)) continue;
      found.push(`${name}:${text.slice(0, m.index).split("\n").length}`);
    }
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
    expect(units.filter((u) => !u.name.startsWith("record:")).length, "source files").toBeGreaterThan(250);
    expect(units.filter((u) => u.name.startsWith("record:")).length, "records").toBeGreaterThan(1000);
  });

  it("finds no reader that parses graph/algorithms.json itself", () => {
    const offenders = directReads(units).filter((o) => !LOADERS.some((l) => o.startsWith(l)));
    expect(
      offenders,
      "these parse the committed store file directly, so they see an `implementations` array missing " +
        "every record under `graph/records/` — and they do not fail on it, they just cover less. Read " +
        "the store through `graph_materialize::load_merged_value` / `repo_store::read_at` (Rust) or " +
        "`scripts/lib/recordStore.mjs`'s `loadStore` (JS/TS).",
    ).toEqual([]);
  });

  it("still recognises a direct read when it sees one", () => {
    // Guard the guard: the assertion above passes for a scanner that matches nothing at all, which is
    // the one failure a boundary test cannot afford. These are the two shapes actually found in the
    // tree when this was written.
    expect(
      directReads([
        { name: "x.rs", text: 'let raw = std::fs::read_to_string(root.join("graph").join("algorithms.json"));' },
        { name: "y.ts", text: "const recs = JSON.parse(readFileSync('graph/algorithms.json','utf8'));" },
      ]),
    ).toEqual(["x.rs:1", "y.ts:1"]);
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
