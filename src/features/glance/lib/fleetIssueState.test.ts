// #4103 — the completion gates read GitHub as evidence, not just plan.db.
import { describe, it, expect, vi, beforeEach } from "vitest";

const graphql = vi.fn();
vi.mock("@/shared/lib/github/github", () => ({ githubGraphql: (...a: unknown[]) => graphql(...a) }));

const { resolveClosedRefs } = await import("./fleetIssueState");
const { planResumeLaunch } = await import("./resumeProject");

const stream = (id: string, issues: string[]) =>
  ({ id, name: id, repo: "kev/app", owns: [], issues, dependsOn: [] });

beforeEach(() => graphql.mockReset());

describe("resolveClosedRefs", () => {
  it("returns each stream's OWN ref spelling, not the normalized number", async () => {
    // THE TRAP. `streamComplete` asks `stream.issues.every((r) => done.has(r))`, and a stream stores
    // "#3898" while GitHub returns the number 3898. A set of normalized refs matches NOTHING, so every
    // stream reads unfinished — the same silent failure #4103 is about, reintroduced from the other side.
    graphql.mockResolvedValue({ r0: { i3898: { number: 3898, state: "CLOSED" } } });
    const out = await resolveClosedRefs([stream("api", ["#3898"])]);
    expect(out.has("#3898")).toBe(true);
    expect(out.has("3898")).toBe(false);
  });

  it("omits an issue that is still open", async () => {
    graphql.mockResolvedValue({ r0: { i1: { number: 1, state: "OPEN" }, i2: { number: 2, state: "CLOSED" } } });
    expect([...await resolveClosedRefs([stream("api", ["#1", "#2"])])]).toEqual(["#2"]);
  });

  it("spends NO request when nothing is addressable", async () => {
    await resolveClosedRefs([{ repo: "", issues: [] }]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("a response it cannot parse yields NO closed refs", async () => {
    // The fail-closed direction: absent or unreadable evidence must under-report completion. Over-
    // reporting would skip a worker that still has work — the one outcome worse than re-launching one
    // that is finished. (The thrown-error path returns the same empty set; it is not asserted here
    // because a mock that throws trips vitest's own result tracking, not this code.)
    graphql.mockResolvedValue({ r0: null });
    expect((await resolveClosedRefs([stream("api", ["#1"])])).size).toBe(0);
  });

  it("an unreachable GitHub leaves every stream ACTIVE, never complete", async () => {
    // What the failure actually has to guarantee, asserted through the gate that consumes it.
    const { maintenanceIds } = planResumeLaunch(
      { streams: [stream("api", ["#1"])], director: { enabled: false } } as never,
      [],
      new Set(),                      // what a failed resolve returns
    );
    expect(maintenanceIds.size).toBe(0);
  });
});

describe("planResumeLaunch with GitHub evidence (#4103)", () => {
  const fleet = {
    streams: [stream("api", ["#1", "#2"]), stream("web", ["#3"])],
    director: { enabled: false },
  } as never;

  it("THE BUG: with no plan.db rows, nothing was ever complete", () => {
    // Measured on the live store: 40 streams, 0 issue rows. `doneIssueRefs([])` is empty, so
    // `streamComplete` was false for every stream — a relaunch restarted finished workers and
    // maintenance mode (#1957) never engaged.
    const { maintenanceIds } = planResumeLaunch(fleet, []);
    expect(maintenanceIds.size).toBe(0);
  });

  it("the same fleet prunes correctly once GitHub supplies the evidence", () => {
    const { maintenanceIds } = planResumeLaunch(fleet, [], new Set(["#1", "#2"]));
    expect([...maintenanceIds]).toEqual(["api"]);   // every owned ref closed ⇒ maintenance
  });

  it("unions the two sources — either one calling a ref done makes it done", () => {
    // plan.db knows only what a planner run authored; GitHub only what a token could reach. Neither is
    // complete alone, so a stream finished half by each must still prune.
    const { maintenanceIds } = planResumeLaunch(
      fleet,
      [{ ref: "#1", stream: "api", status: "complete" }],
      new Set(["#2"]),
    );
    expect([...maintenanceIds]).toEqual(["api"]);
  });

  it("a partially-finished stream stays ACTIVE", () => {
    const { maintenanceIds } = planResumeLaunch(fleet, [], new Set(["#1"]));
    expect(maintenanceIds.size).toBe(0);
  });
});
