import { describe, it, expect } from "vitest";
import {
  ROLE_DEFAULTS,
  roleCapability,
  classifyCommand,
  checkCommand,
  matchGlob,
  canWritePath,
  roleDeniedCommands,
} from "../lib/sessionRoles";

describe("classifyCommand", () => {
  it("detects git reads vs writes", () => {
    expect(classifyCommand("git push origin main")).toEqual({ tool: "git", mutating: true });
    expect(classifyCommand("git commit -m x")).toMatchObject({ mutating: true });
    expect(classifyCommand("git status")).toEqual({ tool: "git", mutating: false });
    expect(classifyCommand("git log --oneline")).toMatchObject({ mutating: false });
  });

  it("detects gh reads vs writes, incl. gh api method", () => {
    expect(classifyCommand("gh issue create --title x")).toEqual({ tool: "gh", mutating: true });
    expect(classifyCommand("gh pr merge 5")).toMatchObject({ mutating: true });
    expect(classifyCommand("gh issue list")).toMatchObject({ mutating: false });
    expect(classifyCommand("gh api --method POST repos/o/r/issues")).toMatchObject({ mutating: true });
    expect(classifyCommand("gh api repos/o/r/issues")).toMatchObject({ mutating: false });
  });

  it("treats other tools as non-mutating (gated elsewhere)", () => {
    expect(classifyCommand("npm test")).toEqual({ tool: "npm", mutating: false });
  });
});

describe("checkCommand", () => {
  const planner = ROLE_DEFAULTS.planner;
  const director = ROLE_DEFAULTS.director;
  const worker = ROLE_DEFAULTS.worker;
  const triage = ROLE_DEFAULTS.triage;

  it("planner: reads allowed, all git/gh mutations denied", () => {
    expect(checkCommand(planner, "git status").allowed).toBe(true);
    expect(checkCommand(planner, "gh issue list").allowed).toBe(true);
    expect(checkCommand(planner, "git push").allowed).toBe(false);
    expect(checkCommand(planner, "gh issue create").allowed).toBe(false);
    expect(checkCommand(planner, "git push").reason).toContain("planner");
  });

  it("director: gh + git writes allowed", () => {
    expect(checkCommand(director, "gh pr merge 5").allowed).toBe(true);
    expect(checkCommand(director, "git push").allowed).toBe(true);
  });

  it("worker: git writes allowed, gh writes denied (read only)", () => {
    expect(checkCommand(worker, "git commit -m x").allowed).toBe(true);
    expect(checkCommand(worker, "gh issue create").allowed).toBe(false);
  });

  it("triage: no git access at all", () => {
    expect(checkCommand(triage, "git status").allowed).toBe(false);
    expect(checkCommand(triage, "gh issue comment 1 -b hi").allowed).toBe(true);
  });

  it("non-git/gh tools pass", () => {
    expect(checkCommand(planner, "npm test").allowed).toBe(true);
  });
});

describe("matchGlob / canWritePath", () => {
  it("matches path globs", () => {
    expect(matchGlob("src/api/**", "src/api/foo.ts")).toBe(true);
    expect(matchGlob("src/api/**", "src/web/foo.ts")).toBe(false);
    expect(matchGlob("*.ts", "foo.ts")).toBe(true);
    expect(matchGlob("*.ts", "a/foo.ts")).toBe(false);
    expect(matchGlob("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
  });

  it("a worker can only write inside its assigned globs", () => {
    const worker = roleCapability("worker", { writeGlobs: ["src/api/**"] });
    expect(canWritePath(worker, "src/api/route.ts")).toBe(true);
    expect(canWritePath(worker, "src/web/page.ts")).toBe(false);
  });

  it("the planner can write no code; a worker with no boundary writes nothing", () => {
    expect(canWritePath(roleCapability("planner"), "anything.ts")).toBe(false);
    expect(canWritePath(roleCapability("worker"), "src/x.ts")).toBe(false);
  });
});

describe("roleDeniedCommands (launch wiring)", () => {
  it("planner denies git + gh writes, not the tools outright", () => {
    const denies = roleDeniedCommands(ROLE_DEFAULTS.planner);
    expect(denies).toContain("git push");
    expect(denies).toContain("gh issue create");
    expect(denies).toContain("gh api --method POST");
    expect(denies).not.toContain("git"); // reads stay
    expect(denies).not.toContain("gh");
  });

  it("worker denies gh writes but no git writes (git is its tier)", () => {
    const denies = roleDeniedCommands(ROLE_DEFAULTS.worker);
    expect(denies).toContain("gh pr create");
    expect(denies).not.toContain("git push");
  });

  it("director denies nothing", () => {
    expect(roleDeniedCommands(ROLE_DEFAULTS.director)).toEqual([]);
  });

  it("triage denies git outright (no access) but allows gh writes", () => {
    const denies = roleDeniedCommands(ROLE_DEFAULTS.triage);
    expect(denies).toContain("git");
    expect(denies).not.toContain("gh issue create");
  });
});
