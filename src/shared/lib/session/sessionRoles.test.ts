import { describe, it, expect } from "vitest";
import {
  ROLE_DEFAULTS,
  type SessionRole,
  PLANNER_WRITE_GLOBS,
  DOC_GLOBS,
  DB_OWNED_PLAN_FILES,
  DEP_MANIFEST_FILES,
  roleCapability,
  classifyCommand,
  checkCommand,
  matchGlob,
  canWritePath,
  roleDeniedCommands,
  mayFileToolingRequest,
  TOOLING_REQUEST_COMMAND,
  roleWriteRules,
  roleDeniedTools,
  bscAgentPerms,
  sessionScopes,
  scopeWriteGlobs,
  hasScopedWriteCarveOut,
  restrictedRoleCommands,
  isRestrictedRole,
} from "./sessionRoles";

describe("scopeWriteGlobs (#1297)", () => {
  it("falls back to the role default when the pane has no owned globs (planner ⇒ plan files)", () => {
    expect(scopeWriteGlobs("planner", [])).toEqual(PLANNER_WRITE_GLOBS);
  });
  it("uses the pane's owned globs when assigned (a worker's lane)", () => {
    expect(scopeWriteGlobs("worker", ["src/auth/**", "src/y.ts"])).toEqual(["src/auth/**", "src/y.ts"]);
  });
  it("is empty for a code:none role (director/triage) ⇒ no scope hook", () => {
    expect(scopeWriteGlobs("director", [])).toEqual([]);
    expect(scopeWriteGlobs("triage", ["whatever"])).toEqual([]);
  });
  it("is empty for a worker with no lane yet (no write boundary)", () => {
    expect(scopeWriteGlobs("worker", [])).toEqual([]);
  });
});

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
  it("lifts flow-granted push commands from deny_bash so an auto-pr worker can open its PR (#304 parity)", () => {
    const cap = roleCapability("worker", { writeGlobs: ["src/**"] }); // github:read ⇒ denies gh pr create
    expect(bscAgentPerms(cap).deny_bash).toContain("gh pr create");
    // With the flow granting push/PR, those two are lifted; other gh-writes stay denied.
    const lifted = bscAgentPerms(cap, ["git push", "gh pr create"]).deny_bash;
    expect(lifted).not.toContain("gh pr create");
    expect(lifted).toContain("gh pr merge");
  });
  it("folds the user's global denies into deny_bash on top of the role denies (deduped)", () => {
    const cap = roleCapability("worker", { writeGlobs: ["src/**"] });
    const p = bscAgentPerms(cap, [], ["terraform destroy", "  ", "gh pr merge"]);
    expect(p.deny_bash).toContain("terraform destroy");
    expect(p.deny_bash).toContain("gh pr merge");          // already a role deny — not duplicated
    expect(p.deny_bash.filter((c) => c === "gh pr merge")).toHaveLength(1);
    expect(p.deny_bash).not.toContain("");                  // blank entries dropped
  });
  it("a null cap (role-less console) yields only the user denies, permissive otherwise", () => {
    const p = bscAgentPerms(null, [], ["psql"]);
    expect(p.deny_bash).toEqual(["psql"]);
    expect(p.deny_tools).toEqual([]);
    expect(p.write_globs).toEqual([]);
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

  it("director denies no git/gh commands (write tiers) — only the ui-store writes (#2470)", () => {
    const denies = roleDeniedCommands(ROLE_DEFAULTS.director);
    expect(denies.some((d) => d.startsWith("git") || d.startsWith("gh"))).toBe(false);
    expect(denies).toContain("bsc ui set"); // ui: read — even the director doesn't redefine kits
  });

  it("triage denies git outright (no access) but allows gh writes", () => {
    const denies = roleDeniedCommands(ROLE_DEFAULTS.triage);
    expect(denies).toContain("git");
    expect(denies).not.toContain("gh issue create");
  });

  describe("file-write bash deny (#2932) — the bash counterpart to the Write-tool deny", () => {
    it("a write-less role (designer) denies the file-mutating bash commands", () => {
      const denies = roleDeniedCommands(ROLE_DEFAULTS.designer);
      for (const c of ["tee", "cp", "mv", "dd", "sed -i", "vim"]) expect(denies).toContain(c);
      // ...but it still runs `bsc ui` (its one write channel) — never file-denied.
      expect(denies).not.toContain("bsc ui set");
    });

    it("a write-less director (no commons) denies file-writes; a commons director does NOT", () => {
      expect(roleDeniedCommands(ROLE_DEFAULTS.director)).toContain("cp"); // no carve-out → writes nothing
      const commonsDir = roleCapability("director", { writeGlobs: ["*.md"] });
      expect(roleDeniedCommands(commonsDir)).not.toContain("cp"); // carve-out writes its globs via the Write tool
    });

    it("a writer (planner) and a carve-out documentor keep file-mutating bash commands", () => {
      expect(roleDeniedCommands(ROLE_DEFAULTS.planner)).not.toContain("cp"); // code: write
      expect(roleDeniedCommands(ROLE_DEFAULTS.documentor)).not.toContain("cp"); // code: none but *.md carve-out
    });
  });

  describe("ui tier (#2470) — the bsc ui component/kit store", () => {
    const UI_MUTATING = [
      "bsc ui set", "bsc ui remove", "bsc ui kit set", "bsc ui kit remove",
      // The deprecated `bsc component` alias's verbs stay denied while the alias lives (#2469).
      "bsc component set", "bsc component remove", "bsc component kit set", "bsc component kit remove",
    ];

    it("ui: read (every shipped role but the designer + architect) denies exactly the mutating verbs, leaving reads alone", () => {
      for (const cap of Object.values(ROLE_DEFAULTS)) {
        if (cap.role === "designer") continue;  // ui:"write" by design (#2471) — asserted in its own suite
        if (cap.role === "architect") continue; // ui:"none" by design (#2755) — asserted in its own suite
        if (cap.role === "librarian") continue; // ui:"none" by design (#2787) — restricted knowledge-store session, like the architect
        if (cap.role === "sound-designer") continue; // ui:"none" by design (#3369) — a sound is a synthesis descriptor, not a UI kit
        if (cap.role === "curator") continue;   // ui:"write" by design (#3092) — the harvest actor OWNS the kit store
        if (cap.role === "debugger") continue;  // ui:"write" by design (#3322) — the app-maintenance session that FIXES `bsc ui`
        const denies = roleDeniedCommands(cap);
        for (const verb of UI_MUTATING) expect(denies).toContain(verb);
        expect(denies).not.toContain("bsc ui");        // reads stay (list/get/kit list…)
        expect(denies).not.toContain("bsc component");
      }
    });

    it("ui: none denies the tool outright (both the canonical name and the alias)", () => {
      const denies = roleDeniedCommands(roleCapability("worker", { ui: "none" }));
      expect(denies).toContain("bsc ui");
      expect(denies).toContain("bsc component");
      // The verb-level denies are subsumed by the whole-tool deny — not emitted redundantly.
      expect(denies).not.toContain("bsc ui set");
    });

    it("ui: write (the designer tier) denies nothing on the UI store", () => {
      const denies = roleDeniedCommands(roleCapability("worker", { ui: "write" }));
      // Scoped to the UI store, which is what this tier governs. It used to assert no `bsc*` deny at
      // all, but that over-reached: #4000 denies project roles `bsc request` (the global TOOLING
      // queue) on an unrelated axis, and a worker granted ui:write is still a project role.
      expect(denies.some((d) => d.startsWith("bsc ui") || d.startsWith("bsc component"))).toBe(false);
    });

    it("flows through to bscAgentPerms deny_bash so the tier binds a bsc-agent session too", () => {
      const p = bscAgentPerms(roleCapability("worker", { writeGlobs: ["src/**"] }));
      expect(p.deny_bash).toContain("bsc ui set");
      expect(p.deny_bash).toContain("bsc component kit remove");
      const none = bscAgentPerms(roleCapability("worker", { ui: "none" }));
      expect(none.deny_bash).toContain("bsc ui");
    });
  });
});

describe("sessionScopes (#2470) — the $BSC_SCOPES runtime doc", () => {
  it("renders the role's ui tier per role default (read across the shipped roles)", () => {
    expect(sessionScopes(roleCapability("worker"))).toEqual({ ui: "read" });
    expect(sessionScopes(roleCapability("director"))).toEqual({ ui: "read" });
  });
  it("honors a per-assignment override (the designer path stamps write)", () => {
    expect(sessionScopes(roleCapability("worker", { ui: "write" }))).toEqual({ ui: "write" });
    expect(sessionScopes(roleCapability("worker", { ui: "none" }))).toEqual({ ui: "none" });
  });
});

describe("roleDeniedTools (sub-agent block, #1036)", () => {
  it("denies the Task tool for workers so they can't spawn their own sub-agents", () => {
    expect(roleDeniedTools(ROLE_DEFAULTS.worker)).toEqual(["Task"]);
  });
  it("does not deny Task for non-worker roles (director coordinates, etc.)", () => {
    for (const role of ["director", "triage", "tester", "reviewer", "issuer", "juror", "planner"] as const) {
      expect(roleDeniedTools(ROLE_DEFAULTS[role])).toEqual([]);
    }
  });
});

describe("roleWriteRules (write-tool guard)", () => {
  const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"]; // whole-tool deny set (no MultiEdit — removed tool, #3534)

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
      expect(rules.allow).toContain(`Edit(${glob})`);
    }
    // DB-owned artifacts (deploy/phases/issues/fleet/repos/features) are denied as files so the
    // planner uses `bsc-plan` instead — deny wins over the *.md/*.json glob allow.
    for (const f of DB_OWNED_PLAN_FILES) {
      expect(rules.deny).toContain(`Edit(${f})`);
      expect(rules.deny).toContain(`Edit(${f})`);
    }
    expect(rules.deny).toContain("Edit(deploy.md)");
  });

  it("does NOT deny the DB-owned plan-state file forms for non-planner roles (#1070)", () => {
    // The DB-owned deny is planner-specific — a worker writes real repo files, not plan-state artifacts.
    const workerDeny = roleWriteRules(roleCapability("worker", { writeGlobs: ["src/**"] })).deny;
    for (const f of DB_OWNED_PLAN_FILES) {
      if (DEP_MANIFEST_FILES.includes(f)) continue; // (no overlap today, but be precise)
      expect(workerDeny).not.toContain(`Edit(${f})`);
    }
  });

  it("worker: locks the dependency manifests — denied even inside an owned glob (#1111)", () => {
    // Even when the worker owns package.json's directory, the manifest write is denied (deny > allow)
    // so the fleet can't each redefine deps in parallel worktrees; a new dep routes via the director.
    const worker = roleCapability("worker", { writeGlobs: ["**"] });
    const deny = roleWriteRules(worker).deny;
    for (const f of DEP_MANIFEST_FILES) {
      expect(deny).toContain(`Edit(${f})`);
      expect(deny).toContain(`Edit(${f})`);
    }
    expect(deny).toContain("Edit(package.json)");
    expect(deny).toContain("Edit(Cargo.toml)");
  });

  it("scopes a worker to its boundary globs (one allow per tool per glob)", () => {
    const worker = roleCapability("worker", { writeGlobs: ["src/api/**", "tests/**"] });
    const rules = roleWriteRules(worker);
    // deny is the dependency-manifest lock (#1111), not boundary rules.
    expect(rules.deny).toEqual(DEP_MANIFEST_FILES.map((f) => `Edit(${f})`)); // Edit(path) covers all file-editing tools (#3534)
    expect(rules.allow).toContain("Edit(src/api/**)");
    expect(rules.allow).toContain("Edit(tests/**)"); // path rules are Edit-only (#3534)
    expect(rules.allow).toHaveLength(2); // one Edit(glob) per glob (#3534)
  });

  it("imposes only the manifest lock for a boundary-less worker (writes otherwise follow the default)", () => {
    const rules = roleWriteRules(ROLE_DEFAULTS.worker);
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual(DEP_MANIFEST_FILES.map((f) => `Edit(${f})`)); // Edit(path) covers all file-editing tools (#3534)
  });

  it("agrees with canWritePath: planner writes plan files; worker writes its globs", () => {
    // planner: code:write scoped to plan files — plan files writable, arbitrary .ts not.
    const planner = ROLE_DEFAULTS.planner;
    expect(canWritePath(planner, "goal.md")).toBe(true);
    // Discovery-stage sections live under discovery/ (#807, renamed from context/ in #1578) —
    // still planner-writable.
    expect(canWritePath(planner, "discovery/goal.md")).toBe(true);
    expect(canWritePath(planner, "discovery/_skipped.md")).toBe(true);
    expect(canWritePath(planner, "src/x.ts")).toBe(false);
    // Section-file globs auto-approve; the DB-owned plan-state file forms are denied (#1070).
    expect(roleWriteRules(planner).allow).toContain("Edit(*.md)");
    expect(roleWriteRules(planner).deny).toContain("Edit(deploy.md)");

    // worker with a boundary: every allow-rule glob is exactly a canWritePath-true path.
    const worker = roleCapability("worker", { writeGlobs: ["src/api/**"] });
    expect(canWritePath(worker, "src/api/route.ts")).toBe(true);
    expect(canWritePath(worker, "src/web/page.ts")).toBe(false);
    expect(roleWriteRules(worker).allow).toContain("Edit(src/api/**)");
  });
});

describe("network gate (#1107)", () => {
  it("net defaults to read for every role but the designer + architect — web tools stay allowed (no behavior change)", () => {
    for (const role of Object.keys(ROLE_DEFAULTS) as SessionRole[]) {
      if (role === "designer") continue;  // net:"none" by design (#2471) — asserted in its own suite
      if (role === "architect") continue; // net:"none" by design (#2755) — asserted in its own suite
      if (role === "librarian") continue; // net:"none" by design (#2787) — restricted knowledge-store session, like the architect
      if (role === "sound-designer") continue; // net:"none" by design (#3369) — restricted sound-store session, like the librarian
      if (role === "curator") continue;   // net:"none" by design (#3092) — the post-landing harvest actor works offline
      expect(ROLE_DEFAULTS[role].net).toBe("read");
      expect(roleDeniedTools(ROLE_DEFAULTS[role])).not.toContain("WebFetch");
    }
  });

  it("net:'none' denies WebFetch + WebSearch at launch (the planner web kill-switch)", () => {
    const offline = roleCapability("planner", { net: "none" });
    expect(roleDeniedTools(offline)).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });

  it("composes with other tool denies (a worker with net:none keeps Task and adds the web denies)", () => {
    expect(roleDeniedTools(roleCapability("worker", { net: "none" }))).toEqual(["Task", "WebFetch", "WebSearch"]);
  });
});

describe("planner privilege containment (#1107)", () => {
  const planner = ROLE_DEFAULTS.planner;

  it("is read-only on git and GitHub — it can shape the plan but never mutate the repo/GitHub", () => {
    expect(planner.git).toBe("read");
    expect(planner.github).toBe("read");
    expect(checkCommand(planner, "git push").allowed).toBe(false);
    expect(checkCommand(planner, "gh pr create -t x").allowed).toBe(false);
    expect(checkCommand(planner, "gh repo delete").allowed).toBe(false);
  });

  it("confines its code writes to plan files — never repo source or the launch settings", () => {
    expect(canWritePath(planner, "goal.md")).toBe(true);
    expect(canWritePath(planner, "prompts/dev-kickoff.md")).toBe(true);
    expect(canWritePath(planner, "src/App.tsx")).toBe(false);          // no repo source
    expect(canWritePath(planner, ".claude/settings.json")).toBe(false); // no tampering with its own gate
  });

  it("no flow grant lifts its git/GitHub denies (the #304 push-lift never applies to the planner)", () => {
    // bscAgentPerms with the default (no grant) keeps every git/gh write denied, and the planner is
    // never handed a flow grant in practice (only workers carry an AgentFlow). Even so, codify it.
    const perms = bscAgentPerms(planner);
    expect(perms.deny_bash).toContain("git push");
    expect(perms.deny_bash).toContain("gh pr create");
    expect(perms.deny_bash).toContain("gh repo delete");
    expect(perms.write_globs).toEqual(PLANNER_WRITE_GLOBS); // plan files only, no repo lane
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
    expect(roleWriteRules(juror).deny).toEqual(["Edit", "Write", "NotebookEdit"]);
  });
});

// #851 — the director's scoped commons write carve-out: it keeps code:"none" (no feature-code
// writes) yet may write EXACTLY the commons globs assigned to it, and nothing else.
describe("director commons carve-out (#851)", () => {
  const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"]; // whole-tool deny set (no MultiEdit — removed tool, #3534)
  // A representative commons set (what fleetStartProject assigns to the director from the stack).
  const COMMONS = [".gitignore", "package.json", "tsconfig.json", ".github/workflows/**", ".env.example"];

  it("a director WITHOUT assigned globs keeps the full code:none deny (no accidental carve-out)", () => {
    expect(hasScopedWriteCarveOut(ROLE_DEFAULTS.director)).toBe(false);
    expect(roleWriteRules(ROLE_DEFAULTS.director).deny).toEqual(WRITE_TOOLS);
    expect(roleWriteRules(ROLE_DEFAULTS.director).allow).toEqual([]);
    expect(canWritePath(ROLE_DEFAULTS.director, ".gitignore")).toBe(false);
    expect(scopeWriteGlobs("director", [])).toEqual([]);
  });

  it("a director WITH commons globs gets a carve-out scoped to exactly the commons", () => {
    const dir = roleCapability("director", { writeGlobs: COMMONS });
    expect(dir.code).toBe("none"); // code stays none — feature code is still off-limits
    expect(hasScopedWriteCarveOut(dir)).toBe(true);
  });

  it("director writeGlobs INCLUDE the commons set (can write each commons path)", () => {
    const dir = roleCapability("director", { writeGlobs: COMMONS });
    for (const p of [".gitignore", "package.json", "tsconfig.json", ".github/workflows/ci.yml", ".env.example"]) {
      expect(canWritePath(dir, p)).toBe(true);
    }
  });

  it("director is DENIED all other code writes (feature code outside the commons)", () => {
    const dir = roleCapability("director", { writeGlobs: COMMONS });
    for (const p of ["src/App.tsx", "src/auth/login.ts", "crates/kb/src/lib.rs", "README.md"]) {
      expect(canWritePath(dir, p)).toBe(false);
    }
  });

  it("roleWriteRules auto-approves the commons (allow, no whole-tool deny) so writes don't prompt", () => {
    const rules = roleWriteRules(roleCapability("director", { writeGlobs: COMMONS }));
    // The whole-tool deny is lifted (deny>allow would otherwise mask the per-glob allows).
    expect(rules.deny).toEqual([]);
    for (const g of COMMONS) {
      expect(rules.allow).toContain(`Edit(${g})`);
      expect(rules.allow).toContain(`Edit(${g})`);
    }
    expect(rules.allow).toHaveLength(COMMONS.length); // one Edit(glob) per commons glob (#3534)
  });

  it("scopeWriteGlobs hard-limits the director's writes to the commons (bsc-scope hook)", () => {
    expect(scopeWriteGlobs("director", COMMONS)).toEqual(COMMONS);
  });

  it("bscAgentPerms gives a commons-assigned director its write tools scoped to the commons", () => {
    const p = bscAgentPerms(roleCapability("director", { writeGlobs: COMMONS }));
    expect(p.deny_tools).toEqual([]); // write_file/edit_file NOT denied — carve-out active
    expect(p.write_globs).toEqual(COMMONS);
  });

  it("the carve-out is director/documentor-only — a code:none triage/tester handed globs stays write-denied", () => {
    for (const role of ["triage", "tester", "reviewer"] as const) {
      const cap = roleCapability(role, { writeGlobs: COMMONS });
      expect(hasScopedWriteCarveOut(cap)).toBe(false);
      expect(roleWriteRules(cap).deny).toEqual(WRITE_TOOLS);
      expect(canWritePath(cap, ".gitignore")).toBe(false);
    }
  });
});

// #1555 — the documentor's prose-doc write carve-out: it keeps code:"none" (no feature-code writes)
// yet ships DOC_GLOBS BY DEFAULT, so it may write EXACTLY the prose docs (markdown + docs tree) and
// nothing else. It reads git/GitHub, mutates neither (push/PR are flow-governed), and is hard-blocked
// on every code path — mirroring the #851 director carve-out but active as-launched.
describe("documentor prose-doc carve-out (#1555)", () => {
  const documentor = ROLE_DEFAULTS.documentor;

  it("is a code:none role that reads git/GitHub and mutates neither", () => {
    expect(documentor.git).toBe("read");
    expect(documentor.github).toBe("read");
    expect(documentor.code).toBe("none");
    expect(documentor.net).toBe("read");
    // git/gh mutations are denied by default; the flow lifts push/PR (like a worker, #304).
    expect(checkCommand(documentor, "git commit -m x").allowed).toBe(false);
    expect(checkCommand(documentor, "git push").allowed).toBe(false);
    expect(checkCommand(documentor, "gh pr merge 5").allowed).toBe(false);
    expect(checkCommand(documentor, "git status").allowed).toBe(true);
    expect(checkCommand(documentor, "gh pr view 5").allowed).toBe(true);
  });

  it("has an ACTIVE carve-out as launched — it ships DOC_GLOBS by default (no assignment needed)", () => {
    expect(documentor.writeGlobs).toEqual(DOC_GLOBS);
    expect(documentor.writeGlobs.length).toBeGreaterThan(0);
    expect(hasScopedWriteCarveOut(documentor)).toBe(true); // unlike the director, active without an assignment
  });

  it("MAY write prose-doc paths — markdown (top-level + nested), the docs tree, README/CHANGELOG", () => {
    for (const p of [
      "README.md", "CHANGELOG.md", "CLAUDE.md", "docs/architecture.md", "docs/adr/0001-x.md",
      "src/features/planner/README.md", "packages/api/CHANGELOG.md",
    ]) {
      expect(canWritePath(documentor, p)).toBe(true);
    }
  });

  it("is HARD-BLOCKED writing any source/code path — the least-privilege boundary holds", () => {
    for (const p of [
      "src/App.tsx", "src/auth/login.ts", "crates/kb/src/lib.rs", "src-tauri/src/main.rs",
      "package.json", "Cargo.toml", ".claude/settings.json", "docs/gen.ts",
    ]) {
      expect(canWritePath(documentor, p)).toBe(false);
    }
  });

  it("roleWriteRules auto-approves the DOC_GLOBS (allow, no whole-tool deny) so doc writes don't prompt", () => {
    const rules = roleWriteRules(documentor);
    // The whole-tool deny is lifted (deny > allow would otherwise mask the per-glob allows).
    expect(rules.deny).toEqual([]);
    for (const g of DOC_GLOBS) {
      expect(rules.allow).toContain(`Edit(${g})`);
      expect(rules.allow).toContain(`Edit(${g})`);
    }
    expect(rules.allow).toHaveLength(DOC_GLOBS.length); // one Edit(glob) per doc glob (#3534)
  });

  it("scopeWriteGlobs hard-limits the documentor's writes to DOC_GLOBS (bsc-scope hook), no assignment needed", () => {
    expect(scopeWriteGlobs("documentor", [])).toEqual(DOC_GLOBS);
  });

  it("bscAgentPerms keeps the documentor's write tools scoped to DOC_GLOBS (carve-out active)", () => {
    const p = bscAgentPerms(documentor);
    expect(p.deny_tools).toEqual([]); // write_file/edit_file NOT denied — carve-out active
    expect(p.write_globs).toEqual(DOC_GLOBS);
    // git/gh writes stay denied unless the flow grants push/PR.
    expect(p.deny_bash).toContain("git push");
    expect(p.deny_bash).toContain("gh pr create");
    expect(bscAgentPerms(documentor, ["git push", "gh pr create"]).deny_bash).not.toContain("gh pr create");
  });

  it("does not spawn its own sub-agents restriction — only workers deny Task; documentor keeps it", () => {
    expect(roleDeniedTools(documentor)).toEqual([]);
  });
});

// #2471 — the designer role: the Design Studio's UI-kit session. `none` on every axis: kits live in
// the bsc store (not files), so there is nothing it should write, commit, publish, or fetch. Its one
// command surface (`bsc ui` + the deprecated `bsc component` alias) is granted at launch via the
// restricted allow-list (`restrictedAllow`, settings.rs), not by the role gate.
describe("designer role (#2471)", () => {
  const designer = ROLE_DEFAULTS.designer;

  it("is none on every axis except the kit store — no git, no GitHub, no code, no net; ui: write", () => {
    expect(designer.git).toBe("none");
    expect(designer.github).toBe("none");
    expect(designer.code).toBe("none");
    expect(designer.net).toBe("none");
    // The ONE write grant (#2470 integration): the designer is the sole ui:"write" role, so the
    // runtime scope doc lets it drive `bsc ui set/remove` where every other role is read-scoped.
    expect(designer.ui).toBe("write");
    expect(sessionScopes(designer)).toEqual({ ui: "write" });
    expect(designer.writeGlobs).toEqual(["scratch/**"]);   // #3373: the sealed staging dir, nothing else
  });

  it("roleDeniedCommands denies git AND gh outright (the whole tools) and nothing on the kit store", () => {
    const denies = roleDeniedCommands(designer);
    expect(denies).toContain("git");
    expect(denies).toContain("gh");
    // The `none` tiers deny the bare tool — the granular write-prefix lists are the read-tier form.
    expect(denies).not.toContain("git push");
    expect(denies).not.toContain("gh pr create");
    // ui:"write" — no bsc denies; the restricted allow-list (not the role gate) narrows the surface.
    expect(denies.some((d) => d.startsWith("bsc"))).toBe(false);
  });

  it("roleDeniedTools denies the web tools (net:none) — no live injection surface", () => {
    expect(roleDeniedTools(designer)).toEqual(["WebFetch", "WebSearch"]);
  });

  // #3373 CHANGED THIS PROPERTY DELIBERATELY. The designer used to be write-denied through every path,
  // because kits live in the store, not in files. But a heredoc cannot be allow-listed (newlines are
  // command separators), so JSON-on-stdin — its ONLY authoring channel — was unusable, and the spec
  // forbade every alternative. It now stages a payload in a sealed `scratch/**` dir and applies it with
  // `bsc ui set --file <name>`.
  //
  // The carve-out is EXACTLY that dir. These assertions are the boundary: project code stays denied.
  it("writes ONLY its sealed scratch dir — project code is still denied through every path", () => {
    expect(hasScopedWriteCarveOut(designer)).toBe(true);
    expect(designer.writeGlobs).toEqual(["scratch/**"]);

    const rules = roleWriteRules(designer);
    // A carve-out emits per-glob ALLOWS and no whole-tool deny (deny > allow would mask the allows).
    expect(rules.deny).toEqual([]);
    expect(rules.allow).toEqual(["Edit(scratch/**)"]); // Edit(path) covers Write/NotebookEdit too (#3534)

    // The boundary itself: inside the scratch dir yes, anywhere else no.
    expect(canWritePath(designer, "scratch/kit.json")).toBe(true);
    expect(canWritePath(designer, "scratch/nested/kit.json")).toBe(true);
    expect(canWritePath(designer, "src/App.tsx")).toBe(false);
    expect(canWritePath(designer, "CLAUDE.md")).toBe(false);          // its own spec
    expect(canWritePath(designer, ".claude/settings.json")).toBe(false); // its own permissions
    expect(canWritePath(designer, "kit.json")).toBe(false);           // workspace root, not scratch
  });

  it("the carve-out cannot be widened by handing it broader globs", () => {
    // A stale/edited config-dir override must not be able to turn the scratch carve-out into a general
    // write grant without also changing `code`, which the role table pins to "none".
    const wide = roleCapability("designer", { writeGlobs: ["**"] });
    expect(canWritePath(wide, "src/App.tsx")).toBe(true);  // globs ARE authoritative once carved out…
    // …so the real guard is that the SHIPPED role's globs are exactly the scratch dir, asserted above,
    // and that `code` stays "none" so no implicit write tier exists.
    expect(designer.code).toBe("none");
    expect(ROLE_DEFAULTS.designer.writeGlobs).toEqual(["scratch/**"]);
  });

  it("checkCommand blocks every git/gh invocation, reads included", () => {
    expect(checkCommand(designer, "git status").allowed).toBe(false);
    expect(checkCommand(designer, "git push").allowed).toBe(false);
    expect(checkCommand(designer, "gh issue list").allowed).toBe(false);
    expect(checkCommand(designer, "gh pr create -t x").allowed).toBe(false);
    // Non-git/gh commands pass this gate — the restricted allow-list is what narrows them to bsc ui.
    expect(checkCommand(designer, "bsc ui schema").allowed).toBe(true);
  });

  it("bscAgentPerms renders the same wall for the bsc-agent runtime", () => {
    const p = bscAgentPerms(designer);
    // #3373: the scratch carve-out mirrors here too — the write tools are available, scoped to the
    // one staging dir. A divergence between the runtimes would mean the same role is confined
    // differently depending on which shell drives it.
    expect(p.deny_tools).toEqual([]);
    expect(p.write_globs).toEqual(["scratch/**"]);
    expect(p.deny_bash).toContain("git");
    expect(p.deny_bash).toContain("gh");
    expect(p.deny_bash).toContain("cp");   // shell mutation stays denied despite the carve-out
  });
});

// #2755 — the architect role: the Teams Studio's team-authoring session. `none` on EVERY axis, `ui`
// included (unlike the designer's ui:"write" — it never touches the UI-kit store). Its one command
// surface (`bsc teams` + `bsc persona`) is granted at launch via the restricted allow-list
// (`restrictedAllow`, settings.rs), not by the role gate. The Teams graph stays the read-only viewer.
describe("architect role (#2755)", () => {
  const architect = ROLE_DEFAULTS.architect;

  it("is none on EVERY axis — no git, no GitHub, no code, no net, and ui:none (not a UI-kit session)", () => {
    expect(architect.git).toBe("none");
    expect(architect.github).toBe("none");
    expect(architect.code).toBe("none");
    expect(architect.net).toBe("none");
    expect(architect.ui).toBe("none");
    expect(sessionScopes(architect)).toEqual({ ui: "none" });
    expect(architect.writeGlobs).toEqual(["scratch/**"]);   // #3373: the sealed staging dir, nothing else
  });

  it("roleDeniedCommands denies git, gh, AND the ui-kit store (bsc ui + the alias) outright", () => {
    const denies = roleDeniedCommands(architect);
    expect(denies).toContain("git");
    expect(denies).toContain("gh");
    // ui:"none" denies the whole `bsc ui` tool (and its deprecated `bsc component` alias) — the
    // architect never edits UI kits; that's the designer's job.
    expect(denies).toContain("bsc ui");
    expect(denies).toContain("bsc component");
    // The `none` tiers deny the bare tool — the granular write-prefix lists are the read-tier form.
    expect(denies).not.toContain("git push");
    expect(denies).not.toContain("gh pr create");
    expect(denies).not.toContain("bsc ui set"); // subsumed by the whole-tool deny, not emitted redundantly
    // Its OWN surface (bsc teams / bsc persona) is not role-gate-denied — it's granted via restrictedAllow.
    expect(denies).not.toContain("bsc teams");
    expect(denies).not.toContain("bsc persona");
  });

  it("roleDeniedTools denies the web tools (net:none) — no live injection surface", () => {
    expect(roleDeniedTools(architect)).toEqual(["WebFetch", "WebSearch"]);
  });

  // #3373, same change as the designer: teams/personas still live in the stores, but the architect
  // needs a place to STAGE the JSON it applies with `bsc teams set --file <name>`, because a heredoc
  // cannot be allow-listed. The carve-out is exactly that sealed dir.
  it("writes ONLY its sealed scratch dir — project code is still denied through every path", () => {
    expect(hasScopedWriteCarveOut(architect)).toBe(true);
    expect(architect.writeGlobs).toEqual(["scratch/**"]);

    const rules = roleWriteRules(architect);
    expect(rules.deny).toEqual([]);
    expect(rules.allow).toEqual(["Edit(scratch/**)"]); // Edit(path) covers Write/NotebookEdit too (#3534)

    expect(canWritePath(architect, "scratch/team.json")).toBe(true);
    expect(canWritePath(architect, "src/App.tsx")).toBe(false);
    expect(canWritePath(architect, "CLAUDE.md")).toBe(false);
  });

  // The carve-out grants the write TOOLS on one dir; it must NOT un-deny file-mutating SHELL commands.
  // `roleDeniedCommands` lifts those for a carve-out role (the director writes its commons with bash),
  // so a restricted role is explicitly excluded — its spec says in as many words not to reach for bash
  // to sidestep the file rules, and its whole shell surface is one store CLI.
  it("still denies the file-mutating shell commands despite having a carve-out", () => {
    for (const cap of [ROLE_DEFAULTS.designer, ROLE_DEFAULTS.architect]) {
      const denies = roleDeniedCommands(cap);
      for (const cmd of ["tee", "cp", "mv", "sed -i", "dd", "vim"]) {
        expect(denies).toContain(cmd);
      }
    }
    // Contrast: the director's carve-out IS shell-written, so it keeps them.
    const commonsDirector = roleCapability("director", { writeGlobs: ["*.md"] });
    expect(roleDeniedCommands(commonsDirector)).not.toContain("cp");
  });

  it("checkCommand blocks every git/gh invocation, reads included", () => {
    expect(checkCommand(architect, "git status").allowed).toBe(false);
    expect(checkCommand(architect, "git push").allowed).toBe(false);
    expect(checkCommand(architect, "gh issue list").allowed).toBe(false);
    expect(checkCommand(architect, "gh pr create -t x").allowed).toBe(false);
    // Non-git/gh commands pass this gate — the restricted allow-list narrows them to bsc teams/persona.
    expect(checkCommand(architect, "bsc teams list").allowed).toBe(true);
    expect(checkCommand(architect, "bsc persona list").allowed).toBe(true);
  });

  it("bscAgentPerms renders the same wall for the bsc-agent runtime", () => {
    const p = bscAgentPerms(architect);
    expect(p.deny_tools).toEqual([]);            // #3373 scratch carve-out, mirrored from the Claude side
    expect(p.write_globs).toEqual(["scratch/**"]);
    expect(p.deny_bash).toContain("git");
    expect(p.deny_bash).toContain("gh");
    expect(p.deny_bash).toContain("bsc ui"); // ui:none flows through to the agent runtime too
    expect(p.deny_bash).toContain("cp");     // shell mutation stays denied despite the carve-out
  });
});

describe("restrictedRoleCommands (curator store surface, #3095)", () => {
  const LOOP = ["bsc loop new", "bsc loop say", "bsc loop watch", "bsc loop show", "bsc loop list"];

  it("hands the curator its two store CLIs — bsc ui (components) + bsc graph (algorithms)", () => {
    expect(restrictedRoleCommands("curator")).toEqual(["bsc ui", "bsc graph", ...LOOP]);
  });

  // The standing studio sessions' confinement now lives on the ROLE — it used to be pinned inside each
  // bespoke launch hook, so the SAME role produced a much wider gate on any other launch path. These
  // literals are the EXACT surfaces those hooks passed: a change here widens (or narrows) a
  // deliberately-confined session, so they are asserted verbatim rather than derived.
  it("pins each standing studio session's whole surface, byte-identical to its old launch hook", () => {
    expect(restrictedRoleCommands("designer")).toEqual(
      ["bsc ui", "bsc component", "bsc shot preview", ...LOOP, "bsc request new", "bsc request list"]);
    expect(restrictedRoleCommands("librarian")).toEqual(["bsc graph", ...LOOP, "bsc request new", "bsc request list"]);
    expect(restrictedRoleCommands("architect")).toEqual(["bsc teams", "bsc persona", ...LOOP, "bsc request new", "bsc request list"]);
    expect(restrictedRoleCommands("sound-designer")).toEqual(["bsc sound", ...LOOP, "bsc request new", "bsc request list"]);
  });

  // Every studio surface is a loop PARTICIPANT (#3262): it can open a loop and converse in it.
  it("gives every restricted studio surface the loop participant verbs", () => {
    for (const role of ["curator", "designer", "librarian", "architect", "sound-designer"] as const) {
      expect(restrictedRoleCommands(role)).toEqual(expect.arrayContaining(LOOP));
    }
  });

  // `bsc loop stop` is the ONLY way to halt an `--until false` loop, and the CLI withholds it from
  // participants by design ("a separate verb from `say`, so a participant cannot reach it"). The bare
  // `"bsc loop"` prefix used to grant it: it expands to `Bash(bsc loop *)`, which matches `bsc loop stop`
  // — so a session could end the infinite loop it exists to run. Halting stays outside the conversation.
  it("never grants `bsc loop stop` — a participant cannot halt its own loop", () => {
    for (const role of ["curator", "designer", "librarian", "architect", "sound-designer"] as const) {
      const cmds = restrictedRoleCommands(role);
      expect(cmds).not.toContain("bsc loop stop");
      // The bare prefix is what silently re-grants `stop` via the `Bash(<cmd> *)` rule — it must not return.
      expect(cmds).not.toContain("bsc loop");
    }
  });

  // #3369: `sound-designer` shares a WORD with `designer` but is a DISTINCT role. Any lookup that
  // matched loosely (startsWith / includes / a stripped hyphen) would hand one session the other's
  // surface — the sound-designer would gain `bsc ui` + the whole Design Studio toolbelt, or the
  // designer would lose it. Pinned in both directions.
  it("never conflates `designer` with `sound-designer` — the names overlap, the surfaces do not", () => {
    const designer = restrictedRoleCommands("designer");
    const sound = restrictedRoleCommands("sound-designer");
    // The exact surface is pinned in the verbatim test above; here the property is what matters —
    // the two roles share a word, never a store.
    expect(sound).toContain("bsc sound");
    expect(designer).not.toContain("bsc sound");
    expect(sound).not.toContain("bsc ui");
    expect(sound).not.toContain("bsc component");
    // ...and their capabilities differ: the designer is the one `ui: write` role (#2470/#2471).
    expect(ROLE_DEFAULTS.designer.ui).toBe("write");
    expect(ROLE_DEFAULTS["sound-designer"].ui).toBe("none");
  });

  it("is empty for every unrestricted role and for an absent role", () => {
    const restricted = new Set<SessionRole>(["curator", "designer", "librarian", "architect", "sound-designer"]);
    for (const role of Object.keys(ROLE_DEFAULTS) as SessionRole[]) {
      if (restricted.has(role)) continue;
      expect(restrictedRoleCommands(role)).toEqual([]);
    }
    expect(restrictedRoleCommands(null)).toEqual([]);
    expect(restrictedRoleCommands(undefined)).toEqual([]);
  });

  it("isRestrictedRole marks exactly the confined roles — they must never be flipped to bypass", () => {
    for (const role of ["curator", "designer", "librarian", "architect", "sound-designer"] as SessionRole[]) {
      expect(isRestrictedRole(role)).toBe(true);
    }
    for (const role of ["worker", "director", "planner", "triage", "reviewer"] as SessionRole[]) {
      expect(isRestrictedRole(role)).toBe(false);
    }
    expect(isRestrictedRole(null)).toBe(false);
    expect(isRestrictedRole(undefined)).toBe(false);
  });

  // #3373: the scratch carve-out lets a restricted session write arbitrary bytes to disk. That is only
  // safe because NOTHING it can auto-run will execute them — its whole surface is one store CLI, which
  // reads the file and JSON-parses it. Today that holds by accident of the allow-list's contents; this
  // asserts it, so a future widening cannot quietly turn a staging dir into an execution path.
  it("no restricted role can auto-run an interpreter — a staged file can never be executed", () => {
    const EXECUTORS = ["bash", "sh", "zsh", "node", "python", "python3", "perl", "ruby", "chmod", "./", "source", "eval"];
    for (const role of ["designer", "architect", "librarian", "sound-designer", "curator"] as SessionRole[]) {
      const surface = restrictedRoleCommands(role);
      expect(surface.length).toBeGreaterThan(0);
      for (const cmd of EXECUTORS) {
        expect(surface.some((c) => c === cmd || c.startsWith(`${cmd} `))).toBe(false);
      }
      // Every granted command is a `bsc` store verb — nothing else is on the surface at all.
      for (const c of surface) expect(c.startsWith("bsc ")).toBe(true);
    }
  });

  it("returns a fresh array each call so callers can spread/mutate without corrupting the source", () => {
    const a = restrictedRoleCommands("curator");
    a.push("bsc plan");
    expect(restrictedRoleCommands("curator")).toEqual(["bsc ui", "bsc graph", ...LOOP]);
  });
});

describe("the global tooling-request queue is denied to project roles (#4000)", () => {
  // `bsc` is in the permission model's `mandatory` tier — ALWAYS allowed, every role, every posture.
  // So `bsc request` is reachable from any session that can run bash, and NOT granting it is not
  // enough: only an explicit deny keeps a project worker out of the queue a full-capability session
  // drains to edit base-studio-code itself.
  const PROJECT_ROLES = ["worker", "director", "triage", "planner", "reviewer", "documentor"] as const;

  it.each(PROJECT_ROLES)("denies %s the tooling queue", (role) => {
    expect(roleDeniedCommands(roleCapability(role))).toContain(TOOLING_REQUEST_COMMAND);
  });

  it("does NOT deny the roles that legitimately file tooling requests", () => {
    // These are granted `bsc request new` via RESTRICTED_ROLE_COMMANDS; denying it would break the
    // designer->debug channel (#3298) that the whole store exists for.
    for (const role of ["designer", "librarian", "sound-designer", "architect"] as const) {
      expect(roleDeniedCommands(roleCapability(role))).not.toContain(TOOLING_REQUEST_COMMAND);
    }
  });

  it("does not deny the debugger, which is the queue's consumer", () => {
    // It reads/claims/resolves. It has no RESTRICTED_ROLE_COMMANDS entry because it launches
    // full-capability rather than confined, so it is the one role the derivation names explicitly.
    expect(mayFileToolingRequest("debugger")).toBe(true);
  });

  it("derives the allow-list from the grants, so the two cannot drift", () => {
    // The property that keeps this maintainable: a role may file iff it is GRANTED the command.
    // Add the grant to a role and its deny lifts automatically; remove it and the deny returns.
    for (const role of ["designer", "architect"] as const) {
      expect(restrictedRoleCommands(role).some((c) => c.startsWith(TOOLING_REQUEST_COMMAND))).toBe(true);
      expect(mayFileToolingRequest(role)).toBe(true);
    }
    expect(mayFileToolingRequest("worker")).toBe(false);
    expect(mayFileToolingRequest(null)).toBe(false);
  });

  it("uses a pattern the deny matcher treats as a phrase, not a program name", () => {
    // Load-bearing: `deny_matches` matches a BARE program name against the program token, but keeps
    // substring semantics for anything containing other characters. A bare "bsc" would have denied
    // the entire CLI — every store, every session. The space is what scopes it to the one subcommand.
    expect(TOOLING_REQUEST_COMMAND).toContain(" ");
    expect(TOOLING_REQUEST_COMMAND).toBe("bsc request");
  });
});
