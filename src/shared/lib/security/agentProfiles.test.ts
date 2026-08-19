import { describe, it, expect } from "vitest";
import {
  resolveAllowlistFrom,
  paneCount,
  consoleCount,
  findProfile,
  GUARANTEED,
  APP_ROLES,
  type ConsoleSession,
} from "./agentProfiles";

// Sample console roster — a fixture for the pure resolution/count helpers. Moved
// out of the production module in #2912 (the only consumer was this test; the live
// Security UI derives its consoles from real app state via `deriveConsoles`).
const CONSOLES: ConsoleSession[] = [
  {
    id: "con_orch", name: "orchestrator", repo: "acme/payments", status: "running",
    projectAllow: ["cargo", "just"],
    panes: [
      { id: "t1p0", agent: "@scratch", status: "running", profileId: "pf_auto" },
      { id: "t1p1", agent: "@reviewer", status: "awaiting", profileId: "pf_review" },
      { id: "t1p2", agent: "@docs", status: "idle", profileId: "pf_review" },
      { id: "t1p3", agent: "@github", status: "running", profileId: "pf_auto" },
    ],
  },
  {
    id: "con_tunnel", name: "feat/tunnel", repo: "acme/payments", status: "running",
    projectAllow: ["cargo", "just"], repoAllow: ["wscat"],
    panes: [
      { id: "t2p0", agent: "@scratch", status: "running", profileId: "pf_auto" },
      { id: "t2p1", agent: "@explore", status: "idle", profileId: "pf_sandbox" },
    ],
  },
];

// Resolve against the fixture roster — mirrors how the live UI calls
// `resolveAllowlistFrom` with its own in-component consoles.
const resolveAllowlist = (consoleId: string, profileId: string) =>
  resolveAllowlistFrom(CONSOLES.find((c) => c.id === consoleId), findProfile(profileId));

describe("resolveAllowlist", () => {
  it("unions guaranteed ∪ profile ∪ project ∪ repo, deduped, in precedence order", () => {
    const out = resolveAllowlist("con_orch", "pf_auto");
    expect(out.map((r) => r.cmd)).toEqual([
      "gh", "git", // guaranteed
      "cargo", "npm", "pnpm", "pytest", "make", "node", "docker", "aws", // profile (gh deduped)
      "just", // project (cargo deduped — already from profile)
    ]);
    expect(out.find((r) => r.cmd === "gh")?.origin).toBe("guaranteed");
    expect(out.find((r) => r.cmd === "cargo")?.origin).toBe("profile");
    expect(out.find((r) => r.cmd === "just")?.origin).toBe("project");
  });

  it("includes repo-scope commands when present", () => {
    const out = resolveAllowlist("con_tunnel", "pf_auto");
    expect(out.find((r) => r.cmd === "wscat")?.origin).toBe("repo");
  });

  it("a deny-everything profile still gets the guaranteed commands", () => {
    expect(resolveAllowlist("con_tunnel", "pf_sandbox").map((r) => r.cmd)).toEqual([
      ...GUARANTEED,
      "cargo", "just", "wscat", // from console scopes
    ]);
  });
});

describe("counts + lookup", () => {
  it("paneCount / consoleCount", () => {
    expect(paneCount("pf_auto", CONSOLES)).toBe(3); // t1p0, t1p3, t2p0
    expect(consoleCount("pf_auto", CONSOLES)).toBe(2);
    expect(paneCount("pf_review", CONSOLES)).toBe(2); // t1p1, t1p2
    expect(consoleCount("pf_review", CONSOLES)).toBe(1);
  });

  it("findProfile resolves application roles and profiles", () => {
    expect(findProfile("sys_planner")?.category).toBe("application");
    expect(findProfile("pf_auto")?.name).toBe("Autonomous (trusted)");
    expect(findProfile("nope")).toBeUndefined();
  });

  it("every basic app session has its own distinct application role (#680)", () => {
    // The packaged application roles are unique, registered singletons.
    const ids = APP_ROLES.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["sys_planner", "sys_planning_autopilot"]));
    expect(APP_ROLES.every((r) => r.category === "application")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    expect(new Set(APP_ROLES.map((r) => r.name)).size).toBe(APP_ROLES.length); // distinct names
  });

  it("the Planning Autopilot (simulated user) has its own minimal role (#682)", () => {
    const ap = findProfile("sys_planning_autopilot")!;
    expect(ap.name).toBe("Planning Autopilot");
    expect(ap.category).toBe("application");
    expect(ap.mode).toBe("deny");
    expect(ap.commands).toEqual([]);
    expect(ap.tools.bash).toBe("deny");
    expect(ap.tools.write).toBe("deny");
    expect(ap.tools.read).toBe("allow"); // reads the pitch + planner output
  });
});
