// The repo-scoped CREDENTIAL choice, captured from the live TypeScript so Rust can be proved to match.
//
// This is a security boundary of the same shape as the role gate: `tokenForRepo` picks the credential a
// worker/triage pane is LAUNCHED with as its `GH_TOKEN` (#158), so a session for repo A cannot act on
// repo B; `resolveGithubToken` picks the one a proxied REST request carries. Rust owns both ends —
// `pty_create` builds the session env and `github/api.rs` is the API layer — and the choice was made in
// the renderer.
//
// ## Three rules a port drifts on, each with its own case
//
//   * The token VALUE is tested for truthiness, so a repo with an ASSIGNED BUT EMPTY token falls back
//     to the global one. A corpus of realistic non-empty tokens passes either version.
//   * Matching is case-insensitive on `owner/name`, because GitHub repo names are.
//   * The FIRST matching entry wins — only observable with two keys differing solely by case, and only
//     reproducible if the input preserves ORDER. A Rust `HashMap` would not; a `BTreeMap` would sort
//     rather than keep insertion order. Hence the fixture records ordered PAIRS.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/repoCredentials.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoFromGitHubPath, resolveGithubToken, tokenForRepo } from "@/shared/lib/github/repoCredentials";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/repoCredentials.fixtures.json");

/** Paths, including the shapes that are NOT repo-scoped and the truncated ones. */
const PATHS = [
  "/repos/acme/web", "repos/acme/web", "/repos/acme/web/issues", "/repos/acme/web/pulls/3",
  "/repos/acme/web?state=open", "/repos/acme/web#frag", "/repos/Acme/Web",
  // Not repo-scoped at all.
  "user/repos", "/user/repos", "/users/x/events", "/orgs/acme/repos", "/search/issues?q=x",
  // Truncated / degenerate — a repo needs BOTH segments.
  "", "/", "/repos", "/repos/", "/repos/acme", "/repos/acme/", "//repos/acme/web",
  // A dot and a dash are ordinary name characters; a second slash ends the name.
  "/repos/acme/my-repo.js", "/repos/a/b/c/d",
];

/** Ordered pairs, so first-match-wins is observable and reproducible. */
type Pairs = [string, string][];
const CASES: { label: string; repo: string | null; pairs: Pairs; global: string }[] = [
  { label: "no assignment falls back to global", repo: "acme/web", pairs: [], global: "GLOBAL" },
  { label: "exact assignment wins", repo: "acme/web", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "case-insensitive on the key", repo: "acme/web", pairs: [["Acme/Web", "T1"]], global: "GLOBAL" },
  { label: "case-insensitive on the query", repo: "ACME/WEB", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "a different repo does not match", repo: "acme/api", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  // THE SENTINEL: assigned but EMPTY is skipped by the truthiness test, so the global wins.
  { label: "an assigned but EMPTY token falls back to global", repo: "acme/web", pairs: [["acme/web", ""]], global: "GLOBAL" },
  // …and the skip continues scanning, so a later case-variant entry can still match.
  { label: "an empty entry is skipped, a later variant still matches", repo: "acme/web", pairs: [["acme/web", ""], ["ACME/WEB", "T2"]], global: "GLOBAL" },
  // FIRST match wins — only visible with two keys differing solely by case.
  { label: "first match wins among case variants", repo: "acme/web", pairs: [["acme/web", "FIRST"], ["ACME/WEB", "SECOND"]], global: "GLOBAL" },
  // A null / empty repo is the director or an unbound console.
  { label: "a null repo is the global token", repo: null, pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "an empty repo is the global token", repo: "", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  // An empty GLOBAL is a real state (no PAT connected) and must come back as-is, not as a match.
  { label: "an empty global is returned when nothing matches", repo: "acme/api", pairs: [["acme/web", "T1"]], global: "" },
];

const RESOLVE: { label: string; path: string; pairs: Pairs; global: string }[] = [
  { label: "a repo path picks its scoped token", path: "/repos/acme/web/issues", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "a non-repo path always takes the global", path: "/user/repos", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "a repo path with no assignment takes the global", path: "/repos/other/x", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "case differs between path and key", path: "/repos/ACME/WEB", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
  { label: "query string does not defeat the match", path: "/repos/acme/web?state=open", pairs: [["acme/web", "T1"]], global: "GLOBAL" },
];

const obj = (pairs: Pairs) => Object.fromEntries(pairs);

function build() {
  return {
    note: "GENERATED from the live TypeScript — see repoCredentials.fixtures.gen.test.ts",
    paths: PATHS.map((path) => ({ path, repo: repoFromGitHubPath(path) })),
    tokenForRepo: CASES.map(({ label, repo, pairs, global }) => ({
      label, repo, pairs, global, token: tokenForRepo(repo, obj(pairs), global),
    })),
    resolve: RESOLVE.map(({ label, path, pairs, global }) => ({
      label, path, pairs, global, token: resolveGithubToken(path, obj(pairs), global),
    })),
  };
}

describe("the repo-scoped credential choice is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** The corpus must contain both a repo-scoped and a non-repo path, or the parse is untested. */
  it("covers repo-scoped and non-repo paths", () => {
    const p = build().paths;
    expect(p.some((x) => x.repo !== null)).toBe(true);
    expect(p.filter((x) => x.repo === null).length).toBeGreaterThanOrEqual(8);
  });

  /** THE SENTINEL. An assigned-but-empty token must not be returned. */
  it("pins that an empty assigned token falls back to the global", () => {
    const c = build().tokenForRepo.find((x) => x.label.includes("EMPTY token"))!;
    expect(c.token).toBe("GLOBAL");
  });

  /** First-match-wins is only observable with two case-variant keys. */
  it("pins first-match-wins with two keys differing only by case", () => {
    const c = build().tokenForRepo.find((x) => x.label.startsWith("first match wins"))!;
    expect(c.token).toBe("FIRST");
  });

  /** Skipping an empty entry must CONTINUE scanning rather than stop. */
  it("keeps scanning past an empty entry", () => {
    const c = build().tokenForRepo.find((x) => x.label.startsWith("an empty entry is skipped"))!;
    expect(c.token).toBe("T2");
  });

  /** Both outcomes must occur in the resolve corpus, or one branch is untested. */
  it("resolves some paths to a scoped token and some to the global", () => {
    const r = build().resolve;
    expect(r.some((x) => x.token === "T1")).toBe(true);
    expect(r.some((x) => x.token === "GLOBAL")).toBe(true);
  });
});
