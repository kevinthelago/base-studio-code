import { describe, it, expect, vi } from "vitest";
import { planRename, applyRename, RENAME_PROJECT_MUTATION, type RenameDeps } from "./renameProject";
import { projectSlug } from "@/shared/lib/core/projectPaths";

describe("planRename — the published-rename guard (#1226)", () => {
  const noKeys = new Set<string>();

  it("no-ops on an empty / whitespace title", () => {
    expect(planRename("   ", "Old", "node1", noKeys)).toEqual({ kind: "noop" });
  });

  it("no-ops when the (trimmed) title is unchanged", () => {
    expect(planRename("  Old  ", "Old", "node1", noKeys)).toEqual({ kind: "noop" });
  });

  it("no-ops when there's no published project id", () => {
    expect(planRename("New", "Old", null, noKeys)).toEqual({ kind: "noop" });
  });

  it("errors when the new name slugifies onto ANOTHER project's frozen key", () => {
    const others = new Set([projectSlug("Acme Web")]); // an existing project's key
    expect(planRename("Acme Web", "Old", "node1", others)).toEqual({
      kind: "error",
      message: expect.stringMatching(/already uses that name/i),
    });
  });

  it("ignores THIS project's own key (renaming to a slug-equivalent of itself isn't a collision)", () => {
    // otherKeys already excludes the current project (the caller filters by node id), so a slug
    // collision only triggers against a DIFFERENT project.
    expect(planRename("Acme API", "Old", "node1", new Set<string>())).toEqual({ kind: "rename", title: "Acme API" });
  });

  it("renames a valid, unique, changed title (trimmed)", () => {
    expect(planRename("  Acme API  ", "Old", "node1", noKeys)).toEqual({ kind: "rename", title: "Acme API" });
  });
});

describe("applyRename — local-first, GitHub board update (#1226)", () => {
  const deps = (graphql: RenameDeps["graphql"]): { d: RenameDeps; setMeta: ReturnType<typeof vi.fn> } => {
    const setMeta = vi.fn();
    return { d: { graphql, setMeta, repo: "me/app", number: 7, repos: ["me/app", "me/api"] }, setMeta };
  };

  it("updates local meta first, then issues updateProjectV2 with the node id + title", async () => {
    const graphql = vi.fn().mockResolvedValue({});
    const { d, setMeta } = deps(graphql);
    const err = await applyRename("node1", "Acme API", d);
    expect(err).toBeNull();
    expect(setMeta).toHaveBeenCalledWith("node1", "Acme API", "me/app", 7, ["me/app", "me/api"]);
    expect(graphql).toHaveBeenCalledWith(RENAME_PROJECT_MUTATION, { projectId: "node1", title: "Acme API" });
  });

  it("keeps the LOCAL rename and returns a retryable error when the GitHub update fails", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("offline"));
    const { d, setMeta } = deps(graphql);
    const err = await applyRename("node1", "Acme API", d);
    expect(setMeta).toHaveBeenCalledWith("node1", "Acme API", "me/app", 7, ["me/app", "me/api"]); // local still applied
    expect(err).toMatch(/GitHub board update failed/i); // surfaced + retryable
  });

  it("targets the updateProjectV2 mutation (not delete/create)", () => {
    expect(RENAME_PROJECT_MUTATION).toMatch(/updateProjectV2/);
    expect(RENAME_PROJECT_MUTATION).toMatch(/\$projectId: ID!/);
    expect(RENAME_PROJECT_MUTATION).toMatch(/\$title: String!/);
  });
});
