import { describe, it, expect } from "vitest";
import { checkConformance, effectiveDeniedCommands, type StreamAnchor } from "./conformance";
import { roleCapability } from "../session/sessionRoles";
import { DEFAULT_FLOW } from "@/features/planner/fleet/agentFlow";

// A worker stream owning src/api/**, with the default flow (auto-pr).
function workerAnchor(over: Partial<StreamAnchor> = {}): StreamAnchor {
  return {
    streamId: "api",
    ownedGlobs: ["src/api/**"],
    capability: roleCapability("worker", { writeGlobs: ["src/api/**"] }),
    flow: DEFAULT_FLOW, // push: auto-pr
    ...over,
  };
}

describe("effectiveDeniedCommands", () => {
  it("an auto-pr worker may push + open a PR, but not merge/repo-delete (role denies hold)", () => {
    const denied = effectiveDeniedCommands(roleCapability("worker"), DEFAULT_FLOW);
    expect(denied).not.toContain("git push");      // lifted by the flow grant (#304)
    expect(denied).not.toContain("gh pr create");  // lifted by the flow grant
    expect(denied).toContain("gh pr merge");       // merging is the director's job
    expect(denied).toContain("gh repo delete");
  });

  it("a commit-only worker is denied push + PR (flow blocks propagation)", () => {
    const denied = effectiveDeniedCommands(roleCapability("worker"), { ...DEFAULT_FLOW, push: "commit-only" });
    expect(denied).toContain("git push");
    expect(denied).toContain("gh pr create");
  });

  it("triage (git:none) denies git outright", () => {
    const denied = effectiveDeniedCommands(roleCapability("triage"), DEFAULT_FLOW);
    expect(denied).toContain("git");
  });
});

describe("checkConformance — file lane", () => {
  it("passes when every change is inside the owned globs", () => {
    const v = checkConformance(workerAnchor(), { changedFiles: ["src/api/routes.ts", "src/api/db.ts"], commands: [] });
    expect(v.onTask).toBe(true);
    expect(v.trips).toEqual([]);
  });

  it("trips on a file changed outside the stream's lane", () => {
    const v = checkConformance(workerAnchor(), { changedFiles: ["src/api/ok.ts", "src/web/app.tsx"], commands: [] });
    expect(v.onTask).toBe(false);
    expect(v.trips).toEqual([{ kind: "out-of-glob", detail: "src/web/app.tsx" }]);
  });

  it("a lane-less stream (no owned globs) imposes no file constraint", () => {
    const v = checkConformance(workerAnchor({ ownedGlobs: [] }), { changedFiles: ["anywhere/x.ts"], commands: [] });
    expect(v.onTask).toBe(true);
  });
});

describe("checkConformance — commands", () => {
  it("passes on allowed commands; trips on a role-denied write attempt", () => {
    const v = checkConformance(workerAnchor(), {
      changedFiles: [],
      commands: ["git status", "git commit -m wip", "gh pr merge 12 --squash"],
    });
    expect(v.onTask).toBe(false);
    expect(v.trips).toEqual([{ kind: "denied-command", detail: "gh pr merge 12 --squash" }]);
  });

  it("does NOT flag a push/PR the flow grants (auto-pr worker opening its own PR)", () => {
    const v = checkConformance(workerAnchor(), {
      changedFiles: [],
      commands: ["git push origin api", "gh pr create --title done"],
    });
    expect(v.onTask).toBe(true);
  });

  it("flags push under a commit-only flow (propagation blocked)", () => {
    const v = checkConformance(workerAnchor({ flow: { ...DEFAULT_FLOW, push: "commit-only" } }), {
      changedFiles: [],
      commands: ["git push origin api"],
    });
    expect(v.onTask).toBe(false);
    expect(v.trips).toEqual([{ kind: "denied-command", detail: "git push origin api" }]);
  });

  it("whole-word prefix match: 'git pushy' is not 'git push'", () => {
    const v = checkConformance(workerAnchor({ flow: { ...DEFAULT_FLOW, push: "commit-only" } }), {
      changedFiles: [],
      commands: ["git pushy-tool --run"],
    });
    expect(v.onTask).toBe(true);
  });

  it("regression: an injected mutating command outside the worker's scope is caught", () => {
    // Simulated prompt-injection — a worker steered into deleting the repo + merging.
    const v = checkConformance(workerAnchor(), {
      changedFiles: ["src/api/legit.ts"],
      commands: ["gh repo delete acme/api --yes", "gh pr merge 3"],
    });
    expect(v.onTask).toBe(false);
    expect(v.trips.map((t) => t.kind)).toEqual(["denied-command", "denied-command"]);
    expect(v.trips.map((t) => t.detail)).toEqual(["gh repo delete acme/api --yes", "gh pr merge 3"]);
  });
});
