import { describe, it, expect } from "vitest";
import {
  personalProfile,
  orgProfile,
  detectProfile,
  mapConcept,
  summarizeMapping,
  ladderFor,
} from "./capabilityMapping";

describe("profiles", () => {
  it("personal has sub-issues but not issue types", () => {
    const p = personalProfile();
    expect(p.subIssues).toBe(true);
    expect(p.issueTypes).toBe(false);
  });

  it("detectProfile never grants issue types to a user account", () => {
    expect(detectProfile({ accountType: "user", issueTypes: true }).issueTypes).toBe(false);
    expect(detectProfile({ accountType: "org", issueTypes: true }).issueTypes).toBe(true);
  });
});

describe("mapConcept — highest supported rung", () => {
  const personal = personalProfile();
  const org = orgProfile();

  it("epic degrades from native type to parent+sub-issues+label", () => {
    expect(mapConcept("epic", org).id).toBe("issue-type+sub-issues");
    expect(mapConcept("epic", personal).id).toBe("parent+sub-issues+label");
  });

  it("issue-type falls back to a label without org types", () => {
    expect(mapConcept("issue-type", org).id).toBe("native-type");
    expect(mapConcept("issue-type", personal).id).toBe("label");
  });

  it("hierarchy uses sub-issues on personal", () => {
    expect(mapConcept("hierarchy", personal).id).toBe("sub-issues");
  });

  it("dependency: native -> project-field -> body-text", () => {
    expect(mapConcept("dependency", org).id).toBe("native-relationship");
    expect(mapConcept("dependency", personal).id).toBe("project-field");
    expect(mapConcept("dependency", personalProfile({ projects: false })).id).toBe("body-text");
  });

  it("phase uses iteration when Projects exist, else milestone", () => {
    expect(mapConcept("phase", personal).id).toBe("iteration");
    expect(mapConcept("phase", personalProfile({ projects: false })).id).toBe("milestone");
  });

  it("always returns the fallback rung for the poorest profile", () => {
    const bare = detectProfile({ accountType: "user", subIssues: false, projects: false });
    expect(mapConcept("epic", bare).id).toBe("parent+task-list");
    expect(mapConcept("hierarchy", bare).id).toBe("task-lists");
    expect(mapConcept("stream", bare).id).toBe("label");
  });
});

describe("summarizeMapping / ladderFor", () => {
  it("summarizes the whole mapping for a profile", () => {
    expect(summarizeMapping(personalProfile())).toEqual({
      epic: "parent+sub-issues+label",
      "issue-type": "label",
      hierarchy: "sub-issues",
      dependency: "project-field",
      phase: "iteration",
      stream: "label+epic",
    });
  });

  it("exposes the ladder richest-first", () => {
    expect(ladderFor("epic").map((r) => r.id)).toEqual([
      "issue-type+sub-issues",
      "parent+sub-issues+label",
      "parent+task-list",
    ]);
  });
});
