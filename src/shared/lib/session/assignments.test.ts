import { describe, it, expect } from "vitest";
import {
  emptyAssignments,
  emptyRefContextLevel,
  scopeKey,
  resolveStartupPrompt,
  resolveReferenceContext,
  resolveAssignments,
  composeReferenceContext,
  isDiscoveryContextDoc,
  REFERENCE_CONTEXT_HEADING,
  type DocAssignments,
} from "./assignments";

const P1 = "proj-one";
const WEB = "acme/web";
const API = "acme/api";
const S1 = "pane-1";

describe("scopeKey", () => {
  it("scopes a repo to its project so the same repo never collides across projects", () => {
    expect(scopeKey(P1, WEB)).toBe("proj-one::acme/web");
    expect(scopeKey("proj-two", WEB)).not.toBe(scopeKey(P1, WEB));
  });
});

describe("isDiscoveryContextDoc", () => {
  it("flags the planner's discovery/context plan-section files (#1807)", () => {
    expect(isDiscoveryContextDoc("projects/p1/context/goal.md")).toBe(true);
    expect(isDiscoveryContextDoc("projects/p1/discovery/scope.md")).toBe(true);
    expect(isDiscoveryContextDoc("context/goal.md")).toBe(true);
    expect(isDiscoveryContextDoc("discovery/goal.md")).toBe(true);
  });

  it("leaves genuine assigned-knowledge docs alone", () => {
    expect(isDiscoveryContextDoc("documents/global.md")).toBe(false);
    expect(isDiscoveryContextDoc("documents/proj.md")).toBe(false);
    expect(isDiscoveryContextDoc("projects/p1/prompts/web-triage.md")).toBe(false);
    // a top-level/legit file whose NAME merely contains the word is not matched
    expect(isDiscoveryContextDoc("documents/context-notes.md")).toBe(false);
  });
});

describe("resolveStartupPrompt — single-doc override cascade", () => {
  it("returns null when nothing is assigned (caller uses the built-in prompt)", () => {
    expect(resolveStartupPrompt(emptyAssignments(), { projectId: P1, repo: WEB })).toBeNull();
  });

  it("uses the global default when no narrower override exists", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    expect(resolveStartupPrompt(a, { projectId: P1, repo: WEB, session: S1 })).toBe("user/kickoff.md");
  });

  it("prefers project over default, and a sibling project still inherits the default", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    a.startupPrompt.project[P1] = "user/p1.md";
    expect(resolveStartupPrompt(a, { projectId: P1 })).toBe("user/p1.md");
    expect(resolveStartupPrompt(a, { projectId: "other" })).toBe("user/kickoff.md");
  });

  it("prefers repo over project, and a sibling repo falls back to the project override", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    a.startupPrompt.project[P1] = "user/p1.md";
    a.startupPrompt.repo[scopeKey(P1, WEB)] = "user/web.md";
    expect(resolveStartupPrompt(a, { projectId: P1, repo: WEB })).toBe("user/web.md");
    expect(resolveStartupPrompt(a, { projectId: P1, repo: API })).toBe("user/p1.md");
  });

  it("prefers session over every broader level", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    a.startupPrompt.project[P1] = "user/p1.md";
    a.startupPrompt.repo[scopeKey(P1, WEB)] = "user/web.md";
    a.startupPrompt.session[S1] = "user/session.md";
    expect(resolveStartupPrompt(a, { projectId: P1, repo: WEB, session: S1 })).toBe("user/session.md");
  });

  it("treats null at a level as 'inherit' and falls through", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    a.startupPrompt.project[P1] = null;
    a.startupPrompt.repo[scopeKey(P1, API)] = null;
    expect(resolveStartupPrompt(a, { projectId: P1, repo: API })).toBe("user/kickoff.md");
  });

  it("ignores repo/session assignments when the scope omits those levels", () => {
    const a = emptyAssignments();
    a.startupPrompt.repo[scopeKey(P1, WEB)] = "user/web.md";
    a.startupPrompt.session[S1] = "user/session.md";
    // Unscoped console: only `default` is consulted.
    expect(resolveStartupPrompt(a, {})).toBeNull();
    // Project-only scope: repo + session levels are skipped.
    expect(resolveStartupPrompt(a, { projectId: P1 })).toBeNull();
  });
});

describe("resolveReferenceContext — accumulating set with overrides", () => {
  const withRef = (): DocAssignments => {
    const a = emptyAssignments();
    a.referenceContext.default = { add: ["kb/global.md"] };
    return a;
  };

  it("returns an empty set when nothing is assigned", () => {
    expect(resolveReferenceContext(emptyAssignments(), { projectId: P1, repo: WEB })).toEqual([]);
  });

  it("accumulates broadest → narrowest, preserving order", () => {
    const a = withRef();
    a.referenceContext.project[P1] = { add: ["kb/project.md"] };
    a.referenceContext.repo[scopeKey(P1, WEB)] = { add: ["kb/repo.md"] };
    a.referenceContext.session[S1] = { add: ["kb/session.md"] };
    expect(resolveReferenceContext(a, { projectId: P1, repo: WEB, session: S1 })).toEqual([
      "kb/global.md",
      "kb/project.md",
      "kb/repo.md",
      "kb/session.md",
    ]);
  });

  it("deduplicates a document added at multiple levels, keeping the broadest position", () => {
    const a = withRef();
    a.referenceContext.project[P1] = { add: ["kb/global.md", "kb/project.md"] };
    expect(resolveReferenceContext(a, { projectId: P1 })).toEqual(["kb/global.md", "kb/project.md"]);
  });

  it("removes an inherited document via `remove`", () => {
    const a = withRef();
    a.referenceContext.project[P1] = { add: ["kb/project.md"], remove: ["kb/global.md"] };
    expect(resolveReferenceContext(a, { projectId: P1 })).toEqual(["kb/project.md"]);
  });

  it("discards everything inherited when a level sets `replace`", () => {
    const a = withRef();
    a.referenceContext.project[P1] = { add: ["kb/only.md"], replace: true };
    expect(resolveReferenceContext(a, { projectId: P1, repo: WEB })).toEqual(["kb/only.md"]);
  });

  it("a narrower level can re-add a document a broader level removed", () => {
    const a = withRef();
    a.referenceContext.project[P1] = { add: [], remove: ["kb/global.md"] };
    a.referenceContext.repo[scopeKey(P1, WEB)] = { add: ["kb/global.md"] };
    expect(resolveReferenceContext(a, { projectId: P1, repo: WEB })).toEqual(["kb/global.md"]);
  });

  it("only consults the levels a scope provides", () => {
    const a = withRef();
    a.referenceContext.repo[scopeKey(P1, WEB)] = { add: ["kb/repo.md"] };
    // Project-only scope omits the repo contribution.
    expect(resolveReferenceContext(a, { projectId: P1 })).toEqual(["kb/global.md"]);
  });
});

describe("resolveAssignments — both fields in one call", () => {
  it("resolves the startup prompt and reference context together", () => {
    const a = emptyAssignments();
    a.startupPrompt.default = "user/kickoff.md";
    a.startupPrompt.project[P1] = "user/p1.md";
    a.referenceContext.default = { add: ["kb/global.md"] };
    a.referenceContext.project[P1] = { add: ["kb/p1.md"] };
    expect(resolveAssignments(a, { projectId: P1, repo: WEB })).toEqual({
      startupPrompt: "user/p1.md",
      referenceContext: ["kb/global.md", "kb/p1.md"],
    });
  });

  it("emptyRefContextLevel is the additive identity", () => {
    const a = emptyAssignments();
    a.referenceContext.default = { add: ["kb/x.md"] };
    a.referenceContext.project[P1] = emptyRefContextLevel();
    expect(resolveReferenceContext(a, { projectId: P1 })).toEqual(["kb/x.md"]);
  });
});

describe("composeReferenceContext — folding context onto a launch prompt", () => {
  it("returns the base unchanged when there is no context", () => {
    expect(composeReferenceContext("kickoff", [])).toBe("kickoff");
    expect(composeReferenceContext("kickoff", ["  ", ""])).toBe("kickoff");
  });

  it("appends a heading + the blocks under the base prompt", () => {
    const out = composeReferenceContext("kickoff", ["block A", "block B"]);
    expect(out).toContain("kickoff");
    expect(out).toContain(REFERENCE_CONTEXT_HEADING);
    expect(out).toContain("block A");
    expect(out).toContain("block B");
    // base precedes the context section
    expect(out!.indexOf("kickoff")).toBeLessThan(out!.indexOf(REFERENCE_CONTEXT_HEADING));
  });

  it("uses the context as the whole prompt when there is no base", () => {
    const out = composeReferenceContext(undefined, ["block A"]);
    expect(out).toBe(`${REFERENCE_CONTEXT_HEADING}\n\nblock A`);
  });
});
