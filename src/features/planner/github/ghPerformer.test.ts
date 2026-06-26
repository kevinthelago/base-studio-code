import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { tauriPerformer, publishViaTauri } from "./ghPerformer";
import { personalProfile } from "./capabilityMapping";
import { STRATEGY_PRESETS } from "../fleet/executionTopology";
import type { PublishInput } from "./publishAdapter";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => mockInvoke.mockClear());

describe("tauriPerformer", () => {
  it("routes POST to github_post with token/path/body and maps number+id", async () => {
    mockInvoke.mockResolvedValueOnce({ number: 7, id: 1007 });
    const res = await tauriPerformer("tok")({ method: "POST", path: "repos/o/r/issues", body: { title: "X" } });
    expect(mockInvoke).toHaveBeenCalledWith("github_post", {
      token: "tok",
      path: "repos/o/r/issues",
      body: { title: "X" },
    });
    expect(res).toEqual({ number: 7, id: 1007 });
  });

  it("routes GET to github_request", async () => {
    mockInvoke.mockResolvedValueOnce({ number: 3 });
    const res = await tauriPerformer("tok")({ method: "GET", path: "repos/o/r/milestones/3" });
    expect(mockInvoke).toHaveBeenCalledWith("github_request", { token: "tok", path: "repos/o/r/milestones/3" });
    expect(res).toEqual({ number: 3, id: undefined });
  });

  it("defaults an empty body and rejects unsupported methods", async () => {
    mockInvoke.mockResolvedValueOnce(null);
    await tauriPerformer("t")({ method: "POST", path: "p" });
    expect(mockInvoke).toHaveBeenCalledWith("github_post", { token: "t", path: "p", body: {} });
    await expect(tauriPerformer("t")({ method: "PATCH", path: "p" })).rejects.toThrow("unsupported method");
  });
});

describe("publishViaTauri", () => {
  it("builds the plan and performs the GitHub calls end to end", async () => {
    // Every POST returns an incrementing number/id so threading works.
    let n = 0;
    mockInvoke.mockImplementation(async () => {
      n += 1;
      return { number: n, id: 1000 + n };
    });
    const input: PublishInput = {
      projectTitle: "Demo",
      phases: ["Phase 1"],
      streams: ["api"],
      epics: [{ title: "Auth", childTitles: ["login"] }],
      dependencies: [],
      profile: personalProfile(),
      strategy: STRATEGY_PRESETS["fleet-stream"],
    };
    const res = await publishViaTauri(input, "owner/repo", "tok");

    // milestone, stream label, epic label, parent issue, child issue, sub_issues link
    const posts = mockInvoke.mock.calls.filter((c) => c[0] === "github_post");
    const paths = posts.map((c) => (c[1] as { path: string }).path);
    expect(paths).toContain("repos/owner/repo/milestones");
    expect(paths).toContain("repos/owner/repo/labels");
    expect(paths).toContain("repos/owner/repo/issues");
    expect(paths.some((p) => p.endsWith("/sub_issues"))).toBe(true);
    expect(res.created.epics).toBe(1);
    expect(res.created.issues).toBe(1);
  });
});
