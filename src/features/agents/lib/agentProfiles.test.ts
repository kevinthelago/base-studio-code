import { describe, it, expect } from "vitest";
import {
  resolveAllowlist,
  paneCount,
  consoleCount,
  findProfile,
  GUARANTEED,
  APP_ROLES,
} from "./agentProfiles";

describe("resolveAllowlist", () => {
  it("unions guaranteed ∪ profile ∪ project ∪ repo, deduped, in precedence order", () => {
    const out = resolveAllowlist("con_orch", "pf_build");
    expect(out.map((r) => r.cmd)).toEqual([
      "gh", "git", // guaranteed
      "cargo", "npm", "pnpm", "pytest", "make", "node", // profile
      "just", // project (cargo deduped — already from profile)
    ]);
    expect(out.find((r) => r.cmd === "gh")?.origin).toBe("guaranteed");
    expect(out.find((r) => r.cmd === "cargo")?.origin).toBe("profile");
    expect(out.find((r) => r.cmd === "just")?.origin).toBe("project");
  });

  it("includes repo-scope commands when present", () => {
    const out = resolveAllowlist("con_tunnel", "pf_build");
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
    expect(paneCount("pf_build")).toBe(2); // one pane in each console
    expect(consoleCount("pf_build")).toBe(2);
    expect(paneCount("pf_review")).toBe(1);
    expect(consoleCount("pf_review")).toBe(1);
  });

  it("findProfile resolves application roles and profiles", () => {
    expect(findProfile("sys_planner")?.category).toBe("application");
    expect(findProfile("pf_build")?.name).toBe("Build & test");
    expect(findProfile("nope")).toBeUndefined();
  });

  it("every basic app session has its own distinct application role (#680)", () => {
    // all three basic app sessions are registered as application roles, each unique
    const ids = APP_ROLES.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["sys_planner", "sys_librarian", "sys_blueprint_assistant", "sys_planning_autopilot"]));
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

  it("the Blueprint Assistant role is minimal — no shell, no fs writes, no tools (#680)", () => {
    const bp = findProfile("sys_blueprint_assistant")!;
    expect(bp.name).toBe("Blueprint Assistant");
    expect(bp.mode).toBe("deny");
    expect(bp.commands).toEqual([]);            // no shell
    expect(bp.tools.bash).toBe("deny");
    expect(bp.tools.write).toBe("deny");        // no fs writes
    expect(bp.tools.edit).toBe("deny");
    expect(bp.tools.read).toBe("allow");        // may read the blueprint/KB context
    expect(bp.paths.allow).toEqual([]);
    expect(bp.net.allow).toEqual([]);
  });
});
