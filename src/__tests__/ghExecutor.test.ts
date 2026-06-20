import { describe, it, expect } from "vitest";
import { executePublish, type GhRequest, type GhResponse, type Performer } from "../screens/planner/github/ghExecutor";
import type { PublishOp } from "../screens/planner/github/publishAdapter";

/** Mock performer: records requests; issues/milestones get sequential numbers,
 *  issues also a database id. */
function mockPerformer(): { perform: Performer; requests: GhRequest[] } {
  const requests: GhRequest[] = [];
  let n = 0;
  const perform = async (req: GhRequest): Promise<GhResponse> => {
    requests.push(req);
    n += 1;
    if (req.path.endsWith("/issues")) return { number: n, id: 1000 + n };
    if (req.path.endsWith("/milestones")) return { number: n };
    return {};
  };
  return { perform, requests };
}

const repo = "owner/repo";

const ops: PublishOp[] = [
  { op: "project", title: "Demo" },
  { op: "milestone", title: "Phase 1" },
  { op: "label", name: "stream:api" },
  { op: "epic", title: "Auth", childTitles: ["login", "logout"], representation: "parent+sub-issues+label" },
  { op: "dependency", from: "logout", to: "login", representation: "body-text" },
];

describe("executePublish", () => {
  it("creates parent + children and links sub-issues with the child database id", async () => {
    const { perform, requests } = mockPerformer();
    const res = await executePublish(ops, repo, perform);

    const paths = requests.map((r) => r.path);
    expect(paths).toEqual([
      `repos/${repo}/milestones`,
      `repos/${repo}/labels`,
      `repos/${repo}/issues`, // parent (n=3)
      `repos/${repo}/issues`, // login (n=4, id 1004)
      `repos/${repo}/issues/3/sub_issues`,
      `repos/${repo}/issues`, // logout (n=6, id 1006)
      `repos/${repo}/issues/3/sub_issues`,
      `repos/${repo}/issues/6/comments`, // dependency on logout (#6)
    ]);

    // sub-issue links carry the child's database id
    const subIssueBodies = requests.filter((r) => r.path.endsWith("/sub_issues")).map((r) => r.body);
    expect(subIssueBodies).toEqual([{ sub_issue_id: 1004 }, { sub_issue_id: 1006 }]);

    // dependency comment
    expect(requests[requests.length - 1].body).toEqual({ body: "depends_on: login" });

    expect(res.requests).toBe(8);
    expect(res.created).toEqual({ milestones: 1, labels: 1, epics: 1, issues: 2, dependencies: 1 });
    expect(res.warnings).toContain("project (Projects v2) is GraphQL — not created by the REST executor");
  });

  it("task-list epics create children but no sub-issue links", async () => {
    const { perform, requests } = mockPerformer();
    await executePublish(
      [{ op: "epic", title: "E", childTitles: ["a", "b"], representation: "parent+task-list" }],
      repo,
      perform,
    );
    expect(requests.filter((r) => r.path.endsWith("/sub_issues"))).toHaveLength(0);
    expect(requests.filter((r) => r.path === `repos/${repo}/issues`)).toHaveLength(3); // parent + 2 children
  });

  it("warns on dependency representations it can't wire yet", async () => {
    const { perform } = mockPerformer();
    const res = await executePublish(
      [{ op: "dependency", from: "#2", to: "#1", representation: "native-relationship" }],
      repo,
      perform,
    );
    expect(res.warnings.some((w) => w.includes("not wired yet"))).toBe(true);
  });
});
