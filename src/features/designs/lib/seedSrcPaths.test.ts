// Every packaged component seed's `src` must name a REAL file, with EXACT case.
//
// `pageheader` carried `src/shared/ui/pages/PageHeader.tsx` while the file is `pageHeader.tsx`. Windows'
// case-insensitive filesystem hid it completely — every `existsSync`, every editor jump, every `bsc components
// backing` call resolved it fine — so it sat for months looking like an "id collision". What it actually
// broke is anything matching the path as a STRING: a coverage sweep reported the module as unmigrated, and
// `bsc algorithms harvest <src>` would have re-harvested it to a second record. On a case-sensitive filesystem
// (CI, Linux, macOS with a case-sensitive volume) it stops resolving at all.
//
// The check is against a DIRECTORY LISTING, not `existsSync`, because on Windows `existsSync` answers the
// case-insensitive question and would pass on exactly the input this test exists to catch.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const SEEDS = join(REPO, "src-tauri", "data", "components");

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

/** Does `rel` exist with exactly this spelling? Listing the parent is the only case-EXACT answer on Windows. */
function existsExact(rel: string): boolean {
  const abs = join(REPO, rel);
  try {
    const entries = readdirSync(dirname(abs));
    return entries.includes(basename(abs));
  } catch {
    return false; // the directory itself is gone
  }
}

describe("packaged component seeds — src paths (#2725-era case bug)", () => {
  it("every seed whose src points into src/ names a real file with exact case", () => {
    const wrong: string[] = [];
    for (const f of jsonFiles(SEEDS)) {
      if (statSync(f).size > 4_000_000) continue; // the generated kit closure, not a per-record seed
      let rec: { id?: string; src?: string };
      try {
        rec = JSON.parse(readFileSync(f, "utf8"));
      } catch {
        continue; // not a record file; other tests own seed validity
      }
      const src = (rec?.src ?? "").replace(/\\/g, "/");
      // Only judge THIS repo's own paths. A record harvested from another repo (mobile-studio-code, a
      // generated app) legitimately has no file here, and a record whose file was RETIRED keeps its `src`
      // as provenance — neither is a defect, and failing them would make this test a nuisance that gets
      // deleted rather than a guard.
      if (!src.startsWith("src/")) continue;
      if (!existsExact(src)) {
        // Distinguish "gone" (fine) from "wrong case" (the bug): a case-insensitive hit with no
        // case-exact hit is precisely the failure this guards.
        const insensitive = (() => {
          try {
            return readdirSync(join(REPO, dirname(src)))
              .some((e) => e.toLowerCase() === basename(src).toLowerCase());
          } catch {
            return false;
          }
        })();
        if (insensitive) wrong.push(`${rec.id ?? basename(f)} — ${src}`);
      }
    }
    expect(wrong, `seed src differs from the real path only by case:\n  ${wrong.join("\n  ")}`).toEqual([]);
  });
});
