// The runtime projection that the `GithubRepo` interface cannot perform (#githubrepos-projected…).
import { describe, it, expect } from "vitest";
import { leanRepo, leanRepos, GITHUB_REPO_FIELDS } from "./github";

/** A repo as GitHub actually returns it — the shape whose extra 74 fields were being stored. */
const raw = {
  full_name: "owner/repo", private: false, language: "Rust", open_issues_count: 3,
  default_branch: "develop", description: "a repo", pushed_at: "2026-08-29T00:00:00Z",
  stargazers_count: 12,
  // …and the bulk that nothing reads: 61% of the real payload is these.
  archive_url: "https://api.github.com/repos/o/r/{archive_format}{/ref}",
  assignees_url: "https://api.github.com/repos/o/r/assignees{/user}",
  blobs_url: "https://api.github.com/repos/o/r/git/blobs{/sha}",
  owner: { login: "o", id: 1, avatar_url: "https://…", type: "User" },
  permissions: { admin: true, push: true, pull: true },
  topics: ["a", "b", "c"],
};

describe("leanRepo", () => {
  it("keeps exactly the declared fields", () => {
    expect(Object.keys(leanRepo(raw)).sort()).toEqual([...GITHUB_REPO_FIELDS].sort());
  });

  it("drops the url templates and nested objects that make up the bulk", () => {
    const lean = leanRepo(raw) as unknown as Record<string, unknown>;
    for (const gone of ["archive_url", "assignees_url", "blobs_url", "owner", "permissions", "topics"]) {
      expect(lean).not.toHaveProperty(gone);
    }
  });

  it("preserves every declared value verbatim", () => {
    const lean = leanRepo(raw);
    expect(lean.full_name).toBe("owner/repo");
    expect(lean.open_issues_count).toBe(3);
    expect(lean.private).toBe(false);           // false, not dropped as falsy
    expect(lean.stargazers_count).toBe(12);
  });

  it("keeps a declared field that is legitimately null", () => {
    // `language` and `description` are nullable; a projection that skipped nullish values would
    // change the SHAPE of the record, and a consumer reading `repo.language` would get undefined
    // where the type promises `string | null`.
    const lean = leanRepo({ ...raw, language: null, description: null });
    expect(lean).toHaveProperty("language", null);
    expect(lean).toHaveProperty("description", null);
  });

  it("is a real size cut, not a cosmetic one", () => {
    // The point of the whole change: this object is re-serialized on every store `set()`.
    const before = JSON.stringify(raw).length;
    const after = JSON.stringify(leanRepo(raw)).length;
    expect(after).toBeLessThan(before / 2);
  });

  it("maps a list", () => {
    expect(leanRepos([raw, raw])).toHaveLength(2);
    expect(Object.keys(leanRepos([raw])[0])).toHaveLength(GITHUB_REPO_FIELDS.length);
  });
});
