import { describe, it, expect } from "vitest";
import { groupRefsByRepo, buildIssueStateQuery, parseIssueStates, closedRefs } from "./issueStateQuery";

describe("groupRefsByRepo", () => {
  it("collapses every stream's refs into ONE group per repo", () => {
    // The whole point: a drilled fleet owns ~60 refs across a couple of repos, and this is what keeps
    // that at two requests instead of sixty (#3908/#3912/#3944/#3954).
    const groups = groupRefsByRepo([
      { repo: "o/a", issues: ["#1", "#2"] },
      { repo: "o/a", issues: ["#3"] },
      { repo: "o/b", issues: ["#9"] },
    ]);
    expect(groups).toEqual([
      { repo: "o/a", numbers: ["1", "2", "3"] },
      { repo: "o/b", numbers: ["9"] },
    ]);
  });

  it("de-duplicates a ref two streams both claim", () => {
    const [g] = groupRefsByRepo([{ repo: "o/a", issues: ["#1"] }, { repo: "o/a", issues: ["#1"] }]);
    expect(g.numbers).toEqual(["1"]);
  });

  it("drops non-numeric and repo-less refs rather than sending a malformed query", () => {
    // One unaddressable ref must not fail the batch and blank out every other stream's progress.
    const groups = groupRefsByRepo([
      { repo: "o/a", issues: ["#1", "owner/x#5", "TBD", ""] },
      { repo: "", issues: ["#7"] },
      { issues: ["#8"] },
      { repo: "noslash", issues: ["#9"] },
    ]);
    expect(groups).toEqual([{ repo: "o/a", numbers: ["1"] }]);
  });
});

describe("buildIssueStateQuery", () => {
  it("aliases every repo and issue so one query answers them all", () => {
    const q = buildIssueStateQuery([{ repo: "kev/app", numbers: ["12", "34"] }]);
    expect(q).toContain('r0: repository(owner: "kev", name: "app")');
    expect(q).toContain("i12: issue(number: 12) { number state }");
    expect(q).toContain("i34: issue(number: 34) { number state }");
  });

  it("prefixes aliases so a numeric ref cannot produce invalid GraphQL", () => {
    // A bare `12:` alias is a syntax error that would fail the entire batch.
    const q = buildIssueStateQuery([{ repo: "o/a", numbers: ["12"] }])!;
    expect(q).not.toMatch(/\s12:\s/);
  });

  it("returns null when there is nothing to ask", () => {
    // The caller must not spend a request (nor show a spinner) for a fleet owning no refs.
    expect(buildIssueStateQuery([])).toBeNull();
    expect(buildIssueStateQuery([{ repo: "o/a", numbers: [] }])).toBeNull();
  });

  it("skips a repo whose name could inject query text", () => {
    expect(buildIssueStateQuery([{ repo: 'o/a" evil(x:"1', numbers: ["1"] }])).toBeNull();
  });
});

describe("parseIssueStates", () => {
  const data = {
    r0: { i1: { number: 1, state: "CLOSED" }, i2: { number: 2, state: "OPEN" } },
    r1: { i9: { number: 9, state: "closed" } },
  };

  it("maps every alias back to ref → closed", () => {
    const m = parseIssueStates(data);
    expect(m.get("1")).toBe(true);
    expect(m.get("2")).toBe(false);
    expect(m.get("9")).toBe(true);   // case-insensitive
  });

  it("skips nulls so one dead ref costs only its own state", () => {
    // GitHub returns null for an alias whose issue does not exist, alongside partial data — these refs
    // are hand-maintained in the plan, so stale ones are expected.
    const m = parseIssueStates({ r0: { i1: null, i2: { number: 2, state: "OPEN" } } });
    expect(m.has("1")).toBe(false);
    expect(m.get("2")).toBe(false);
  });

  it("returns empty for a missing or malformed response instead of throwing", () => {
    expect(parseIssueStates(null).size).toBe(0);
    expect(parseIssueStates(undefined).size).toBe(0);
    expect(parseIssueStates("nope").size).toBe(0);
    expect(parseIssueStates({ r0: { i1: { number: "x", state: 5 } } }).size).toBe(0);
  });
});

describe("closedRefs", () => {
  it("yields only the closed ones", () => {
    expect([...closedRefs(new Map([["1", true], ["2", false]]))]).toEqual(["1"]);
  });
});
