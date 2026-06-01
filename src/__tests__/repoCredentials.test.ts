import { describe, it, expect } from "vitest";
import { repoFromGitHubPath, resolveGithubToken, tokenForRepo } from "../lib/repoCredentials";

describe("repoFromGitHubPath", () => {
  it("extracts owner/name from a repo-scoped path", () => {
    expect(repoFromGitHubPath("repos/acme/web/pulls")).toBe("acme/web");
    expect(repoFromGitHubPath("/repos/acme/web")).toBe("acme/web");
    expect(repoFromGitHubPath("repos/acme/web/issues?state=open")).toBe("acme/web");
    expect(repoFromGitHubPath("repos/acme/web/contents/a.ts")).toBe("acme/web");
  });
  it("returns null for non-repo-scoped paths", () => {
    expect(repoFromGitHubPath("user/repos")).toBeNull();
    expect(repoFromGitHubPath("users/lina/events")).toBeNull();
    expect(repoFromGitHubPath("orgs/acme/repos")).toBeNull();
    expect(repoFromGitHubPath("")).toBeNull();
  });
});

describe("resolveGithubToken", () => {
  const repoTokens = { "acme/web": "REPO_WEB", "acme/api": "REPO_API" };
  const global = "GLOBAL";

  it("uses the repo-scoped token when the path targets that repo", () => {
    expect(resolveGithubToken("repos/acme/web/pulls", repoTokens, global)).toBe("REPO_WEB");
    expect(resolveGithubToken("repos/acme/api/issues", repoTokens, global)).toBe("REPO_API");
  });
  it("falls back to the global token for unscoped repos and non-repo paths", () => {
    expect(resolveGithubToken("repos/other/x/pulls", repoTokens, global)).toBe("GLOBAL");
    expect(resolveGithubToken("user/repos", repoTokens, global)).toBe("GLOBAL");
  });
  it("matches the repo case-insensitively", () => {
    expect(resolveGithubToken("repos/Acme/Web/pulls", repoTokens, global)).toBe("REPO_WEB");
  });
  it("ignores an empty repo-scoped token (falls back to global)", () => {
    expect(resolveGithubToken("repos/acme/web/pulls", { "acme/web": "" }, global)).toBe("GLOBAL");
  });
});

describe("tokenForRepo (session axis, #158)", () => {
  const repoTokens = { "acme/web": "REPO_WEB", "acme/api": "REPO_API" };
  const global = "GLOBAL";

  it("uses the repo-scoped token for a session bound to that repo", () => {
    expect(tokenForRepo("acme/web", repoTokens, global)).toBe("REPO_WEB");
    expect(tokenForRepo("acme/api", repoTokens, global)).toBe("REPO_API");
  });
  it("matches the repo case-insensitively", () => {
    expect(tokenForRepo("Acme/Web", repoTokens, global)).toBe("REPO_WEB");
  });
  it("falls back to the global token for an un-scoped repo", () => {
    expect(tokenForRepo("other/x", repoTokens, global)).toBe("GLOBAL");
  });
  it("falls back to the global token when no repo is bound (director / ad-hoc console)", () => {
    expect(tokenForRepo(undefined, repoTokens, global)).toBe("GLOBAL");
    expect(tokenForRepo(null, repoTokens, global)).toBe("GLOBAL");
    expect(tokenForRepo("", repoTokens, global)).toBe("GLOBAL");
  });
  it("ignores an empty repo-scoped token (falls back to global)", () => {
    expect(tokenForRepo("acme/web", { "acme/web": "" }, global)).toBe("GLOBAL");
  });
});
