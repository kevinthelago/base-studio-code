import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, PLANNER_WRITE_GLOBS, DOC_GLOBS, DB_OWNED_PLAN_FILES, DEP_MANIFEST_FILES, roleDeniedCommands, sessionScopes } from "./sessionRoles";
import { mergeRoleDefaults, roleCapability, type RoleCapability } from "./roleModel";

// Security guard for the externalized role→capability table (@data/permissions/role-capabilities.json,
// #2027 P1). The role gate is least-privilege; a JSON edit that WIDENS a role's access (e.g. gives a
// reviewer git:write, or hands a non-planner default write globs) must trip a test here, not ship.
describe("role capability table (loaded from @data/permissions/role-capabilities.json)", () => {
  it("has exactly the 15 roles with their intended github/git/code/net/ui tiers", () => {
    const tiers = Object.fromEntries(
      Object.values(ROLE_DEFAULTS).map((c) => [c.role, `${c.github}/${c.git}/${c.code}/${c.net}/${c.ui}`]),
    );
    // ui: "read" across the board (#2470) — every existing role may USE the component kit but never
    // redefine it; `write` is reserved for the designer session (#2471).
    expect(tiers).toEqual({
      planner:    "read/read/write/read/read",
      worker:     "read/write/write/read/read",
      director:   "write/write/none/read/read",
      triage:     "write/none/none/read/read",
      tester:     "read/read/none/read/read",
      reviewer:   "read/read/none/read/read",
      issuer:     "write/read/none/read/read",
      juror:      "read/read/none/read/read",
      // Documentor (#1555): read-only on git/GitHub, code:none — writes come solely from its
      // DOC_GLOBS carve-out (asserted below), never a code tier.
      documentor: "read/read/none/read/read",
      // Designer (#2471): the Design Studio's UI-kit session — `none` on every OTHER axis; the kit
      // store is its one write grant (`ui: write`, #2470), and its whole command surface is
      // `bsc ui`, granted at launch via the restricted allow-list.
      designer:   "none/none/none/none/write",
      // Architect (#2755): the Teams Studio's team-authoring session — `none` on EVERY axis, `ui`
      // included (unlike the designer it is not a UI-kit session). Its whole command surface is
      // `bsc teams` + `bsc persona`, granted at launch via the restricted allow-list.
      architect:  "none/none/none/none/none",
      // Librarian (#2787): the Algorithms tab's knowledge-store session — `none` on github/git/code/net.
      // Its write surface is `bsc graph`, granted at launch via the restricted allow-list. THE ONE
      // DEVIATION IS `ui: "read"` (#4090), and it is deliberate: it must be able to ask "is this harvest
      // candidate already a component?" so the algorithms and component graphs partition the tree instead
      // of both claiming it. `read` denies every mutating verb — the designer still owns that store — so
      // an edit that widens this to `write` must fail this test.
      librarian:  "none/none/none/none/read",
      // Sound-designer (#3369, epic #3071 phase 4): the Sounds tab's sound-kit authoring session —
      // `none` on EVERY axis, `ui` included: a sound is a synthesis descriptor in its own store, not a
      // UI kit. Its whole command surface is `bsc sound`, granted at launch via the restricted
      // allow-list. Identical posture to the architect/librarian.
      "sound-designer": "none/none/none/none/none",
      // Integrator (#4023): the Integration Studio's session — `none` on github/git/code/ui like its
      // studio siblings, with `bsc data connector` as its whole command surface via the restricted
      // allow-list. THE ONE DEVIATION IS `net: "read"`, and it is deliberate: this role's work starts at
      // the vendor's documentation, so it is the only studio allowed the web tools. Any edit that widens
      // another axis here — or that quietly drops net back to none — must fail this test.
      integrator: "none/none/none/read/none",
      // Marketer (#2431): read-only on git/GitHub, code:none — writes come solely from its
      // marketing-content carve-out (asserted below), never a code tier.
      marketer:   "read/read/none/read/read",
      // Curator (#3092, epic #3087): the reusable-library post-landing actor — `none` on GitHub/net,
      // `code: none` (never edits project files), `git: read` (reads the landed repo it harvests from),
      // and `ui: write` (the ONE write grant — the component/kit store; `bsc graph` for algorithms comes
      // via the restricted allow-list at launch). No writeGlobs — its writes go to the stores, not files.
      curator:    "none/read/none/none/write",
      // Debugger (#3322): the app's own full-cap maintenance session — write on git/GitHub/code + ui.
      debugger:   "write/write/write/read/write",
    });
  });

  it("only the planner + documentor + marketer ship default write globs; every other role starts empty (no code writes)", () => {
    expect(PLANNER_WRITE_GLOBS).toBe(ROLE_DEFAULTS.planner.writeGlobs); // same array — derived, not duplicated
    expect(PLANNER_WRITE_GLOBS).toEqual(["*.md", "*.json", "prompts/*.md", "prompts/*", "discovery/*.md", "discovery/*"]);
    // The documentor ships DOC_GLOBS by default (its prose-doc carve-out, #1555) — strictly markdown/docs.
    expect(DOC_GLOBS).toBe(ROLE_DEFAULTS.documentor.writeGlobs); // same array — derived, not duplicated
    // No `docs/**`: that would grant code files under docs/ (e.g. docs/gen.ts) — the boundary is
    // markdown/prose only (#2326). `**/*.md` already covers every markdown file, incl. docs/*.md.
    expect(DOC_GLOBS).toEqual(["*.md", "**/*.md", "README*", "**/README*", "CHANGELOG*"]);
    // The marketer ships a marketing-content carve-out (#2431) — markdown/mdx under marketing/·content/
    // plus README/CHANGELOG. STRICTLY markdown/mdx (no open dirs, so no code extension can slip in),
    // so `code: "none"` stays honest.
    expect(ROLE_DEFAULTS.marketer.writeGlobs).toEqual([
      "marketing/**/*.md", "marketing/**/*.mdx", "content/**/*.md", "content/**/*.mdx",
      "README*", "**/README*", "CHANGELOG*", "**/CHANGELOG*",
    ]);
    expect(ROLE_DEFAULTS.marketer.writeGlobs.every((g) => /\.(md|mdx)$|README|CHANGELOG/.test(g))).toBe(true);
    // The four RESTRICTED studio roles ship a `scratch/**` carve-out (#3373) — NOT project content: a
    // sealed staging dir inside their own workspace, the only way they can author at all now that a
    // heredoc cannot be allow-listed. Pinned exactly, so a widening past the staging dir fails here.
    for (const role of ["designer", "architect", "librarian", "sound-designer", "integrator"] as const) {
      expect(ROLE_DEFAULTS[role].writeGlobs).toEqual(["scratch/**"]);
    }
    const CARVED = ["planner", "documentor", "marketer", "designer", "architect", "librarian", "sound-designer", "integrator"];
    for (const c of Object.values(ROLE_DEFAULTS)) {
      if (!CARVED.includes(c.role)) expect(c.writeGlobs).toEqual([]);
    }
  });

  it("carries the db-owned + dep-manifest deny lists", () => {
    expect(DB_OWNED_PLAN_FILES).toEqual(["deploy.md", "deploy.json", "phases.json", "issues.json", "fleet.json", "repos.json", "features.json"]);
    expect(DEP_MANIFEST_FILES).toEqual(["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "pnpm-lock.yaml", "yarn.lock"]);
  });

  // Regression for #2325: `overlayFile` (#2047) FULLY REPLACES role-capabilities.json with a config-dir
  // copy. A STALE override seeded before the shipped default gained a role (documentor, #1555) would drop
  // it, and reading that role at module load (`DOC_GLOBS = ROLE_DEFAULTS.documentor.writeGlobs`) threw
  // `TypeError reading writeGlobs`, crashing the whole UI. `mergeRoleDefaults` floors on the embedded set.
  it("floor-merges a stale override onto the embedded roles so a newly-shipped role never vanishes (#2325)", () => {
    const cap = (role: string, writeGlobs: string[] = []): RoleCapability =>
      ({ role, github: "read", git: "read", code: "none", net: "read", writeGlobs }) as RoleCapability;
    const embedded = { planner: cap("planner", ["*.md"]), documentor: cap("documentor", ["docs/**"]) };
    const staleOverride = { planner: cap("planner", ["*.md"]) }; // seeded before documentor existed — no documentor key

    const merged = mergeRoleDefaults(embedded, staleOverride);

    // The role the stale override lacked survives from the embedded floor (not undefined → no crash).
    expect(merged.documentor).toBeDefined();
    expect(merged.documentor.writeGlobs).toEqual(["docs/**"]);
    // And an override that DOES carry a role still customizes it (overlay wins on top of the floor).
    const customized = mergeRoleDefaults(embedded, { planner: cap("planner", ["custom/**"]) });
    expect(customized.planner.writeGlobs).toEqual(["custom/**"]);
  });

  // Regression for #2470 (the per-FIELD companion to #2325): `mergeRoleDefaults` floors missing
  // ROLES, but an overlaid role OBJECT fully replaces the embedded one — so a stale config-dir
  // override written BEFORE the `ui` axis shipped yields a merged entry with `ui: undefined`.
  // Nothing may crash, and the gate must fail CLOSED (behave as `read`), never as a write grant.
  it("a stale override missing the ui field defaults to read everywhere it's consumed (#2470)", () => {
    // The pre-#2470 capability shape: role present, no `ui` field (what a stale override yields).
    const stale = {
      role: "worker", github: "read", git: "write", code: "write", net: "read", writeGlobs: [] as string[],
    } as RoleCapability;
    expect(stale.ui).toBeUndefined(); // the hazard under test

    // First, prove the merge really produces that shape (an overlaid role object replaces wholesale).
    const embedded = { worker: { ...stale, ui: "read" as const } };
    expect(mergeRoleDefaults(embedded, { worker: stale }).worker.ui).toBeUndefined();

    // The accessor prepends the field floor, so a capability built through it always carries a tier.
    expect(roleCapability("worker").ui).toBe("read");
    // The hard gate fails closed on the missing tier: mutating verbs stay denied…
    const denies = roleDeniedCommands(stale);
    expect(denies).toContain("bsc ui set");
    expect(denies).toContain("bsc component kit remove");
    expect(denies).not.toContain("bsc ui"); // …but not the whole tool (that's the `none` tier).
    // And the runtime scope doc renders the same read floor.
    expect(sessionScopes(stale)).toEqual({ ui: "read" });
  });
});
