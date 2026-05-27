import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { githubRequest, isGithubAuthError, DEFAULT_MAX_AGE_SECS } from "../lib/github";
import { useAppStore } from "../store";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(null);
  useAppStore.setState({ githubToken: "ghp_test", githubConnected: true });
});

describe("isGithubAuthError", () => {
  it("detects a 401 / bad-credentials failure", () => {
    expect(isGithubAuthError("GitHub API error (401 Unauthorized): Bad credentials")).toBe(true);
    expect(isGithubAuthError(new Error("Bad credentials"))).toBe(true);
  });
  it("ignores other failures", () => {
    expect(isGithubAuthError("GitHub API error (404): Not Found")).toBe(false);
    expect(isGithubAuthError("GitHub API error (500): boom")).toBe(false);
  });
});

describe("githubRequest", () => {
  it("sends the stored token + path + cache opts and returns the body", async () => {
    mockInvoke.mockResolvedValueOnce([{ id: 1 }]);
    const out = await githubRequest<{ id: number }[]>("user/repos", { maxAgeSecs: 30, force: true });
    expect(out).toEqual([{ id: 1 }]);
    expect(mockInvoke).toHaveBeenCalledWith("github_request", {
      token: "ghp_test",
      path: "user/repos",
      maxAgeSecs: 30,
      force: true,
    });
  });

  it("applies the default memory window when no maxAgeSecs is given", async () => {
    await githubRequest("user/repos");
    expect(mockInvoke).toHaveBeenCalledWith("github_request", {
      token: "ghp_test",
      path: "user/repos",
      maxAgeSecs: DEFAULT_MAX_AGE_SECS,
      force: undefined,
    });
  });

  it("flips to disconnected on a 401 and rethrows", async () => {
    mockInvoke.mockRejectedValueOnce("GitHub API error (401 Unauthorized): Bad credentials");
    await expect(githubRequest("user")).rejects.toBeTruthy();
    expect(useAppStore.getState().githubConnected).toBe(false);
  });

  it("does not disconnect on a non-auth error", async () => {
    mockInvoke.mockRejectedValueOnce("GitHub API error (500): boom");
    await expect(githubRequest("user")).rejects.toBeTruthy();
    expect(useAppStore.getState().githubConnected).toBe(true);
  });
});
