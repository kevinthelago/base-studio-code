// A DOC MAY NOT NAME A SCRIPT THAT NO LONGER EXISTS.
//
// The whole argument of `record-operations-belong-on-the-bsc-surface-not-in-scripts` is that a capability
// found by `ls scripts/` is not a surface — so the docs ARE the surface, and a path in them that opens
// nothing is worse than no mention: the reader concludes the tool is missing from their checkout.
//
// It happened twice, and once was mine. Migrating `retirement-candidates.mjs` to `bsc ui retirable` I
// updated the recipe block and missed a prose mention forty lines earlier, so `docs/records.md` went on
// telling readers to run a file the same change had deleted. Nothing was watching, because every gate
// leg reads code and none reads prose.
//
// HISTORY IS EXEMPT; INSTRUCTIONS ARE NOT. `docs/sessions/**`, `CHANGELOG.md` and `RESUME.md` are all
// dated records — a kickoff, a release entry or a "resume here, end of 2026-08-23" snapshot that named
// the tool of its day is accurate history, and rewriting it to match today would falsify the record. Every
// other `.md` is read as current instruction and must only name files that exist.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO = resolve(__dirname, "..");

/** Dated records, exempt by the rule in the header. Paths are repo-relative. */
const HISTORY = new Set(["docs/sessions", "CHANGELOG.md", "RESUME.md"]);

/** Every `.md` outside `docs/sessions/`, repo-relative. */
function liveDocs(dir = REPO, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "target" || e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (HISTORY.has(r)) continue; // dated history, not instructions — see the header
    if (e.isDirectory()) out.push(...liveDocs(join(dir, e.name), r));
    else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}

describe("the docs never name a deleted script", () => {
  it("every `scripts/…` path a live doc mentions exists on disk", () => {
    const dangling: string[] = [];
    let mentions = 0;
    for (const doc of liveDocs()) {
      const text = readFileSync(resolve(REPO, doc), "utf8");
      for (const m of text.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|ts|ps1)/g)) {
        mentions++;
        const p = resolve(REPO, m[0]);
        if (!existsSync(p) || !statSync(p).isFile()) dangling.push(`${doc} → ${m[0]}`);
      }
    }
    // NON-VACUITY: if the scan ever stops FINDING mentions — a moved doc tree, a broken pattern — it
    // guards nothing while still reporting green, which is the exact failure this repo keeps hitting.
    // The floor is about the scan working, not a target: live docs named 9 script paths when this landed.
    expect(mentions).toBeGreaterThan(5);
    expect(dangling, `these docs point at scripts that do not exist:\n${dangling.join("\n")}`).toEqual([]);
  });
});
