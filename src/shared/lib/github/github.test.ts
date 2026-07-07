import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  githubRequest, githubGraphql, isGithubAuthError, rateLimitedUntil, rateLimitNote,
  DEFAULT_MAX_AGE_SECS,
} from "./github";
import { useAppStore } from "@/store";

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

describe("rateLimitedUntil / rateLimitNote (#2448)", () => {
  it("parses the backend's typed rate-limit error into an epoch-ms reset time", () => {
    // The exact string src-tauri/src/github/api.rs `rate_limited_error` produces.
    expect(rateLimitedUntil("github rate-limited until 1700000123")).toBe(1_700_000_123_000);
    expect(rateLimitedUntil(new Error("github rate-limited until 42"))).toBe(42_000);
  });

  it("returns null for every other failure", () => {
    expect(rateLimitedUntil("GitHub API error (403 Forbidden): Resource not accessible")).toBeNull();
    expect(rateLimitedUntil("GitHub API error (401 Unauthorized): Bad credentials")).toBeNull();
    expect(rateLimitedUntil(null)).toBeNull();
  });

  it("rateLimitNote renders the quiet wording only for the typed error", () => {
    expect(rateLimitNote("github rate-limited until 1700000123")).toContain("GitHub rate limit reached");
    expect(rateLimitNote("GitHub API error (500): boom")).toBeNull();
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

describe("githubGraphql", () => {
  it("sends token/query/variables + the default window, returns the data", async () => {
    mockInvoke.mockResolvedValueOnce({ viewer: { login: "x" } });
    const out = await githubGraphql<{ viewer: { login: string } }>("query{}", { id: "p1" });
    expect(out).toEqual({ viewer: { login: "x" } });
    expect(mockInvoke).toHaveBeenCalledWith("github_graphql", {
      token: "ghp_test",
      query: "query{}",
      variables: { id: "p1" },
      maxAgeSecs: DEFAULT_MAX_AGE_SECS,
      force: undefined,
    });
  });

  it("flips to disconnected on a 401", async () => {
    mockInvoke.mockRejectedValueOnce("GitHub API error (401 Unauthorized): Bad credentials");
    await expect(githubGraphql("query{}", null)).rejects.toBeTruthy();
    expect(useAppStore.getState().githubConnected).toBe(false);
  });
});
