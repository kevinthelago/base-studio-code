// #funnel-planner-takes-team-and-context — the three-tier funnel's capability shape.
//
// The funnel is architect → director → workers, and the property that makes it safe to run unattended
// is MONOTONIC capability: the closer a tier sits to the human, the less it can do; the closer to the
// code, the more. The architect ingests raw user prose, so it is the highest prompt-injection surface
// in the system and is deliberately the LEAST capable session anywhere. A worker is the most capable,
// and it is also the one confined to a single worktree on a single branch.
//
// This is asserted as an ORDER rather than as three separate row snapshots, because the invariant is
// the relationship: any future change that widens the architect past the director, or the director past
// a worker, is the regression — regardless of what the individual rows happen to say.
import { describe, it, expect } from "vitest";
import { ROLE_DEFAULTS, roleDeniedCommands, canWritePath } from "@/shared/lib/session/sessionRoles";
import { restrictedRoleCommands, type RoleCapability } from "@/shared/lib/session/roleModel";

/** The funnel, ordered least-capable first. `planner` is deliberately NOT here: it still exists as a
 *  role and its Glance node stands, but its RESPONSIBILITIES moved to the director, so it is not one of
 *  the three tiers this invariant is about. */
const TIERS = ["architect", "director", "worker"] as const;

/** Rank a capability tier so the axes can be compared as an order. */
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const rank = (v: string | undefined): number => RANK[v ?? "none"] ?? 0;

const cap = (role: (typeof TIERS)[number]): RoleCapability => ROLE_DEFAULTS[role];

describe("the three-tier funnel is monotonic — architect < director < worker", () => {
  it("never widens a git/github/code/net axis as you move UP the funnel toward the human", () => {
    // Walk the tiers in order and assert each axis is non-decreasing from architect to worker.
    for (const axis of ["git", "github", "code", "net"] as const) {
      const ranks = TIERS.map((t) => rank(cap(t)[axis] as string));
      for (let i = 1; i < ranks.length; i++) {
        expect(
          ranks[i],
          `${axis}: ${TIERS[i]} (${cap(TIERS[i])[axis]}) must not be NARROWER than ${TIERS[i - 1]} (${cap(TIERS[i - 1])[axis]})`,
        ).toBeGreaterThanOrEqual(ranks[i - 1]);
      }
    }
  });

  it("keeps the architect strictly the least capable — none on every axis", () => {
    // Not merely "≤ the director": being the least capable session in the system is the deliberate
    // property, because this is the tier that reads raw user prose.
    const a = cap("architect");
    for (const axis of ["git", "github", "code", "net", "ui"] as const) {
      expect(a[axis], `architect.${axis}`).toBe("none");
    }
  });

  it("gives ONLY the worker a git write — the two tiers above it cannot mutate history", () => {
    expect(cap("worker").git).toBe("write");
    for (const t of ["architect", "director"] as const) {
      expect(cap(t).git, `${t} must not hold git write`).not.toBe("write");
      // The two tiers deny at DIFFERENT granularities and both are correct: the architect is
      // `git: "none"`, so the whole binary is denied, while the director is `git: "read"` and denies
      // the mutating verbs individually. Asserting `git push` literally would have failed the stricter
      // of the two — so the check is "is a push reachable", not "is this exact string listed".
      const denies = roleDeniedCommands(cap(t));
      const blocked = (verb: string) => denies.includes("git") || denies.includes(`git ${verb}`);
      for (const verb of ["push", "merge"]) {
        expect(blocked(verb), `${t} must not be able to git ${verb}`).toBe(true);
      }
    }
  });

  it("lets NO tier mutate GitHub — local-first means there is nothing up there to write", () => {
    for (const t of TIERS) {
      expect(rank(cap(t).github as string), `${t}.github`).toBeLessThan(RANK.write);
    }
  });

  it("separates the two WRITE surfaces by path, not just by tier", () => {
    // Both the director and a worker are `code: write`, so the order alone does not distinguish them —
    // what does is WHERE. The director writes plan/context prose at the hub; the worker writes code in
    // its own lane. Neither can reach the other's.
    const dir = cap("director"), worker = cap("worker");
    expect(dir.code).toBe("write");
    expect(worker.code).toBe("write");
    // The director cannot touch project source, whatever its writeGlobs say about markdown.
    for (const p of ["src/App.tsx", "crates/kb/src/lib.rs", "web/src/auth/login.ts"]) {
      expect(canWritePath(dir, p), `director must not write ${p}`).toBe(false);
    }
    // …and it CAN write the context files it is now responsible for authoring.
    for (const p of ["prompts/api-kickoff.md", "goal.md"]) {
      expect(canWritePath(dir, p), `director must be able to author ${p}`).toBe(true);
    }
  });
});

describe("the director's team-design surface (#funnel-planner-takes-team-and-context)", () => {
  it("can reach bsc teams, because it is NOT a restricted-allow role", () => {
    // There is no per-role allow-list to add to here: `bsc` sits in the always-allowed mandatory tier
    // (permissions/base.json), and a role only gets a narrowed surface if it appears in the restricted
    // table. The director does not — so team authoring is reachable by construction. This pins that
    // fact, because "add it to the allow-list" would be a no-op that reads like a change.
    expect(restrictedRoleCommands("director")).toEqual([]);
  });

  it("designs the TEAM but no longer authors the PERSONAS in it", () => {
    // NARROWED by the maintainer (2026-08-19, epic `the-persona-is-the-whole-agent`): "we should
    // restrict role creation and modification to the architect. this will be the role responsible of
    // configuring them before the director is requested to design their team and the capability."
    //
    // So the two halves split. The ARCHITECT configures the personas and their capability; the
    // DIRECTOR then composes a team out of the personas that already exist. That is coherent because a
    // team PLACES personas into positions — it does not need to mint them — and it is why the director
    // keeps `bsc teams` untouched while losing the three persona write verbs.
    const denies = roleDeniedCommands(cap("director"));
    for (const c of denies) {
      expect(c.startsWith("bsc teams"), `role gate must not deny ${c}`).toBe(false);
    }
    expect(denies).toContain("bsc persona set");
    expect(denies).toContain("bsc persona remove");
    expect(denies).toContain("bsc persona rename");
    // READS stay open — a director must still be able to see what its team is made of.
    expect(denies).not.toContain("bsc persona");
    expect(denies.some((c) => c.startsWith("bsc persona get") || c.startsWith("bsc persona list"))).toBe(false);
  });

  it("keeps the ARCHITECT's team surface narrow — the persona half is now PERMANENT, not transitional", () => {
    // `bsc persona` on this surface used to be labelled transitional, "until team design moves to the
    // director". Team design DID move; persona authoring deliberately did not, and is now the
    // architect's standing job (see the director case above). `bsc teams` remains so the architect can
    // READ the team its personas are composed into. The surface is still a fixed restricted list, so
    // it cannot grow into the director's job by accident.
    const surface = restrictedRoleCommands("architect");
    expect(surface).toContain("bsc teams");
    expect(surface).toContain("bsc persona");
    // …and it still cannot reach the plan beyond its own two handoff nouns.
    expect(surface).not.toContain("bsc plan");
  });
});

describe("the architect's view of its tier (#architect-sees-director-state, revised)", () => {
  // SUPERSEDED IN PART by #architect-creates-a-director-with-discovery. This item framed the grant as
  // READ-ONLY ("seeing is not reaching"), and that half is gone: the architect DOES create directors.
  // What survives — and is what these tests now pin — is that the READ still resolves, and that the
  // grant still stops short of `bsc fleet wake`.
  it("can still read director state — the read got MORE useful, not less", () => {
    // An architect that can create a director needs to see which already run before creating another.
    // The grant is now the singular verb, and `directors` resolves through its prefix.
    const surface = restrictedRoleCommands("architect");
    expect(surface).toContain("bsc fleet director");
    expect(surface.some((c) => "bsc fleet directors".startsWith(c))).toBe(true);
  });

  it("is granted the FULL verb, never the `bsc fleet` prefix — that would carry `wake`", () => {
    // Grants are prefix matches expanded to `Bash(<cmd> *)`. `"bsc fleet"` would auto-run
    // `bsc fleet wake` too — the DIRECTOR's lever over a stopped worker, one tier below where this
    // session belongs. Creating a director is additive and allowed; reaching into its fleet is not.
    const surface = restrictedRoleCommands("architect");
    expect(surface).not.toContain("bsc fleet");
    expect(surface.filter((c) => c.startsWith("bsc fleet"))).toEqual(["bsc fleet director"]);
    expect("bsc fleet wake".startsWith("bsc fleet director")).toBe(false);
  });

  it("still cannot reach WORKERS — the tier boundary is one level, not two", () => {
    // `bsc fleet list` is the DIRECTOR's view of its workers. An architect holding it would be reading
    // past the tier it hands work to, into a fleet it does not run.
    expect(restrictedRoleCommands("architect")).not.toContain("bsc fleet list");
  });

  it("gains no WRITE from seeing — the read gate does not lift its role floor", () => {
    const a = cap("architect");
    for (const axis of ["git", "github", "code", "net", "ui"] as const) {
      expect(a[axis], `architect.${axis}`).toBe("none");
    }
  });
});
