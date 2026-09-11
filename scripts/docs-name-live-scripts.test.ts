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

  // package.json is the same rule applied to the file that can actually RUN the path. A doc naming a
  // deleted script misleads a reader; an npm script naming one hands them
  // `Error: Cannot find module`. This hole was live: `npm run retirement-candidates` ran
  // `scripts/retirement-candidates.mjs` for however long it had been since that capability became
  // `bsc ui retirable` — the very migration this file's header describes its author getting wrong in
  // the docs. The guard was written for the prose half and never extended to the executable half.
  it("every `scripts/…` path package.json would RUN exists on disk", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = Object.entries(pkg.scripts ?? {});
    // NON-VACUITY, same reason as above: a renamed key or a reshaped manifest must fail loudly rather
    // than scan nothing and pass. There were 29 npm scripts naming 20 script paths when this landed.
    expect(scripts.length).toBeGreaterThan(15);

    const dangling: string[] = [];
    let mentions = 0;
    for (const [name, cmd] of scripts) {
      for (const m of cmd.matchAll(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|ts|ps1)/g)) {
        mentions++;
        const p = resolve(REPO, m[0]);
        if (!existsSync(p) || !statSync(p).isFile()) dangling.push(`npm run ${name} → ${m[0]}`);
      }
    }
    expect(mentions).toBeGreaterThan(5);
    expect(
      dangling,
      `these npm scripts would run a file that does not exist:\n${dangling.join("\n")}`,
    ).toEqual([]);
  });
});
