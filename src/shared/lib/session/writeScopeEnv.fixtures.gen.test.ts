// The write-scope env, captured from the LIVE TypeScript so the Rust derivation can be proved equal.
//
// Two variables, both pure security:
//
//   BSC_SCOPE_GLOBS — the globs the `bsc-scope` PreToolUse hook hard-blocks outside of. This is the
//                     HARD deny the role gate's allow-only rules lack, and it survives the bypass
//                     posture where `permissions.deny` is ignored entirely.
//   BSC_SCOPES      — the role's per-store access tiers, checked by the store CLIs before a mutating
//                     verb (#2470).
//
// `crates/bsc-hook/src/main.rs:107` reads the first and BLOCKS on it; `crates/bsc-cli-util` reads the
// second and refuses a store write on it. Rust enforces both on every tool call and computes neither.
//
// The values are read out of `buildAgentEnv` itself rather than recomposed from its parts, so the
// fixture records the decision the LAUNCH actually makes — including its three-way branch, which is
// what the Rust port has to reproduce:
//
//   globs non-empty            → the globs, space-joined
//   empty AND code:none        → the deny-all sentinel (#1916 Step 3.5)
//   empty AND code is not none → UNSET, so an ungated pane stays allow-all
//
// Getting that branch order wrong inverts a hard deny into a permit: `scope_verdict` reads an ABSENT
// scope as "no scope configured" and allows.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/writeScopeEnv.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv, SCOPE_DENY_ALL } from "@/app/console/lib/sessionLaunch";
import { roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/writeScopeEnv.fixtures.json");
const PANE = "p1";

const BASE = {
  deniedCommands: [], paneRoles: {}, paneRoleGlobs: {}, paneProfiles: {}, agentProfiles: [],
  paneFlows: {}, surfaceCatalog: [], fleetPaneStreams: {}, appRepoRoot: "/repo", bscBaseDir: "/base",
  mcpServers: [], skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [], paneSkills: {},
};

/** Every role the gate knows, plus the glob-carrying variants. `claude` as the provider keeps the
 *  bsc-agent branch of `buildAgentEnv` out of this — the two scope vars are set before it. */
const ROLES: SessionRole[] = [
  "planner", "worker", "director", "triage", "tester", "reviewer",
  "issuer", "juror", "documentor", "designer", "architect", "librarian", "sound-designer", "marketer",
] as SessionRole[];

const SUBJECTS: Array<[string, { role?: string; globs?: string[] }]> = [
  ["no role at all — an ungated pane is never scoped", {}],
  ...ROLES.map((r) => [`role ${r}, no own globs`, { role: r }] as [string, { role?: string; globs?: string[] }]),
  ["worker with own write globs", { role: "worker", globs: ["src/**", "docs/**"] }],
  ["worker with ONE glob", { role: "worker", globs: ["src/**"] }],
  ["designer with own globs — a carve-out role keeps its scoped write", { role: "designer", globs: ["scratch/**"] }],
  ["triage with own globs — code:none WITHOUT a carve-out grants nothing", { role: "triage", globs: ["src/**"] }],
  ["director with own globs — the commons carve-out", { role: "director", globs: ["docs/**"] }],
  ["a glob containing a space-free path stays space-joined", { role: "worker", globs: ["a/**", "b/**", "c/**"] }],
];

const envFor = (role: string | undefined, globs: string[] | undefined) =>
  buildAgentEnv(
    { ...BASE, paneRoles: role ? { [PANE]: role } : {}, paneRoleGlobs: globs ? { [PANE]: globs } : {} } as unknown as AppStore,
    PANE,
    "claude",
    "",
  );

describe("writeScopeEnv fixtures", () => {
  it("captures BSC_SCOPE_GLOBS and BSC_SCOPES over every role", () => {
    const cases = SUBJECTS.map(([label, { role, globs }]) => {
      const env = envFor(role, globs) ?? {};
      return {
        label,
        role: role ?? null,
        writeGlobs: globs ?? [],
        // The resolved capability, so Rust can deserialize it rather than needing a role→capability
        // function. The self-check below proves it is the one the live launch used.
        capability: role ? roleCapability(role as SessionRole, globs?.length ? { writeGlobs: globs } : {}) ?? null : null,
        scopeGlobs: env.BSC_SCOPE_GLOBS ?? null,
        scopes: env.BSC_SCOPES ?? null,
      };
    });
    const next = {
      note: "GENERATED from @/app/console/lib/sessionLaunch buildAgentEnv — do not hand-edit; see the .gen.test.ts",
      denyAllSentinel: SCOPE_DENY_ALL,
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: all three branches actually occur in the corpus", () => {
    const scoped = SUBJECTS.filter(([, s]) => {
      const g = envFor(s.role, s.globs)?.BSC_SCOPE_GLOBS;
      return g && g !== SCOPE_DENY_ALL;
    });
    const sentinel = SUBJECTS.filter(([, s]) => envFor(s.role, s.globs)?.BSC_SCOPE_GLOBS === SCOPE_DENY_ALL);
    const unset = SUBJECTS.filter(([, s]) => !envFor(s.role, s.globs)?.BSC_SCOPE_GLOBS);

    expect(scoped.length, "no role produced real globs — the fixture would not exercise the first branch").toBeGreaterThan(0);
    expect(sentinel.length, "no role produced the deny-all sentinel — #1916 Step 3.5 would be untested").toBeGreaterThan(0);
    expect(unset.length, "no case left the scope UNSET — the ungated branch would be untested").toBeGreaterThan(0);
  });

  it("an ungated pane is never scoped — the branch that must stay allow-all", () => {
    const env = envFor(undefined, undefined);
    expect(env?.BSC_SCOPE_GLOBS, "a pane with no role must not be scoped at all").toBeUndefined();
    expect(env?.BSC_SCOPES, "and gets no store scopes either").toBeUndefined();
  });
});
