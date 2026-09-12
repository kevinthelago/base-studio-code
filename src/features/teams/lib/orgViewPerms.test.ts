// `tierChips` reads the capability from RUST when it can
// (`the-role-gate-is-still-derived-in-typescript-outside-the-launch`).
//
// The Teams capability display used to compute a role's tiers with `roleCapability` — the renderer's
// own projection of the packaged persona floors. `bsc session perms all` is the same table derived in
// `bsc-perms`, and this pins that `tierChips` PREFERS it, while keeping the local computation for the
// one case that must not blank the panel: a read that could not run at all.
import { describe, it, expect } from "vitest";
import { tierChips } from "@/features/teams/lib/orgView";
import type { RolePerms, RolePermsTable, PermsCapability } from "@/shared/lib/session/rolePermsRead";

const cap = (role: string, over: Partial<PermsCapability> = {}): PermsCapability => ({
  role, github: "read", git: "write", code: "write", net: "read", ui: "read", graph: "write",
  writeGlobs: [], allow: [], surfaces: null, harvestRoots: [], ...over,
});

const table = (role: string, over: Partial<PermsCapability> = {}): RolePermsTable =>
  new Map<string, RolePerms>([[role, {
    capability: cap(role, over),
    deniedCommands: [], deniedTools: [], toolRules: { allow: [], deny: [] },
    writeScopeGlobs: [], restricted: false, surfaces: [], mayFileToolingRequest: false,
  }]]);

describe("tierChips derives its tiers from Rust when the read resolved", () => {
  it("renders the RUST tiers, not the locally computed ones", () => {
    // `worker` really is `git: write` locally, so a table saying `none` can only come from the read —
    // that is what makes this discriminating rather than a coincidence of two agreeing sources.
    const labels = tierChips("worker", table("worker", { git: "none", code: "none", github: "none" })).map((t) => t.label);
    expect(labels).not.toContain("git·write");
    expect(labels.some((l) => l.startsWith("net·"))).toBe(true);
  });

  it("still omits `none` axes and always states net on/off, whichever source supplied the tiers", () => {
    const chips = tierChips("worker", table("worker", { net: "none" }));
    expect(chips.find((c) => c.label.startsWith("net·"))?.label).toBe("net·off");
    expect(chips.every((c) => c.tier !== "none" || c.label.startsWith("net·"))).toBe(true);
  });
});

describe("tierChips falls back rather than blanking or denying", () => {
  it("a read that COULD NOT RUN keeps the local computation — a missing sidecar must not blank the panel", () => {
    // `readRolePerms` resolves null when the bridge or the bundled binary is absent. Rendering nothing,
    // or rendering every axis as `none`, would state something false about the agent.
    expect(tierChips("worker", null).map((t) => t.label)).toContain("git·write");
    expect(tierChips("worker").map((t) => t.label)).toContain("git·write");
  });

  it("a role the answer does not carry falls back instead of reading as fully denied", () => {
    // An empty table is a successful read that simply has no row for this role. Treating that as
    // `none` on every axis is the permissive/denied mistake in the opposite direction.
    const empty: RolePermsTable = new Map();
    expect(tierChips("worker", empty).map((t) => t.label)).toContain("git·write");
  });

  it("a read-only role shows no write tier from either source", () => {
    expect(tierChips("reviewer", null).every((t) => t.tier !== "write")).toBe(true);
    expect(tierChips("reviewer", table("reviewer", { git: "read", code: "none", github: "read" }))
      .every((t) => t.tier !== "write")).toBe(true);
  });
});
