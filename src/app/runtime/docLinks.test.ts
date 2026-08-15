// EVERY MARKDOWN LINK TO A REPO PATH MUST RESOLVE.
//
// Documentation rots in a direction no compiler notices: a file moves or is retired, and the doc keeps
// pointing at where it used to be. That is worse here than in most repos, because ~930 modules now ship as
// RECORDS rather than files (see `docs/records.md`) — so a stale path does not merely 404, it sends the
// reader hunting for a file that was deliberately deleted, which is the single most confusing thing this
// migration can do to someone who was not present for it.
//
// Three were broken when this test was written, and each had survived because nothing checks:
//   docs/backend.md   → `src-tauri/src/console/shell_rc.rs`, which became a DIRECTORY in the dir-module
//                        refactor and is referenced four times
//   relay/README.md   → `../docs/tunnel-protocol.md`, which never existed at all
//   SECURITY.md       → `docs/repo-credentials.md`, cited as the reference for repo-scoped credentials —
//                        a security claim pointing at nothing
//
// Scope: LINKS only (`[text](path)`), not backticked prose. A backticked path may be deliberate history
// ("`Spacer.tsx` was retired in #…"), and CHANGELOG/`docs/archive/` are supposed to name things that no
// longer exist. A link is a promise you can follow it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const SKIP_DIRS = /^(node_modules|target|dist|coverage|\.git|\.bsc-records)$/;

function markdownFiles(dir = REPO, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // `wt-*` are sibling worktrees of OTHER branches — their docs are not this branch's problem.
      if (SKIP_DIRS.test(e.name) || e.name.startsWith("wt-")) continue;
      out.push(...markdownFiles(join(dir, e.name), r));
    } else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}

/** Does a repo-relative path exist? Directories count — a dir-module link is a valid target. */
const exists = (p: string): boolean => {
  const clean = p.replace(/[#?].*$/, "");
  if (!clean) return true; // a pure `#anchor` is in-page
  try {
    statSync(join(REPO, clean));
    return true;
  } catch {
    return false;
  }
};

describe("markdown links resolve", () => {
  const docs = markdownFiles();

  it("finds the documentation", () => {
    expect(docs.length).toBeGreaterThan(20); // non-vacuity: an empty sweep would pass every assertion
  });

  it("every relative link points at something that exists", () => {
    const broken: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO, doc), "utf8");
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const rel = target.startsWith("/")
          ? target.slice(1)
          : join(dirname(doc), target).split("\\").join("/");
        if (!exists(rel)) broken.push(`${doc} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
