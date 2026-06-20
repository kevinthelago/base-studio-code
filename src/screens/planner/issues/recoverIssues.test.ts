import { describe, it, expect } from "vitest";
import { recoverIssue, recoverIssues, type GitHubIssueLike } from "./recoverIssues";
import { renderIssueBody, type PlanIssue } from "./planIssues";

const issue = (p: Partial<PlanIssue>): PlanIssue => ({
  ref: "F1", title: "Do the thing", acceptance: [], owns: [], dependsOn: [], labels: [], ...p,
});

/** Build the GitHub issue a publish would create from a PlanIssue (body + milestone + stream label). */
const published = (iss: PlanIssue, number: number, state: "open" | "closed"): GitHubIssueLike => ({
  number,
  title: iss.title,
  body: renderIssueBody(iss),
  state,
  labels: [
    ...iss.labels.map((name) => ({ name })),
    ...(iss.stream ? [{ name: `stream:${iss.stream}` }] : []),
  ],
  milestone: iss.phase !== undefined ? { title: String(iss.phase) } : null,
});

describe("recoverIssue (GitHub → plan.db)", () => {
  it("round-trips a published issue back to its PlanIssue (lossless via the ref marker)", () => {
    const original = issue({
      ref: "auth-login",
      title: "Add POST /sessions",
      phase: "Phase 2 — auth",
      acceptance: ["returns 200 on valid creds", "sets the session cookie"],
      owns: ["src/auth/", "src/api/sessions.ts"],
      dependsOn: ["schema", "auth-config"],
      labels: ["scope:core", "area:api"],
      stream: "auth",
      body: "Prose context about the endpoint.",
    });
    const recovered = recoverIssue(published(original, 42, "open"), "acme/web");

    expect(recovered.ref).toBe("auth-login");                 // from the hidden marker, not #42
    expect(recovered.title).toBe("Add POST /sessions");
    expect(recovered.phase).toBe("Phase 2 — auth");           // from the milestone
    expect(recovered.acceptance).toEqual(original.acceptance);
    expect(recovered.owns).toEqual(original.owns);            // backticks stripped
    expect(recovered.dependsOn).toEqual(original.dependsOn);  // the refs survive — the whole point
    expect(recovered.labels).toEqual(["scope:core", "area:api"]); // stream label excluded
    expect(recovered.stream).toBe("auth");
    expect(recovered.body).toBe("Prose context about the endpoint.");
    expect(recovered.repo).toBe("acme/web");
    expect(recovered.status).toBe("open");
  });

  it("maps a closed issue to verified and an open one to open", () => {
    const iss = issue({ ref: "F1", title: "x" });
    expect(recoverIssue(published(iss, 1, "closed"), "a/b").status).toBe("verified");
    expect(recoverIssue(published(iss, 1, "open"), "a/b").status).toBe("open");
  });

  it("falls back to #<number> when an issue has no ref marker (not planner-published)", () => {
    const gh: GitHubIssueLike = { number: 7, title: "Hand-filed bug", body: "just prose", state: "open" };
    const r = recoverIssue(gh, "a/b");
    expect(r.ref).toBe("#7");
    expect(r.body).toBe("just prose");
    expect(r.acceptance).toEqual([]);
  });

  it("recovers a bare-string label shape and an absent milestone", () => {
    const gh: GitHubIssueLike = { number: 3, title: "t", state: "open", labels: ["scope:core", "stream:ui"], milestone: null };
    const r = recoverIssue(gh, "a/b");
    expect(r.stream).toBe("ui");
    expect(r.labels).toEqual(["scope:core"]);
    expect(r.phase).toBeUndefined();
  });
});

describe("recoverIssues (bulk)", () => {
  it("drops pull requests and titleless rows", () => {
    const rows: GitHubIssueLike[] = [
      { number: 1, title: "real issue", state: "open" },
      { number: 2, title: "a PR", state: "open", pull_request: { url: "..." } },
      { number: 3, title: "", state: "open" },
    ];
    const out = recoverIssues(rows, "a/b");
    expect(out.map((i) => i.title)).toEqual(["real issue"]);
  });
});
