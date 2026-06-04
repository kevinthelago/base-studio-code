import { describe, it, expect, vi } from "vitest";
import {
  findProjectByTitle,
  ensureGithubProject,
  canLaunchTriage,
  triageLockReason,
  type GithubProjectRef,
  type Gql,
} from "../lib/projectSync";

const board = (id: string, number: number, title: string): GithubProjectRef =>
  ({ id, number, title, url: `https://github.com/users/o/projects/${number}` });

describe("findProjectByTitle (#444 dedupe guard)", () => {
  const boards = [board("P1", 1, "Studio Code"), board("P2", 2, "  Other  ")];
  it("matches case/whitespace-insensitively", () => {
    expect(findProjectByTitle(boards, "studio code")?.id).toBe("P1");
    expect(findProjectByTitle(boards, " other ")?.id).toBe("P2");
  });
  it("returns null when no board matches", () => {
    expect(findProjectByTitle(boards, "nope")).toBeNull();
  });
});

describe("ensureGithubProject (#444 adopt-or-create)", () => {
  it("returns linked without any GraphQL when activeProjectId is set", async () => {
    const gql = vi.fn();
    const res = await ensureGithubProject(gql as unknown as Gql, {
      activeProjectId: "PVT_existing", ownerLogin: "o", title: "T",
    });
    expect(res).toEqual({ action: "linked", id: "PVT_existing" });
    expect(gql).not.toHaveBeenCalled(); // already linked — no round-trip
  });

  it("adopts an existing same-title board instead of creating a duplicate", async () => {
    const gql = vi.fn().mockResolvedValueOnce({
      repositoryOwner: { id: "OWNER", projectsV2: { nodes: [board("PVT_dup", 7, "My Project")] } },
    });
    const res = await ensureGithubProject(gql as unknown as Gql, {
      activeProjectId: "", ownerLogin: "o", title: "my project", // case-insensitive match
    });
    expect(res).toEqual({ action: "adopted", id: "PVT_dup", number: 7, url: board("PVT_dup", 7, "x").url });
    expect(gql).toHaveBeenCalledTimes(1); // owner lookup only, NO create mutation
  });

  it("creates a new board when no same-title board exists", async () => {
    const gql = vi.fn()
      .mockResolvedValueOnce({ repositoryOwner: { id: "OWNER", projectsV2: { nodes: [board("PVT_other", 1, "Unrelated")] } } })
      .mockResolvedValueOnce({ createProjectV2: { projectV2: { id: "PVT_new", number: 9, url: "u" } } });
    const res = await ensureGithubProject(gql as unknown as Gql, {
      activeProjectId: "", ownerLogin: "o", title: "Fresh",
    });
    expect(res).toEqual({ action: "created", id: "PVT_new", number: 9, url: "u" });
    expect(gql).toHaveBeenCalledTimes(2); // lookup + create
  });

  it("throws when the owner cannot be resolved", async () => {
    const gql = vi.fn().mockResolvedValueOnce({ repositoryOwner: null });
    await expect(ensureGithubProject(gql as unknown as Gql, {
      activeProjectId: "", ownerLogin: "ghost", title: "T",
    })).rejects.toThrow(/could not resolve owner/);
  });

  it("throws when creation returns nothing", async () => {
    const gql = vi.fn()
      .mockResolvedValueOnce({ repositoryOwner: { id: "OWNER", projectsV2: { nodes: [] } } })
      .mockResolvedValueOnce({ createProjectV2: { projectV2: null } });
    await expect(ensureGithubProject(gql as unknown as Gql, {
      activeProjectId: "", ownerLogin: "o", title: "T",
    })).rejects.toThrow(/project not created/);
  });
});

describe("canLaunchTriage / triageLockReason (#444 triage gate)", () => {
  const ok = { published: true, hasRepos: true, hasFleet: true, busy: false };
  it("allows launch only when published + repos + fleet + not busy", () => {
    expect(canLaunchTriage(ok)).toBe(true);
    expect(triageLockReason(ok)).toBeNull();
  });
  it("locks until the project is published", () => {
    expect(canLaunchTriage({ ...ok, published: false })).toBe(false);
    expect(triageLockReason({ ...ok, published: false })).toMatch(/Publish/);
  });
  it("locks without repos / without a fleet / while busy, with a reason each", () => {
    expect(triageLockReason({ ...ok, hasRepos: false })).toMatch(/repository/i);
    expect(triageLockReason({ ...ok, hasFleet: false })).toMatch(/fleet/i);
    expect(triageLockReason({ ...ok, busy: true })).toBe("starting…");
    expect(canLaunchTriage({ ...ok, busy: true })).toBe(false);
  });
  it("busy takes precedence in the reason", () => {
    expect(triageLockReason({ published: false, hasRepos: false, hasFleet: false, busy: true })).toBe("starting…");
  });
});
