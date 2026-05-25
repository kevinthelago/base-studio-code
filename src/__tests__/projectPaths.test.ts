import { describe, it, expect } from "vitest";
import { sanitizeProjectKey, repoShortName, projectRepoCwd } from "../lib/projectPaths";

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
