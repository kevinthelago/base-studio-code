import { describe, it, expect } from "vitest";
import { resolveStartupPromptDoc, repoPromptKey, type StartupPromptAssignments } from "../lib/startupPrompt";

const base = (): StartupPromptAssignments => ({
  defaultStartupPromptDoc: null,
  projectStartupPromptDoc: {},
  repoStartupPromptDoc: {},
});

describe("resolveStartupPromptDoc", () => {
  it("returns null when nothing is assigned (caller uses the built-in prompt)", () => {
    expect(resolveStartupPromptDoc(base(), "P1", "acme/api")).toBeNull();
  });

  it("uses the global default when no project/repo override", () => {
    const a = { ...base(), defaultStartupPromptDoc: "user/kickoff.md" };
    expect(resolveStartupPromptDoc(a, "P1", "acme/api")).toBe("user/kickoff.md");
  });

  it("prefers a project override over the global default", () => {
    const a = {
      ...base(),
      defaultStartupPromptDoc: "user/kickoff.md",
      projectStartupPromptDoc: { P1: "user/p1-start.md" },
    };
    expect(resolveStartupPromptDoc(a, "P1", "acme/api")).toBe("user/p1-start.md");
    // A different project still falls back to the global default.
    expect(resolveStartupPromptDoc(a, "P2", "acme/api")).toBe("user/kickoff.md");
  });

  it("prefers a per-repo override over the project override and default", () => {
    const a = {
      defaultStartupPromptDoc: "user/kickoff.md",
      projectStartupPromptDoc: { P1: "user/p1-start.md" },
      repoStartupPromptDoc: { [repoPromptKey("P1", "acme/web")]: "user/web-start.md" },
    };
    expect(resolveStartupPromptDoc(a, "P1", "acme/web")).toBe("user/web-start.md");
    // Sibling repo in the same project falls back to the project override.
    expect(resolveStartupPromptDoc(a, "P1", "acme/api")).toBe("user/p1-start.md");
  });

  it("treats null at a level as 'inherit' and falls through", () => {
    const a = {
      defaultStartupPromptDoc: "user/kickoff.md",
      projectStartupPromptDoc: { P1: null },
      repoStartupPromptDoc: { [repoPromptKey("P1", "acme/api")]: null },
    };
    expect(resolveStartupPromptDoc(a, "P1", "acme/api")).toBe("user/kickoff.md");
  });

  it("scopes per-repo overrides to their project", () => {
    const a = {
      ...base(),
      repoStartupPromptDoc: { [repoPromptKey("P1", "acme/api")]: "user/a.md" },
    };
    expect(resolveStartupPromptDoc(a, "P1", "acme/api")).toBe("user/a.md");
    // Same repo, different project — not affected.
    expect(resolveStartupPromptDoc(a, "P2", "acme/api")).toBeNull();
  });
});
