import { describe, it, expect } from "vitest";
import { sanitizeProjectKey, repoShortName, projectRepoCwd, isKnownPublishedKey } from "../lib/projectPaths";

describe("sanitizeProjectKey", () => {
  it("replaces spaces and slashes with underscores", () => {
    expect(sanitizeProjectKey("World of Tanks Strategy")).toBe("World_of_Tanks_Strategy");
    expect(sanitizeProjectKey("acme/payments v2")).toBe("acme_payments_v2");
  });

  it("keeps ASCII alphanumerics and dashes", () => {
    expect(sanitizeProjectKey("my-project-123")).toBe("my-project-123");
  });

  it("replaces other punctuation and unicode letters with underscores", () => {
    expect(sanitizeProjectKey("café.dot!")).toBe("caf__dot_");
  });

  it("caps the result at 80 characters", () => {
    const long = "a".repeat(120);
    expect(sanitizeProjectKey(long)).toHaveLength(80);
  });
});

describe("repoShortName", () => {
  it("returns the part after the last slash", () => {
    expect(repoShortName("owner/name")).toBe("name");
  });

  it("handles deeper paths by taking the last segment", () => {
    expect(repoShortName("org/group/repo")).toBe("repo");
  });

  it("returns the input unchanged when there is no slash", () => {
    expect(repoShortName("standalone")).toBe("standalone");
  });
});

describe("projectRepoCwd", () => {
  it("builds <base>/projects/<key>/<repo> with a posix base", () => {
    expect(projectRepoCwd("/home/me/.base-studio-code", "WoToS", "acme/wotos-ui")).toBe(
      "/home/me/.base-studio-code/projects/WoToS/wotos-ui",
    );
  });

  it("uses backslashes for a Windows base", () => {
    expect(
      projectRepoCwd("C:\\Users\\me\\.base-studio-code", "My Project", "acme/api"),
    ).toBe("C:\\Users\\me\\.base-studio-code\\projects\\My_Project\\api");
  });

  it("sanitizes the project name into the path", () => {
    expect(projectRepoCwd("/base", "a b/c", "o/r")).toBe("/base/projects/a_b_c/r");
  });

  it("returns an empty string for an empty base dir", () => {
    expect(projectRepoCwd("", "p", "o/r")).toBe("");
  });
});


describe("isKnownPublishedKey (#380 — guard the draft clean-start delete)", () => {
  const alias = {
    "PVT_kwHOA_BZbml": "github-pretty-readme",
    "PVT_kwHOA_BYsJC": "studio-code",
  };
  it("is true when a node id is aliased to the draft key", () => {
    expect(isKnownPublishedKey("github-pretty-readme", alias)).toBe(true);
    expect(isKnownPublishedKey("studio-code", alias)).toBe(true);
  });
  it("is false for a name no node id maps to (a genuine unpublished draft)", () => {
    expect(isKnownPublishedKey("brand-new-idea", alias)).toBe(false);
  });
  it("is false against an empty alias map", () => {
    expect(isKnownPublishedKey("github-pretty-readme", {})).toBe(false);
  });
  it("matches the published NAME, not a node id key", () => {
    // a node id is a KEY, never a value — so passing one must not falsely match
    expect(isKnownPublishedKey("PVT_kwHOA_BZbml", alias)).toBe(false);
  });
});
