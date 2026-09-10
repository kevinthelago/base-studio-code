// Residue guards — a tracked thing nobody reads is residue, and residue is indistinguishable from
// source to whoever finds it next.
//
// Both rules here were derived from something actually found on `main` on 2026-09-10, and both go RED
// against the tree as it stood that morning:
//
//   * `archive/` — 29 tracked JSON files (8 blueprints, 21 stages) moved aside by 5def26b7d "ahead of
//     the agent-authored-connector direction". Nothing loaded them, nothing globbed them, and there was
//     no README saying why they were kept. Git history already held them twice over: once at their
//     original paths, once at the archived ones.
//   * `demo.rs` — a 0-byte tracked file at the repo ROOT, landed by 9b7f044de, a bsc-agent commit that
//     had nothing to do with it. Not a module, not in a manifest, not `include!`d by anything.
//
// Neither was caught by anything, and neither could be: `tsc` does not look at JSON nobody imports,
// clippy does not look at a `.rs` outside the workspace, and `.gitignore` cannot help with files that
// are deliberately tracked. The only thing that sees either is a question asked over the whole tree.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Tracked paths, working-tree state — so an uncommitted addition is caught on the branch that adds it
 *  rather than one merge later. */
const tracked = (): string[] => git(["ls-files"]).split("\n").filter(Boolean);

/** The top-level directories that hold tracked files. */
const topLevelDirs = (): string[] => [...new Set(tracked().filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();

/** Files that REFERENCE `<dir>/`, excluding the directory itself.
 *
 *  Two deliberate narrowings, each of which the archive/ case needed:
 *
 *  * ANCHORED. A bare substring search for `archive/` matched `docs/archive/`, `base-studio-code-archive/`
 *    and `refs/archive/` — five hits, none of them a reader. The leading class rules out a longer path
 *    segment ending in the name, which is the only way this dir's name appeared anywhere real.
 *  * NO MARKDOWN. Prose MENTIONS a directory; it does not read one. CHANGELOG.md's line announcing the
 *    move to `archive/` is the single anchored hit that survived, and treating it as a reader is exactly
 *    backwards — a changelog entry saying something was archived is evidence it is residue, not evidence
 *    it is live. Measured with prose excluded, the live directories score 3 to 377 and `archive/` scores
 *    0, so nothing here rests on a threshold.
 *
 *  `-I` skips binaries, which matters: `graph/*.db` is 71 MB of SQLite and `.gitattributes` marks it
 *  binary precisely so git stops trying to read it as text. */
function referencesTo(dir: string): string[] {
  try {
    return git(["grep", "-l", "-I", "-E", `(^|[^A-Za-z0-9_./-])${dir}/`, "--", `:!${dir}/`, ":!*.md"]).split("\n").filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match
  }
}

describe("repo residue", () => {
  it("every top-level tracked directory is read by something that RUNS", () => {
    const dirs = topLevelDirs();
    // POPULATION FLOOR. A scanner that silently stops matching reports zero offenders, which reads as a
    // pass — the failure mode this repo has been caught by more than any other. If `git ls-files` ever
    // returns nothing useful this fails loudly instead of going quiet.
    expect(dirs.length).toBeGreaterThanOrEqual(10);

    const unread = dirs.filter((d) => referencesTo(d).length === 0);
    expect(unread, `top-level directories no non-prose tracked file references — residue, or a reader that went missing: ${unread.join(", ")}`).toEqual([]);
  });

  it("every tracked Rust file lives in a crate", () => {
    // Rust source outside the workspace roots is invisible to cargo AND to clippy, so it can sit there
    // indefinitely at any size without one tool complaining. `demo.rs` did, at 0 bytes.
    const rs = tracked().filter((p) => p.endsWith(".rs"));
    expect(rs.length).toBeGreaterThanOrEqual(50); // floor: the scanner still finds the corpus
    const stray = rs.filter((p) => !/^(crates|src-tauri)\//.test(p));
    expect(stray, `tracked .rs outside crates/ and src-tauri/ — cargo never compiles these and clippy never sees them: ${stray.join(", ")}`).toEqual([]);
  });
});
