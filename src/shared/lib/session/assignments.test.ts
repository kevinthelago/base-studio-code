import { describe, it, expect } from "vitest";
import {
  emptyAssignments,
  scopeKey,
  resolveStartupPrompt,
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
