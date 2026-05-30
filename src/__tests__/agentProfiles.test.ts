import { describe, it, expect } from "vitest";
import {
  resolveAllowlist,
  paneCount,
  consoleCount,
  findProfile,
  GUARANTEED,
} from "../screens/agents/agentProfiles";

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
});
