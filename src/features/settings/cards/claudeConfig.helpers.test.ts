import { describe, it, expect } from "vitest";
import { deriveAllRepos } from "./claudeConfig.helpers";

describe("deriveAllRepos", () => {
  it("returns one entry per unique repo full_name, first-seen wins", () => {
    const repos = deriveAllRepos(
      {
        projA: ["octo/one", "octo/two"],
        projB: ["octo/two", "octo/three"], // octo/two is a dup — projA seen first
      },
      "/base",
      {},
    );
    expect(repos.map((r) => r.full_name)).toEqual(["octo/one", "octo/two", "octo/three"]);
    // Each entry carries a resolved local path string.
    for (const r of repos) {
      expect(typeof r.local_path).toBe("string");
      expect(r.local_path.length).toBeGreaterThan(0);
    }
  });

  it("returns an empty list when there are no cloned repos", () => {
    expect(deriveAllRepos({}, "/base", {})).toEqual([]);
  });
});
