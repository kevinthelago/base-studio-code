import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, PLANNER_WRITE_GLOBS, DOC_GLOBS, DB_OWNED_PLAN_FILES, DEP_MANIFEST_FILES } from "./sessionRoles";

// Security guard for the externalized role→capability table (@data/permissions/role-capabilities.json,
// #2027 P1). The role gate is least-privilege; a JSON edit that WIDENS a role's access (e.g. gives a
// reviewer git:write, or hands a non-planner default write globs) must trip a test here, not ship.
describe("role capability table (loaded from @data/permissions/role-capabilities.json)", () => {
  it("has exactly the 9 roles with their intended github/git/code/net tiers", () => {
    const tiers = Object.fromEntries(
      Object.values(ROLE_DEFAULTS).map((c) => [c.role, `${c.github}/${c.git}/${c.code}/${c.net}`]),
    );
    expect(tiers).toEqual({
      planner:    "read/read/write/read",
      worker:     "read/write/write/read",
      director:   "write/write/none/read",
      triage:     "write/none/none/read",
      tester:     "read/read/none/read",
      reviewer:   "read/read/none/read",
      issuer:     "write/read/none/read",
      juror:      "read/read/none/read",
      // Documentor (#1555): read-only on git/GitHub, code:none — writes come solely from its
      // DOC_GLOBS carve-out (asserted below), never a code tier.
      documentor: "read/read/none/read",
    });
  });

  it("only the planner + documentor ship default write globs; every other role starts empty (no code writes)", () => {
    expect(PLANNER_WRITE_GLOBS).toBe(ROLE_DEFAULTS.planner.writeGlobs); // same array — derived, not duplicated
    expect(PLANNER_WRITE_GLOBS).toEqual(["*.md", "*.json", "prompts/*.md", "prompts/*", "discovery/*.md", "discovery/*"]);
    // The documentor ships DOC_GLOBS by default (its prose-doc carve-out, #1555) — the only non-planner
    // role that launches with a write boundary, and strictly markdown/docs (no code extensions).
    expect(DOC_GLOBS).toBe(ROLE_DEFAULTS.documentor.writeGlobs); // same array — derived, not duplicated
    expect(DOC_GLOBS).toEqual(["*.md", "**/*.md", "docs/**", "README*", "**/README*", "CHANGELOG*"]);
    for (const c of Object.values(ROLE_DEFAULTS)) {
      if (c.role !== "planner" && c.role !== "documentor") expect(c.writeGlobs).toEqual([]);
    }
  });

  it("carries the db-owned + dep-manifest deny lists", () => {
    expect(DB_OWNED_PLAN_FILES).toEqual(["deploy.md", "deploy.json", "phases.json", "issues.json", "fleet.json", "repos.json", "features.json"]);
    expect(DEP_MANIFEST_FILES).toEqual(["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "pnpm-lock.yaml", "yarn.lock"]);
  });
});
