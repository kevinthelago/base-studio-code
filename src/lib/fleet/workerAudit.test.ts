import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadDoneAudit } from "./workerAudit";

beforeEach(() => vi.clearAllMocks());

describe("loadDoneAudit (#920)", () => {
  it("returns an empty snapshot (no invokes) when there's no cwd", async () => {
    const a = await loadDoneAudit("", "me/app");
    expect(a).toEqual({ branch: "", commits: [], changedFiles: [], pr: null, transcriptPath: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("assembles branch + commits + changed files + PR + transcript", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "read_worktree_branch": return Promise.resolve("123-feature");
        case "read_worktree_commits": return Promise.resolve([{ hash: "abc1234", subject: "do it", author: "me", date: "2026-06-23" }]);
        case "read_worktree_changes": return Promise.resolve(["src/a.ts"]);
        case "claude_transcript_path": return Promise.resolve("/home/me/.claude/projects/x/s.jsonl");
        case "find_branch_pr": return Promise.resolve({ number: 42, url: "https://gh/pr/42", state: "MERGED", merged: true });
        default: return Promise.resolve(undefined);
      }
    });
    const a = await loadDoneAudit("/wt/123-feature", "me/app");
    expect(a.branch).toBe("123-feature");
    expect(a.commits[0].hash).toBe("abc1234");
    expect(a.changedFiles).toEqual(["src/a.ts"]);
    expect(a.transcriptPath).toMatch(/\.jsonl$/);
    expect(a.pr).toMatchObject({ number: 42, merged: true });
    expect(invoke).toHaveBeenCalledWith("find_branch_pr", { repo: "me/app", branch: "123-feature" });
  });

  it("skips the PR lookup when the branch can't be read", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "read_worktree_branch" ? "" : cmd === "claude_transcript_path" ? null : []));
    const a = await loadDoneAudit("/wt/x", "me/app");
    expect(a.pr).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("find_branch_pr", expect.anything());
  });

  it("degrades each failing command to an empty value (never rejects)", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("git gone"));
    const a = await loadDoneAudit("/wt/x", "me/app");
    expect(a).toEqual({ branch: "", commits: [], changedFiles: [], pr: null, transcriptPath: null });
  });
});
