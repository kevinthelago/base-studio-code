import { describe, it, expect } from "vitest";
import {
  ROLE_DEFAULTS,
  PLANNER_WRITE_GLOBS,
  DB_OWNED_PLAN_FILES,
  DEP_MANIFEST_FILES,
  roleCapability,
  classifyCommand,
  checkCommand,
  matchGlob,
  canWritePath,
  roleDeniedCommands,
  roleWriteRules,
  roleDeniedTools,
  bscAgentPerms,
} from "./sessionRoles";

describe("bscAgentPerms", () => {
  it("a code:none role denies the write/edit tools", () => {
    const p = bscAgentPerms(roleCapability("director")); // github:write, git:write, code:none
    expect(p.deny_tools).toEqual(["write_file", "edit_file"]);
    expect(p.write_globs).toEqual([]);
  });
  it("a worker (code:write) keeps the write tools and scopes write_globs to its lane", () => {
    const p = bscAgentPerms(roleCapability("worker", { writeGlobs: ["src/**"] }));
    expect(p.deny_tools).toEqual([]);
    expect(p.write_globs).toEqual(["src/**"]);
  });
  it("deny_bash reflects roleDeniedCommands (e.g. triage git:none denies git)", () => {
    const cap = roleCapability("triage"); // git:none
    expect(bscAgentPerms(cap).deny_bash).toEqual(roleDeniedCommands(cap));
    expect(bscAgentPerms(cap).deny_bash).toContain("git");
  });
});

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

  it("the planner can write plan files but not arbitrary code; a boundary-less worker writes nothing", () => {
    expect(canWritePath(roleCapability("planner"), "goal.md")).toBe(true);
    expect(canWritePath(roleCapability("planner"), "phases.json")).toBe(true);
    expect(canWritePath(roleCapability("planner"), "prompts/dev-kickoff.md")).toBe(true);
    expect(canWritePath(roleCapability("planner"), "src/App.tsx")).toBe(false);
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

describe("roleDeniedTools (sub-agent block, #1036)", () => {
  it("denies the Task tool for workers so they can't spawn their own sub-agents", () => {
    expect(roleDeniedTools(ROLE_DEFAULTS.worker)).toEqual(["Task"]);
  });
  it("does not deny Task for non-worker roles (director coordinates, etc.)", () => {
    for (const role of ["director", "triage", "tester", "reviewer", "conductor", "issuer", "juror", "planner"] as const) {
      expect(roleDeniedTools(ROLE_DEFAULTS[role])).toEqual([]);
    }
  });
});

describe("roleWriteRules (write-tool guard)", () => {
  const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

  it("denies every write tool for no-code roles (director/triage)", () => {
    for (const role of ["director", "triage"] as const) {
      const rules = roleWriteRules(ROLE_DEFAULTS[role]);
      expect(rules.deny).toEqual(WRITE_TOOLS);
      expect(rules.allow).toEqual([]);
    }
  });

  it("planner: auto-approves plan-file globs; denies DB-owned plan-state file forms (#509/#1070)", () => {
    const rules = roleWriteRules(ROLE_DEFAULTS.planner);
    // Every PLANNER_WRITE_GLOB is represented in the allow list (section files stay writable).
    for (const glob of PLANNER_WRITE_GLOBS) {
      expect(rules.allow).toContain(`Edit(${glob})`);
      expect(rules.allow).toContain(`Write(${glob})`);
    }
    // DB-owned artifacts (deploy/phases/issues/fleet/repos/features) are denied as files so the
    // planner uses `bsc-plan` instead — deny wins over the *.md/*.json glob allow.
    for (const f of DB_OWNED_PLAN_FILES) {
      expect(rules.deny).toContain(`Write(${f})`);
      expect(rules.deny).toContain(`Edit(${f})`);
    }
    expect(rules.deny).toContain("Write(deploy.md)");
  });

  it("does NOT deny the DB-owned plan-state file forms for non-planner roles (#1070)", () => {
    // The DB-owned deny is planner-specific — a worker writes real repo files, not plan-state artifacts.
    const workerDeny = roleWriteRules(roleCapability("worker", { writeGlobs: ["src/**"] })).deny;
    for (const f of DB_OWNED_PLAN_FILES) {
      if (DEP_MANIFEST_FILES.includes(f)) continue; // (no overlap today, but be precise)
      expect(workerDeny).not.toContain(`Write(${f})`);
    }
  });

  it("worker: locks the dependency manifests — denied even inside an owned glob (#1111)", () => {
    // Even when the worker owns package.json's directory, the manifest write is denied (deny > allow)
    // so the fleet can't each redefine deps in parallel worktrees; a new dep routes via the director.
    const worker = roleCapability("worker", { writeGlobs: ["**"] });
    const deny = roleWriteRules(worker).deny;
    for (const f of DEP_MANIFEST_FILES) {
      expect(deny).toContain(`Edit(${f})`);
      expect(deny).toContain(`Write(${f})`);
    }
    expect(deny).toContain("Write(package.json)");
    expect(deny).toContain("Write(Cargo.toml)");
  });

  it("scopes a worker to its boundary globs (one allow per tool per glob)", () => {
    const worker = roleCapability("worker", { writeGlobs: ["src/api/**", "tests/**"] });
    const rules = roleWriteRules(worker);
    // deny is the dependency-manifest lock (#1111), not boundary rules.
    expect(rules.deny).toEqual(DEP_MANIFEST_FILES.flatMap((f) => WRITE_TOOLS.map((t) => `${t}(${f})`)));
    expect(rules.allow).toContain("Edit(src/api/**)");
    expect(rules.allow).toContain("Write(tests/**)");
    expect(rules.allow).toHaveLength(WRITE_TOOLS.length * 2);
  });

  it("imposes only the manifest lock for a boundary-less worker (writes otherwise follow the default)", () => {
    const rules = roleWriteRules(ROLE_DEFAULTS.worker);
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual(DEP_MANIFEST_FILES.flatMap((f) => WRITE_TOOLS.map((t) => `${t}(${f})`)));
  });

  it("agrees with canWritePath: planner writes plan files; worker writes its globs", () => {
    // planner: code:write scoped to plan files — plan files writable, arbitrary .ts not.
    const planner = ROLE_DEFAULTS.planner;
    expect(canWritePath(planner, "goal.md")).toBe(true);
    // Context-stage discovery sections live under context/ (#807) — still planner-writable.
    expect(canWritePath(planner, "context/goal.md")).toBe(true);
    expect(canWritePath(planner, "context/_skipped.md")).toBe(true);
    expect(canWritePath(planner, "src/x.ts")).toBe(false);
    // Section-file globs auto-approve; the DB-owned plan-state file forms are denied (#1070).
    expect(roleWriteRules(planner).allow).toContain("Edit(*.md)");
    expect(roleWriteRules(planner).deny).toContain("Write(deploy.md)");

    // worker with a boundary: every allow-rule glob is exactly a canWritePath-true path.
    const worker = roleCapability("worker", { writeGlobs: ["src/api/**"] });
    expect(canWritePath(worker, "src/api/route.ts")).toBe(true);
    expect(canWritePath(worker, "src/web/page.ts")).toBe(false);
    expect(roleWriteRules(worker).allow).toContain("Edit(src/api/**)");
  });
});

describe("issuer + juror roles (#376 / #394)", () => {
  it("issuer may open GitHub issues but never writes code or git", () => {
    const issuer = ROLE_DEFAULTS.issuer;
    expect(issuer.github).toBe("write");
    expect(issuer.git).toBe("read");
    expect(issuer.code).toBe("none");
    // github:write allows gh issue create; code:none denies every write tool.
    expect(checkCommand(issuer, "gh issue create --title x").allowed).toBe(true);
    expect(roleWriteRules(issuer).deny).toContain("Write");
    expect(canWritePath(roleCapability("issuer", { writeGlobs: ["**"] }), "a.ts")).toBe(false);
  });

  it("juror is a read-only reviewer — judges, never edits or merges", () => {
    const juror = ROLE_DEFAULTS.juror;
    expect(juror.github).toBe("read");
    expect(juror.git).toBe("read");
    expect(juror.code).toBe("none");
    expect(checkCommand(juror, "git merge develop").allowed).toBe(false);
    expect(checkCommand(juror, "git log").allowed).toBe(true);
    expect(roleWriteRules(juror).deny).toEqual(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  });
});
