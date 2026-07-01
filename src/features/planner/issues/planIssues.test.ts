import { describe, it, expect } from "vitest";
import { parseIssuesFile, validateIssues, renderIssueBody, issueTree, subIssueLinks, type PlanIssue } from "./planIssues";

const issue = (p: Partial<PlanIssue>): PlanIssue => ({
  ref: "F1", title: "Do the thing", acceptance: [], owns: [], dependsOn: [], labels: [], ...p,
});

describe("parseIssuesFile", () => {
  it("parses an array of issues, filling array fields", () => {
    const raw = JSON.stringify([
      { ref: "F1", title: "Add endpoint", acceptance: ["returns 200"], owns: ["src/api/**"], dependsOn: [], labels: ["scope:core"] },
      { ref: "F2", title: "Wire UI", depends_on: ["F1"], stream: "ui" },
    ]);
    const out = parseIssuesFile(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ref: "F1", acceptance: ["returns 200"], owns: ["src/api/**"], labels: ["scope:core"] });
    expect(out[1]).toMatchObject({ ref: "F2", dependsOn: ["F1"], stream: "ui" });
  });

  it("accepts a { issues: [...] } wrapper and an id alias for ref", () => {
    expect(parseIssuesFile(JSON.stringify({ issues: [{ id: "X", title: "t" }] }))[0].ref).toBe("X");
  });

  it("parses the execution status from plan.db, ignoring an unknown value (#plan-db)", () => {
    const out = parseIssuesFile(JSON.stringify([
      { ref: "F1", title: "done", status: "complete" },
      { ref: "F2", title: "fresh" },              // absent ⇒ undefined (treated as open)
      { ref: "F3", title: "typo", status: "done" }, // not a known status ⇒ undefined
    ]));
    expect(out[0].status).toBe("complete");
    expect(out[1].status).toBeUndefined();
    expect(out[2].status).toBeUndefined();
  });

  it("parses the parent ref for sub-issues (#…)", () => {
    const out = parseIssuesFile(JSON.stringify([
      { ref: "invite", title: "Invite teammates" },
      { ref: "invite-form", title: "Invite form UI", parent: "invite" },
    ]));
    expect(out[0].parent).toBeUndefined();
    expect(out[1].parent).toBe("invite");
  });
});

describe("issueTree (feature → sub-issue tree)", () => {
  it("nests sub-issues under their parent feature, keeping order", () => {
    const issues: PlanIssue[] = [
      issue({ ref: "invite", title: "Invite teammates" }),
      issue({ ref: "invite-api", title: "Invite API", parent: "invite" }),
      issue({ ref: "invite-ui", title: "Invite UI", parent: "invite" }),
      issue({ ref: "export", title: "Export" }),
    ];
    const tree = issueTree(issues);
    expect(tree.map((n) => n.issue.ref)).toEqual(["invite", "export"]);
    expect(tree[0].children.map((c) => c.ref)).toEqual(["invite-api", "invite-ui"]);
    expect(tree[1].children).toEqual([]);
  });

  it("treats an orphan parent (or self-parent) as a root, never dropping it", () => {
    const issues: PlanIssue[] = [
      issue({ ref: "a", title: "A", parent: "missing" }),
      issue({ ref: "b", title: "B", parent: "b" }),
    ];
    expect(issueTree(issues).map((n) => n.issue.ref)).toEqual(["a", "b"]);
  });
});

describe("subIssueLinks (publish — GitHub sub-issue node-id pairs)", () => {
  const issues: PlanIssue[] = [
    issue({ ref: "invite", title: "Invite teammates" }),
    issue({ ref: "invite-api", title: "Invite API", parent: "invite" }),
    issue({ ref: "invite-ui", title: "Invite UI", parent: "invite" }),
    issue({ ref: "orphan", title: "Orphan", parent: "invite" }), // parent resolves, child unresolved below
  ];
  it("returns parent→child node-id pairs only when both ends resolve", () => {
    const nodes = { invite: "N_invite", "invite-api": "N_api", "invite-ui": "N_ui" };
    const links = subIssueLinks(issues, nodes);
    expect(links).toEqual([
      { parent: "N_invite", child: "N_api" },
      { parent: "N_invite", child: "N_ui" },
    ]); // "orphan" dropped: no node id for it
  });
  it("skips when the parent node id is unknown", () => {
    expect(subIssueLinks(issues, { "invite-api": "N_api" })).toEqual([]);
  });

  it("drops entries missing ref or title, and tolerates bad JSON", () => {
    expect(parseIssuesFile("not json")).toEqual([]);
    expect(parseIssuesFile(JSON.stringify([{ title: "no ref" }, { ref: "ok", title: "y" }]))).toHaveLength(1);
  });
});

describe("validateIssues", () => {
  it("ok for a clean set", () => {
    const v = validateIssues([issue({ ref: "A", acceptance: ["x"] }), issue({ ref: "B", dependsOn: ["A"], acceptance: ["y"] })]);
    expect(v.ok).toBe(true);
  });

  it("flags duplicate refs", () => {
    const v = validateIssues([issue({ ref: "A" }), issue({ ref: "A" })]);
    expect(v.ok).toBe(false);
    expect(v.duplicateRefs).toEqual(["A"]);
  });

  it("flags a dangling dependency", () => {
    const v = validateIssues([issue({ ref: "A", dependsOn: ["ghost"] })]);
    expect(v.danglingDependencies).toEqual([{ ref: "A", dependsOn: "ghost" }]);
    expect(v.ok).toBe(false);
  });

  it("surfaces missing acceptance as a warning without failing validation", () => {
    const v = validateIssues([issue({ ref: "A" })]);
    expect(v.missingAcceptance).toEqual(["A"]);
    expect(v.ok).toBe(true); // not agent-ready, but structurally valid
  });
});

describe("renderIssueBody", () => {
  it("renders acceptance as a checklist plus owns + deps", () => {
    const md = renderIssueBody(issue({ acceptance: ["returns 200", "has a test"], owns: ["src/api/**"], dependsOn: ["F0"], body: "context here" }));
    expect(md).toMatch(/context here/);
    expect(md).toMatch(/## Acceptance criteria\n- \[ \] returns 200\n- \[ \] has a test/);
    expect(md).toMatch(/## Owns\n- `src\/api\/\*\*`/);
    expect(md).toMatch(/## Depends on\n- F0/);
  });

  it("omits empty sections", () => {
    const md = renderIssueBody(issue({}));
    expect(md).not.toMatch(/Acceptance criteria/);
    expect(md).toMatch(/Auto-generated by the base-studio-code planner/);
  });
});
